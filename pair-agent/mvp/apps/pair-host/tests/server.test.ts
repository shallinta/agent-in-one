import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { type DshBuildRef } from '@pair-agent/contracts';
import { JsonlPairLedgerStore } from '@pair-agent/ledger';
import {
  PairCoordinator,
  PairRegistry,
  type AgentAdapter,
  type AgentHandle,
  type FollowupInput,
  type PreparePairAgentInput,
  type PreparedPairAgent,
} from '@pair-agent/runtime';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createPairHostServer, type PairHostServer } from '../src/server.js';

const roots: string[] = [];

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const dshBuild: DshBuildRef = {
  upstreamRepository: 'openai/deepseek-harness',
  upstreamCommit: 'a'.repeat(40),
  sourceRepository: 'example/pair-agent',
  sourceCommit: 'b'.repeat(40),
  requestLayoutSeamVersion: 1,
};

class FakeAdapter implements AgentAdapter {
  readonly followups: FollowupInput[] = [];
  readonly released: AgentHandle[] = [];
  readonly resumeCalls: PreparePairAgentInput[] = [];
  failDelivery = false;
  onResume?: (input: PreparePairAgentInput) => Promise<void>;

  getDshRuntimeAttestation() {
    return {
      dshBuild,
      runtimeArtifacts: {
        schemaVersion: 1 as const,
        buildProfile: 'official' as const,
        roots: ['apps', 'native', 'packages', 'vendor'] as const,
        fileCount: 1,
        digest: `sha256:${'c'.repeat(64)}`,
      },
    };
  }

  async preparePairAgent(input: PreparePairAgentInput): Promise<PreparedPairAgent> {
    return {
      handle: { sessionId: input.sessionId },
      descriptor: {
        role: input.role,
        source: `${input.role}-session`,
        sessionId: input.sessionId,
      },
    };
  }

  async release(handle: AgentHandle): Promise<void> {
    this.released.push(handle);
  }

  async resumePairAgent(input: PreparePairAgentInput): Promise<PreparedPairAgent> {
    this.resumeCalls.push(input);
    await this.onResume?.(input);
    return this.preparePairAgent(input);
  }

  async followup(input: FollowupInput): Promise<void> {
    this.followups.push(input);
    if (this.failDelivery) throw new Error('adapter offline');
  }
}

async function json(
  origin: string,
  path: string,
  options: RequestInit = {},
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${origin}${path}`, options);
  return { response, body: await response.json() };
}

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered = '',
): Promise<{ data: unknown; buffered: string }> {
  const decoder = new TextDecoder();
  let content = buffered;
  for (;;) {
    const boundary = content.indexOf('\n\n');
    if (boundary >= 0) {
      const frame = content.slice(0, boundary);
      const data = frame
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6);
      if (data === undefined) throw new Error(`SSE frame lacks data: ${frame}`);
      return {
        data: JSON.parse(data),
        buffered: content.slice(boundary + 2),
      };
    }
    const next = await reader.read();
    if (next.done) throw new Error('SSE ended before a complete event');
    content += decoder.decode(next.value, { stream: true });
  }
}

describe('Pair Host HTTP API', () => {
  let root: string;
  let store: JsonlPairLedgerStore;
  let adapter: FakeAdapter;
  let registry: PairRegistry;
  let coordinator: PairCoordinator;
  let host: PairHostServer;
  let origin: string;

  async function initializeRuntime(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), 'pair-host-'));
    roots.push(root);
    store = new JsonlPairLedgerStore(root);
    adapter = new FakeAdapter();
    registry = new PairRegistry(store, adapter);
    coordinator = new PairCoordinator(registry, store, adapter);
  }

  beforeEach(async () => {
    await initializeRuntime();
    host = createPairHostServer({
      registry,
      coordinator,
      dshBuild,
      host: '127.0.0.1',
      port: 0,
    });
    ({ origin } = await host.listen());
  });

  afterEach(async () => {
    await host.close();
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true })));
  });

  test('creates and gets a Pair with stable DTOs', async () => {
    const created = await json(origin, '/api/pairs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairId: 'http-pair' }),
    });
    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({
      header: {
        pairId: 'http-pair',
        navigatorSessionId: 'pair:http-pair:navigator',
        pilotSessionId: 'pair:http-pair:pilot',
        ledgerHead: 2,
        dshBuild,
      },
      panes: [
        { role: 'navigator', sessionId: 'pair:http-pair:navigator' },
        { role: 'pilot', sessionId: 'pair:http-pair:pilot' },
      ],
    });

    const loaded = await json(origin, '/api/pairs/http-pair');
    expect(loaded.response.status).toBe(200);
    expect(loaded.body).toMatchObject({
      projection: { header: { pairId: 'http-pair', ledgerHead: 2 } },
      panes: [{ role: 'navigator' }, { role: 'pilot' }],
    });
  });

  test('single-flights cold recovery shared by concurrent GET and SSE requests', async () => {
    await coordinator.createPair({
      pairId: 'http-single-flight',
      dshBuild,
      expectedLedgerHead: 0,
    });
    await host.close();

    const resumeEntered = deferred<void>();
    const releaseResume = deferred<void>();
    let entered = 0;
    adapter = new FakeAdapter();
    adapter.onResume = async () => {
      entered += 1;
      if (entered === 2) resumeEntered.resolve();
      await releaseResume.promise;
    };
    store = new JsonlPairLedgerStore(root);
    registry = new PairRegistry(store, adapter);
    coordinator = new PairCoordinator(registry, store, adapter);
    host = createPairHostServer({
      registry,
      coordinator,
      dshBuild,
      host: '127.0.0.1',
      port: 0,
    });
    ({ origin } = await host.listen());

    const controller = new AbortController();
    const getRequest = fetch(`${origin}/api/pairs/http-single-flight`);
    const eventRequest = fetch(
      `${origin}/api/pairs/http-single-flight/events`,
      { signal: controller.signal },
    );
    await resumeEntered.promise;
    releaseResume.resolve();
    const [getResponse, eventResponse] = await Promise.all([
      getRequest,
      eventRequest,
    ]);
    const reader = eventResponse.body!.getReader();
    try {
      expect(getResponse.status).toBe(200);
      expect(eventResponse.status).toBe(200);
      await expect(getResponse.json()).resolves.toMatchObject({
        projection: { header: { pairId: 'http-single-flight' } },
      });
      await expect(readSseEvent(reader)).resolves.toMatchObject({
        data: { header: { pairId: 'http-single-flight' } },
      });
      expect(adapter.resumeCalls).toHaveLength(2);
      expect(adapter.resumeCalls.map(({ role }) => role).sort()).toEqual([
        'navigator',
        'pilot',
      ]);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  test.each(['navigator', 'pilot'] as const)(
    'accepts %s input and returns the durable delivery DTO',
    async (role) => {
      await coordinator.createPair({
        pairId: `message-${role}`,
        dshBuild,
        expectedLedgerHead: 0,
      });
      const delivered = await json(
        origin,
        `/api/pairs/message-${role}/messages/${role}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ text: `hello ${role}`, expectedLedgerHead: 2 }),
        },
      );

      expect(delivered.response.status).toBe(202);
      expect(delivered.body).toEqual({
        acceptedAtLedgerHead: 3,
        deliveryId: `message-${role}:3`,
        delivery: 'delivered',
      });
      expect(adapter.followups.at(-1)?.sessionId).toBe(
        `pair:message-${role}:${role}`,
      );
      expect(adapter.followups).toHaveLength(1);
      expect(adapter.followups.some(({ sessionId }) =>
        sessionId === `pair:message-${role}:${role === 'navigator' ? 'pilot' : 'navigator'}`,
      )).toBe(false);
    },
  );

  test('lists Pair Session Events with physical pagination and semantic filtering', async () => {
    await coordinator.createPair({ pairId: 'pair-demo', dshBuild, expectedLedgerHead: 0 });
    await coordinator.sendNavigator({
      pairId: 'pair-demo',
      text: 'first semantic input',
      expectedLedgerHead: 2,
    });
    await store.append(
      'pair-demo',
      {
        type: 'session_event.linked',
        actor: { kind: 'host' },
        source: 'navigator-session',
        channel: 'navigator',
        visibility: 'infrastructure',
        authority: 'host',
        refs: {},
        payload: {
          schemaVersion: 1,
          sessionId: 'pair:pair-demo:navigator',
          fromSessionSeq: 1,
          throughSessionSeq: 1,
          messageIds: ['message-1'],
          pairEventId: 'pair-demo:3',
          representation: 'full',
        },
      },
      3,
    );
    await store.append(
      'pair-demo',
      {
        type: 'pair.request_built',
        actor: { kind: 'host' },
        source: 'pair',
        channel: 'shared-control',
        visibility: 'infrastructure',
        authority: 'host',
        refs: {},
        payload: { requestId: 'request-1' },
      },
      4,
    );
    await store.append(
      'pair-demo',
      {
        type: 'delivery.completed',
        actor: { kind: 'host' },
        source: 'pair',
        channel: 'shared-control',
        visibility: 'infrastructure',
        authority: 'host',
        refs: {},
        payload: { deliveryId: 'delivery-1' },
      },
      5,
    );
    await coordinator.sendPilot({
      pairId: 'pair-demo',
      text: 'second semantic input',
      expectedLedgerHead: 6,
    });
    await coordinator.sendNavigator({
      pairId: 'pair-demo',
      text: 'third semantic input',
      expectedLedgerHead: 7,
    });

    const semantic = await json(
      origin,
      '/api/pairs/pair-demo/session-events?afterSeq=0&limit=2&view=semantic',
    );
    expect(semantic.response.status).toBe(200);
    expect(semantic.body).toEqual({
      pairId: 'pair-demo',
      throughLedgerHead: 8,
      sharedHead: 8,
      events: expect.any(Array),
      nextAfterSeq: 7,
      hasMore: true,
    });
    expect((semantic.body as { events: Array<{ seq: number; type: string }> }).events)
      .toMatchObject([
        { seq: 3, type: 'user.message' },
        { seq: 7, type: 'user.message' },
      ]);
    expect(Object.keys(semantic.body as Record<string, unknown>)).toEqual([
      'pairId',
      'throughLedgerHead',
      'sharedHead',
      'events',
      'nextAfterSeq',
      'hasMore',
    ]);

    const all = await json(
      origin,
      '/api/pairs/pair-demo/session-events?afterSeq=0&limit=20&view=all',
    );
    expect(all.response.status).toBe(200);
    const allTypes = (all.body as { events: Array<{ type: string }> }).events
      .map(({ type }) => type);
    expect(allTypes).toContain('session_event.linked');
    expect(allTypes).toContain('pair.request_built');
    expect(allTypes).toContain('delivery.completed');
    expect((semantic.body as { events: Array<{ type: string }> }).events)
      .not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'session_event.linked' }),
        expect.objectContaining({ type: 'pair.request_built' }),
        expect.objectContaining({ type: 'delivery.completed' }),
      ]));
  });

  test.each([
    '/api/pairs/pair-demo/session-events?afterSeq=-1',
    '/api/pairs/pair-demo/session-events?limit=0',
    '/api/pairs/pair-demo/session-events?view=private',
    '/api/pairs/pair-demo/session-events?afterSeq=0&afterSeq=1',
  ])('rejects invalid Session Events query %s', async (path) => {
    await coordinator.createPair({ pairId: 'pair-demo', dshBuild, expectedLedgerHead: 0 });

    const result = await json(origin, path);

    expect(result.response.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'INVALID_QUERY' } });
  });

  test('returns 404 when listing Session Events for an unknown Pair', async () => {
    const result = await json(
      origin,
      '/api/pairs/unknown-pair/session-events?afterSeq=0&limit=2&view=semantic',
    );

    expect(result.response.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'PAIR_NOT_FOUND' } });
  });

  test('accepts a Navigator task command and only wakes Pilot', async () => {
    await coordinator.createPair({ pairId: 'task-pair', dshBuild, expectedLedgerHead: 0 });
    const assigned = await json(origin, '/api/pairs/task-pair/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedLedgerHead: 2,
        task: {
          id: 'task-1',
          revision: 1,
          summary: 'Implement host',
          state: 'queued',
        },
      }),
    });

    expect(assigned.response.status).toBe(202);
    expect(assigned.body).toMatchObject({ delivery: 'delivered', deliveryId: 'task-pair:3' });
    expect(adapter.followups).toHaveLength(1);
    expect(adapter.followups[0]?.sessionId).toBe('pair:task-pair:pilot');
  });

  test.each(['navigator', 'pilot'] as const)(
    'returns accepted-pending when durable %s input cannot wake the adapter',
    async (role) => {
      await coordinator.createPair({ pairId: 'pending-pair', dshBuild, expectedLedgerHead: 0 });
      adapter.failDelivery = true;

      const pending = await json(origin, `/api/pairs/pending-pair/messages/${role}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'persist me', expectedLedgerHead: 2 }),
      });

      expect(pending.response.status).toBe(202);
      expect(pending.body).toEqual({
        acceptedAtLedgerHead: 3,
        deliveryId: 'pending-pair:3',
        delivery: 'pending',
      });
      expect((await store.read('pending-pair')).at(-1)?.payload).toEqual({
        schemaVersion: 1,
        kind: 'user-input',
        text: 'persist me',
        content: [{ type: 'text', text: 'persist me' }],
      });
      expect(adapter.followups).toHaveLength(1);
      expect(adapter.followups[0]?.sessionId).toBe(`pair:pending-pair:${role}`);
    },
  );

  test('maps duplicate and stale CAS conflicts to structured 409 errors', async () => {
    await coordinator.createPair({ pairId: 'conflict-pair', dshBuild, expectedLedgerHead: 0 });
    const duplicate = await json(origin, '/api/pairs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairId: 'conflict-pair' }),
    });
    expect(duplicate.response.status).toBe(409);
    expect(duplicate.body).toMatchObject({ error: { code: 'PAIR_DUPLICATE' } });

    const stale = await json(origin, '/api/pairs/conflict-pair/messages/pilot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'stale', expectedLedgerHead: 1 }),
    });
    expect(stale.response.status).toBe(409);
    expect(stale.body).toEqual({
      error: {
        code: 'LEDGER_CONFLICT',
        message: 'Ledger head conflict: expected 1, actual 2',
        details: { expectedLedgerHead: 1, actualLedgerHead: 2 },
      },
    });

    const accepted = await json(origin, '/api/pairs/conflict-pair/messages/navigator', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'accepted once', expectedLedgerHead: 2 }),
    });
    expect(accepted.response.status).toBe(202);
    const retry = await json(origin, '/api/pairs/conflict-pair/messages/navigator', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'must not append', expectedLedgerHead: 2 }),
    });
    expect(retry.response.status).toBe(409);
    expect(retry.body).toMatchObject({
      error: {
        code: 'LEDGER_CONFLICT',
        details: { expectedLedgerHead: 2, actualLedgerHead: 3 },
      },
    });
    expect(await store.heads('conflict-pair')).toMatchObject({ ledgerHead: 3 });
    expect(adapter.followups).toHaveLength(1);
    expect(adapter.followups[0]?.sessionId).toBe('pair:conflict-pair:navigator');
  });

  test('returns 404 for missing and unknown resources, and 405 for known wrong methods', async () => {
    const missing = await json(origin, '/api/pairs/not-here');
    expect(missing.response.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: 'PAIR_NOT_FOUND' } });

    const unknown = await json(origin, '/api/nope');
    expect(unknown.response.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const wrongMethod = await json(origin, '/api/pairs', { method: 'PUT' });
    expect(wrongMethod.response.status).toBe(405);
    expect(wrongMethod.response.headers.get('allow')).toBe('POST');
    expect(wrongMethod.body).toMatchObject({ error: { code: 'METHOD_NOT_ALLOWED' } });
  });

  test('validates content type, JSON syntax, object shape and 1 MiB body limit', async () => {
    const unsupported = await json(origin, '/api/pairs', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(unsupported.response.status).toBe(415);

    const malformed = await json(origin, '/api/pairs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.response.status).toBe(400);
    expect(malformed.body).toMatchObject({ error: { code: 'INVALID_JSON' } });

    const array = await json(origin, '/api/pairs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });
    expect(array.response.status).toBe(400);
    expect(array.body).toMatchObject({ error: { code: 'INVALID_BODY' } });

    const oversized = await json(origin, '/api/pairs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
    });
    expect(oversized.response.status).toBe(413);
    expect(oversized.body).toMatchObject({ error: { code: 'BODY_TOO_LARGE' } });
  });

  test('accepts a case-insensitive JSON media type with parameters', async () => {
    const created = await json(origin, '/api/pairs', {
      method: 'POST',
      headers: { 'content-type': ' Application/JSON ; Charset=UTF-8' },
      body: JSON.stringify({ pairId: 'mixed-case-media-type' }),
    });

    expect(created.response.status).toBe(201);
    expect(created.body).toMatchObject({
      header: { pairId: 'mixed-case-media-type', dshBuild },
    });
  });

  test('streams an initial projection and updates, then cleans up on disconnect', async () => {
    await coordinator.createPair({ pairId: 'sse-pair', dshBuild, expectedLedgerHead: 0 });
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/pairs/sse-pair/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const initial = await readSseEvent(reader);
    expect(initial.data).toMatchObject({ header: { pairId: 'sse-pair', ledgerHead: 2 } });
    expect(registry.subscriberCount('sse-pair')).toBe(1);

    await coordinator.sendNavigator({
      pairId: 'sse-pair',
      text: 'update stream',
      expectedLedgerHead: 2,
    });
    const update = await readSseEvent(reader, initial.buffered);
    expect(update.data).toMatchObject({ header: { ledgerHead: 3, sharedHead: 3 } });

    controller.abort();
    await vi.waitFor(() => expect(registry.subscriberCount('sse-pair')).toBe(0));
  });

  test('buffers updates that arrive after snapshot capture and before initial SSE write', async () => {
    await coordinator.createPair({ pairId: 'sse-race', dshBuild, expectedLedgerHead: 0 });
    const snapshotCaptured = deferred<void>();
    const releaseSnapshot = deferred<void>();
    const originalGetPair = coordinator.getPair.bind(coordinator);
    coordinator.getPair = async (pairId) => {
      const snapshot = await originalGetPair(pairId);
      snapshotCaptured.resolve();
      await releaseSnapshot.promise;
      return snapshot;
    };
    const controller = new AbortController();
    const responsePromise = fetch(`${origin}/api/pairs/sse-race/events`, {
      signal: controller.signal,
    });

    try {
      await snapshotCaptured.promise;
      expect(registry.subscriberCount('sse-race')).toBe(1);
      await coordinator.sendNavigator({
        pairId: 'sse-race',
        text: 'first buffered update',
        expectedLedgerHead: 2,
      });
      await coordinator.sendPilot({
        pairId: 'sse-race',
        text: 'latest buffered update',
        expectedLedgerHead: 3,
      });
      releaseSnapshot.resolve();

      const response = await responsePromise;
      const reader = response.body!.getReader();
      const initial = await readSseEvent(reader);
      const bufferedUpdate = await readSseEvent(reader, initial.buffered);
      expect(initial.data).toMatchObject({ header: { ledgerHead: 2 } });
      expect(bufferedUpdate.data).toMatchObject({ header: { ledgerHead: 4 } });
    } finally {
      releaseSnapshot.resolve();
      controller.abort();
      await responsePromise.catch(() => undefined);
    }
    await vi.waitFor(() => expect(registry.subscriberCount('sse-race')).toBe(0));
  });

  test('unsubscribes an early-aborted SSE request while initial snapshot is pending', async () => {
    await coordinator.createPair({ pairId: 'sse-abort', dshBuild, expectedLedgerHead: 0 });
    const snapshotCaptured = deferred<void>();
    const releaseSnapshot = deferred<void>();
    const originalGetPair = coordinator.getPair.bind(coordinator);
    coordinator.getPair = async (pairId) => {
      const snapshot = await originalGetPair(pairId);
      snapshotCaptured.resolve();
      await releaseSnapshot.promise;
      return snapshot;
    };
    const controller = new AbortController();
    const responsePromise = fetch(`${origin}/api/pairs/sse-abort/events`, {
      signal: controller.signal,
    });

    try {
      await snapshotCaptured.promise;
      expect(registry.subscriberCount('sse-abort')).toBe(1);
      controller.abort();
      await expect(responsePromise).rejects.toThrow();
      await vi.waitFor(() => expect(registry.subscriberCount('sse-abort')).toBe(0));
    } finally {
      controller.abort();
      releaseSnapshot.resolve();
      await responsePromise.catch(() => undefined);
    }
  });

  test('Host close terminates open SSE streams, unsubscribes, and releases runtime handles', async () => {
    await coordinator.createPair({ pairId: 'sse-shutdown', dshBuild, expectedLedgerHead: 0 });
    const response = await fetch(`${origin}/api/pairs/sse-shutdown/events`);
    const reader = response.body!.getReader();
    await readSseEvent(reader);
    expect(registry.subscriberCount('sse-shutdown')).toBe(1);

    const closePromise = host.close();
    const outcome = await Promise.race([
      closePromise.then(() => 'closed' as const),
      delay(250, 'timeout' as const),
    ]);

    if (outcome === 'timeout') {
      await reader.cancel();
      await closePromise;
    }
    expect(outcome).toBe('closed');
    expect(registry.subscriberCount('sse-shutdown')).toBe(0);
    expect(adapter.released).toHaveLength(2);
  });

  test('coalesces live backpressure to the latest pending projection after drain', async () => {
    await host.close();
    await initializeRuntime();
    const releaseDrain = deferred<void>();
    const writtenHeads: number[] = [];
    host = createPairHostServer({
      registry,
      coordinator,
      dshBuild,
      host: '127.0.0.1',
      port: 0,
      sse: {
        backpressureTimeoutMs: 1_000,
        write(response, frame) {
          const projection = JSON.parse(frame.slice(6)) as { header: { ledgerHead: number } };
          writtenHeads.push(projection.header.ledgerHead);
          response.write(frame);
          if (projection.header.ledgerHead === 3) {
            void releaseDrain.promise.then(() => response.emit('drain'));
            return false;
          }
          return true;
        },
      },
    });
    ({ origin } = await host.listen());
    await coordinator.createPair({ pairId: 'sse-backpressure', dshBuild, expectedLedgerHead: 0 });
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/pairs/sse-backpressure/events`, {
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await readSseEvent(reader);
    try {
      await coordinator.sendNavigator({
        pairId: 'sse-backpressure',
        text: 'head 3 blocks',
        expectedLedgerHead: 2,
      });
      await coordinator.sendPilot({
        pairId: 'sse-backpressure',
        text: 'head 4 is superseded',
        expectedLedgerHead: 3,
      });
      await coordinator.sendNavigator({
        pairId: 'sse-backpressure',
        text: 'head 5 is latest',
        expectedLedgerHead: 4,
      });
      releaseDrain.resolve();
      await vi.waitFor(() => expect(writtenHeads).toEqual([2, 3, 5]));
    } finally {
      releaseDrain.resolve();
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  test('disconnects and cleans up a stream after its backpressure timeout', async () => {
    await host.close();
    await initializeRuntime();
    let destroyCalls = 0;
    let destroyWrapped = false;
    host = createPairHostServer({
      registry,
      coordinator,
      dshBuild,
      host: '127.0.0.1',
      port: 0,
      sse: {
        backpressureTimeoutMs: 20,
        write(response, frame) {
          if (!destroyWrapped) {
            destroyWrapped = true;
            const destroy = response.destroy.bind(response);
            response.destroy = (error) => {
              destroyCalls += 1;
              return destroy(error);
            };
          }
          response.write(frame);
          return false;
        },
      },
    });
    ({ origin } = await host.listen());
    await coordinator.createPair({ pairId: 'sse-timeout', dshBuild, expectedLedgerHead: 0 });
    const response = await fetch(`${origin}/api/pairs/sse-timeout/events`);
    const reader = response.body!.getReader();
    await readSseEvent(reader);
    try {
      await vi.waitFor(() => expect(registry.subscriberCount('sse-timeout')).toBe(0));
      expect(destroyCalls).toBeGreaterThan(0);
      await expect(reader.read()).resolves.toMatchObject({ done: true });
      const outcome = await Promise.race([
        host.close().then(() => 'closed' as const),
        delay(250, 'timeout' as const),
      ]);
      expect(outcome).toBe('closed');
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });
});
