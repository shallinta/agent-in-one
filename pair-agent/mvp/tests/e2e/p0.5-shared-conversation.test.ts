import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import {
  MAX_PEER_HOPS,
  createPairSessionIds,
  type JsonObject,
  type PairEvent,
  type PairProjection,
} from '../../packages/contracts/src/index.js';
import {
  JsonlPairLedgerStore,
  encodePairIdForStorage,
} from '../../packages/ledger/src/index.js';
import {
  PairCoordinator,
  PeerMessageRouter,
  PeerMessageService,
  PairRegistry,
  launchDshPairWebRuntime,
  type CapturedProviderRequest,
  type CaptureProviderResponse,
  type DshPairAgentAdapterOptions,
  type DshPairToolDefinition,
  type DshPairWebRuntime,
} from '../../packages/runtime/src/index.js';
import { createPairHostServer } from '../../apps/pair-host/src/server.js';
import { afterEach, describe, expect, test } from 'vitest';
import { closeBestEffort } from '../../scripts/runtime-utils.js';

const roots: string[] = [];
const generatedCrashScripts: string[] = [];
const mvpRoot = resolve(import.meta.dirname, '../..');
const dshRoot = join(mvpRoot, '.runtime/deepseek-harness');
const dshLockPath = join(mvpRoot, 'dsh.lock.json');
const commonSystem = {
  version: 'pair-prompt/v1',
  content: 'Navigator governs the Pair goal and Pilot executes delegated work.',
};

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pair-p05-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all([
    ...roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ...generatedCrashScripts.splice(0).map((path) => rm(path, { force: true })),
  ]);
});

interface LivePairHarness {
  readonly dataRoot: string;
  readonly pairRoot: string;
  readonly pairId: string;
  readonly store: JsonlPairLedgerStore;
  readonly runtime: DshPairWebRuntime;
  readonly registry: PairRegistry;
  readonly coordinator: PairCoordinator;
  readonly router: PeerMessageRouter;
}

async function launchPair(
  label: string,
  pairId: string,
  responses:
    | readonly CaptureProviderResponse[]
    | Readonly<Record<string, readonly CaptureProviderResponse[]>>,
  options: {
    readonly extraTools?: readonly DshPairToolDefinition[];
    readonly lifecycleFaults?: DshPairAgentAdapterOptions['lifecycleFaults'];
  } = {},
): Promise<LivePairHarness> {
  const dataRoot = await tempRoot(label);
  const pairRoot = join(dataRoot, 'pairs');
  const store = new JsonlPairLedgerStore(pairRoot);
  const router = new PeerMessageRouter();
  let registry!: PairRegistry;
  const runtime = await launchDshPairWebRuntime({
    source: { derivedRoot: dshRoot, lockPath: dshLockPath },
    dataRoot,
    store,
    commonSystem,
    provider: 'openai-completions',
    model: 'capture-model',
    capture: Array.isArray(responses)
      ? { responses: responses as readonly CaptureProviderResponse[] }
      : {
          responsesBySession: responses as Readonly<
            Record<string, readonly CaptureProviderResponse[]>
          >,
        },
    tools: [router.toolDefinition(), ...(options.extraTools ?? [])],
    ...(options.lifecycleFaults === undefined
      ? {}
      : { lifecycleFaults: options.lifecycleFaults }),
    onLedgerAdvanced: async (advancedPairId) => {
      await registry.publish(advancedPairId);
    },
    web: { host: '127.0.0.1', port: 0 },
  });
  registry = new PairRegistry(store, runtime.adapter);
  const coordinator = new PairCoordinator(registry, store, runtime.adapter);
  router.bind(new PeerMessageService(coordinator, runtime.adapter));
  return { dataRoot, pairRoot, pairId, store, runtime, registry, coordinator, router };
}

async function createPair(harness: LivePairHarness): Promise<void> {
  const result = await harness.coordinator.createPair({
    pairId: harness.pairId,
    dshBuild: harness.runtime.adapter.getDshRuntimeAttestation().dshBuild,
    expectedLedgerHead: 0,
  });
  expect(result.status).toBe('ready');
}

function pairEventId(event: Pick<PairEvent, 'pairId' | 'seq'>): string {
  return `${event.pairId}:${String(event.seq)}`;
}

function sharedEvents(request: CapturedProviderRequest): PairEvent[] {
  const serialized = request.messages
    .flatMap((candidate) =>
      Array.isArray(candidate.content) ? candidate.content : [],
    )
    .find(
      (block) =>
        block.type === 'text' &&
        typeof block.text === 'string' &&
        block.text.startsWith('<pair-session-events '),
    )?.text;
  if (typeof serialized !== 'string') {
    throw new Error('Captured Provider request has no Shared Events message');
  }
  return serialized
    .split('\n')
    .slice(1, -2)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as PairEvent);
}

function requestContains(request: CapturedProviderRequest, text: string): boolean {
  return request.messages.some((message) =>
    message.content.some(
      (block) => typeof block.text === 'string' && block.text.includes(text),
    ),
  );
}

async function sendNativePrompt(
  runtime: DshPairWebRuntime,
  sessionId: string,
  rpcId: string,
  text: string,
): Promise<void> {
  const response = await fetch(`${runtime.origin}/api/session.prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'session.prompt',
      payload: {
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    result: { ok: true, value: { accepted: true } },
  });
}

async function assertArtifactVocabulariesSeparated(
  harness: Pick<LivePairHarness, 'pairRoot' | 'pairId' | 'runtime'>,
): Promise<void> {
  const ids = createPairSessionIds(harness.pairId);
  const pairPath = join(
    harness.pairRoot,
    encodePairIdForStorage(harness.pairId),
    'pair.jsonl',
  );
  const pairJsonl = await readFile(pairPath, 'utf8');
  const pairTypes = pairJsonl
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
  expect(pairTypes).not.toContain('user/message');
  expect(pairTypes).not.toContain('assistant/message');
  expect(pairTypes).not.toContain('turn/end');

  for (const sessionId of [ids.navigatorSessionId, ids.pilotSessionId]) {
    const dshJsonl = await readFile(
      harness.runtime.adapter.sessionArtifact(sessionId).path,
      'utf8',
    );
    expect(dshJsonl).not.toMatch(
      /"type":"(?:user\.message|agent\.message|session_event\.linked)"/,
    );
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

interface ProjectionSseClient {
  next(): Promise<PairProjection>;
  close(): Promise<void>;
}

async function openProjectionSse(url: string): Promise<ProjectionSseClient> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('Pair SSE response has no body');
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    async next() {
      for (;;) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = frame
            .split('\n')
            .find((line) => line.startsWith('data: '))
            ?.slice(6);
          if (data === undefined) throw new Error(`Pair SSE frame lacks data: ${frame}`);
          return JSON.parse(data) as PairProjection;
        }
        const next = await reader.read();
        if (next.done) throw new Error('Pair SSE ended before a complete projection');
        buffered += decoder.decode(next.value, { stream: true });
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

describe('Pair Agent P0.5 shared conversation E2E', () => {
  test('shares ordinary Navigator conversation passively and projects it once into a later Pilot request', async () => {
    const pairId = 'pair-p05-passive';
    const ids = createPairSessionIds(pairId);
    const navigatorInput = 'Explain the shared-conversation boundary.';
    const navigatorAnswer = 'Navigator published one durable public answer.';
    const pilotInput = 'Inspect the already-shared conversation.';
    const pilotAnswer = 'Pilot retained its local history and used shared context.';
    const harness = await launchPair(
      'passive',
      pairId,
      [navigatorAnswer, pilotAnswer],
    );
    const pairHost = createPairHostServer({
      registry: harness.registry,
      coordinator: harness.coordinator,
      dshBuild: harness.runtime.adapter.getDshRuntimeAttestation().dshBuild,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      const address = await pairHost.listen();
      const createResponse = await fetch(`${address.origin}/api/pairs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairId }),
      });
      expect(createResponse.status).toBe(201);
      const created = await readJson(createResponse);
      const createdHeader = created.header as { ledgerHead: number };

      const navigatorResponse = await fetch(
        `${address.origin}/api/pairs/${pairId}/messages/navigator`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: navigatorInput,
            expectedLedgerHead: createdHeader.ledgerHead,
          }),
        },
      );
      expect(navigatorResponse.status).toBe(202);
      await harness.runtime.adapter.whenIdle(ids.navigatorSessionId);

      const afterNavigator = await harness.store.read(pairId);
      const navigatorUser = afterNavigator.filter(
        (event) =>
          event.type === 'user.message' &&
          event.source === 'pair' &&
          event.channel === 'navigator' &&
          event.payload.text === navigatorInput,
      );
      const navigatorFinal = afterNavigator.filter(
        (event) =>
          event.type === 'agent.message' &&
          event.source === 'navigator-session' &&
          event.payload.text === navigatorAnswer,
      );
      expect(navigatorUser).toHaveLength(1);
      expect(navigatorFinal).toHaveLength(1);
      for (const represented of [...navigatorUser, ...navigatorFinal]) {
        expect(
          afterNavigator.filter(
            (event) =>
              event.type === 'session_event.linked' &&
              event.payload.pairEventId === pairEventId(represented),
          ),
        ).toHaveLength(1);
      }
      expect(
        harness.runtime.adapter
          .sessionEvents(ids.pilotSessionId)
          .filter((event) => event.type === 'turn/start'),
      ).toHaveLength(0);
      expect(
        harness.runtime.adapter.captureRequests().filter(
          (request) => request.sessionId === ids.pilotSessionId,
        ),
      ).toHaveLength(0);

      const scannedSessions: string[] = [];
      const persistence = harness.runtime.context.sessionPersistence as unknown as {
        readFrom(
          sessionId: string,
          fromSeq: number,
        ): Promise<{ meta: JsonObject; events: JsonObject[] }>;
      };
      const originalReadFrom = persistence.readFrom.bind(persistence);
      persistence.readFrom = async (sessionId, fromSeq) => {
        scannedSessions.push(sessionId);
        return originalReadFrom(sessionId, fromSeq);
      };

      const head = (await harness.store.heads(pairId)).ledgerHead;
      const pilotResponse = await fetch(
        `${address.origin}/api/pairs/${pairId}/messages/pilot`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: pilotInput, expectedLedgerHead: head }),
        },
      );
      expect(pilotResponse.status).toBe(202);
      await harness.runtime.adapter.whenIdle(ids.pilotSessionId);

      const pilotRequests = harness.runtime.adapter.captureRequests().filter(
        (request) => request.sessionId === ids.pilotSessionId,
      );
      expect(pilotRequests).toHaveLength(1);
      const pilotShared = sharedEvents(pilotRequests[0]!);
      expect(
        pilotShared.filter((event) => event.seq === navigatorUser[0]!.seq),
      ).toHaveLength(1);
      expect(
        pilotShared.filter((event) => event.seq === navigatorFinal[0]!.seq),
      ).toHaveLength(1);
      expect(requestContains(pilotRequests[0]!, navigatorInput)).toBe(true);
      expect(requestContains(pilotRequests[0]!, navigatorAnswer)).toBe(true);
      expect(requestContains(pilotRequests[0]!, pilotInput)).toBe(true);
      expect(requestContains(pilotRequests[0]!, '<pair-local-bootstrap role="pilot">'))
        .toBe(true);
      expect(scannedSessions).not.toContain(ids.navigatorSessionId);

      const allResponse = await fetch(
        `${address.origin}/api/pairs/${pairId}/session-events?afterSeq=0&limit=500&view=all`,
      );
      const semanticResponse = await fetch(
        `${address.origin}/api/pairs/${pairId}/session-events?afterSeq=0&limit=500&view=semantic`,
      );
      expect(allResponse.status).toBe(200);
      expect(semanticResponse.status).toBe(200);
      const all = await readJson(allResponse) as { events: PairEvent[] };
      const semantic = await readJson(semanticResponse) as { events: PairEvent[] };
      expect(all.events.some((event) => event.type === 'session_event.linked')).toBe(true);
      expect(all.events.some((event) => event.type === 'pair.request_built')).toBe(true);
      expect(semantic.events.some((event) => event.visibility === 'infrastructure')).toBe(false);
      expect(semantic.events.some((event) => event.payload.text === navigatorAnswer)).toBe(true);

      await assertArtifactVocabulariesSeparated(harness);
    } finally {
      await closeBestEffort('P0.5 passive-sharing cleanup', [
        async () => pairHost.close(),
        async () => harness.runtime.close(),
      ]);
    }
  }, 90_000);

  test('bridges a native-composer user message before turn/end and publishes the final answer only after turn/end', async () => {
    const pairId = 'pair-p05-native';
    const ids = createPairSessionIds(pairId);
    const nativeInput = 'Native composer input must become shared.';
    const finalAnswer = 'Native composer answer became durable at turn end.';
    let announceBarrier!: () => void;
    let releaseBarrier!: () => void;
    const barrierStarted = new Promise<void>((resolveStarted) => {
      announceBarrier = resolveStarted;
    });
    const barrierGate = new Promise<void>((resolveGate) => {
      releaseBarrier = resolveGate;
    });
    const barrierTool: DshPairToolDefinition = {
      name: 'p05_hold_turn',
      description: 'Hold one capture-provider Turn for deterministic E2E observation.',
      parameters: { label: { type: 'string' } },
      async execute() {
        announceBarrier();
        await barrierGate;
        return [{ type: 'text', text: 'barrier released' }];
      },
    };
    const harness = await launchPair(
      'native',
      pairId,
      [
        {
          toolCall: {
            id: 'call-p05-hold',
            name: barrierTool.name,
            arguments: { label: 'native-composer' },
          },
        },
        finalAnswer,
      ],
      { extraTools: [barrierTool] },
    );
    try {
      await createPair(harness);
      await sendNativePrompt(
        harness.runtime,
        ids.navigatorSessionId,
        'p05-native-user-message',
        nativeInput,
      );
      const captureDeadline = Date.now() + 5_000;
      while (
        harness.runtime.adapter.captureRequests().length === 0 &&
        Date.now() < captureDeadline
      ) {
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
      }
      expect(
        harness.runtime.adapter.captureRequests(),
        JSON.stringify(harness.runtime.adapter.sessionEvents(ids.navigatorSessionId)),
      ).toHaveLength(1);
      expect(
        requestContains(
          harness.runtime.adapter.captureRequests()[0]!,
          '<pair-local-bootstrap role="navigator">',
        ),
      ).toBe(true);
      let barrierTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          barrierStarted,
          new Promise<never>((_, reject) => {
            barrierTimeout = setTimeout(
              () => reject(new Error(
                `native barrier tool did not start: ${JSON.stringify(
                  harness.runtime.adapter.sessionEvents(ids.navigatorSessionId),
                )}`,
              )),
              10_000,
            );
          }),
        ]);
      } finally {
        if (barrierTimeout !== undefined) clearTimeout(barrierTimeout);
      }

      await expect.poll(
        async () =>
          (await harness.store.read(pairId)).filter(
            (event) =>
              event.type === 'user.message' &&
              event.source === 'navigator-session' &&
              event.payload.text === nativeInput,
          ).length,
        { timeout: 30_000 },
      ).toBe(1);
      const whileHeld = await harness.store.read(pairId);
      const nativeUser = whileHeld.find(
        (event) =>
          event.type === 'user.message' &&
          event.source === 'navigator-session' &&
          event.payload.text === nativeInput,
      )!;
      expect(
        whileHeld.filter(
          (event) =>
            event.type === 'session_event.linked' &&
            event.payload.pairEventId === pairEventId(nativeUser),
        ),
      ).toHaveLength(1);
      expect(whileHeld.some((event) => event.payload.text === finalAnswer)).toBe(false);
      expect(
        harness.runtime.adapter
          .sessionEvents(ids.navigatorSessionId)
          .some((event) => event.type === 'turn/end'),
      ).toBe(false);
      expect(
        harness.runtime.adapter
          .sessionEvents(ids.pilotSessionId)
          .filter((event) => event.type === 'turn/start'),
      ).toHaveLength(0);

      releaseBarrier();
      await harness.runtime.adapter.whenIdle(ids.navigatorSessionId);
      const completed = await harness.store.read(pairId);
      const finalEvents = completed.filter(
        (event) =>
          event.type === 'agent.message' &&
          event.source === 'navigator-session' &&
          event.payload.kind === 'turn-output' &&
          event.payload.completion === 'complete' &&
          event.payload.text === finalAnswer,
      );
      expect(finalEvents).toHaveLength(1);
      expect(
        completed.filter(
          (event) =>
            event.type === 'session_event.linked' &&
            event.payload.pairEventId === pairEventId(finalEvents[0]!),
        ),
      ).toHaveLength(1);
      expect(
        harness.runtime.adapter
          .sessionEvents(ids.navigatorSessionId)
          .some((event) => event.type === 'turn/end'),
      ).toBe(true);
      expect(
        harness.runtime.adapter.captureRequests().filter(
          (request) => request.sessionId === ids.pilotSessionId,
        ),
      ).toHaveLength(0);
      expect(
        completed.some((event) =>
          JSON.stringify(event.payload).includes('pair-local-bootstrap'),
        ),
      ).toBe(false);
      await assertArtifactVocabulariesSeparated(harness);
    } finally {
      releaseBarrier?.();
      await closeBestEffort('P0.5 native-composer cleanup', [
        async () => harness.coordinator.close(),
        async () => harness.runtime.close(),
      ]);
    }
  }, 90_000);

  test('publishes Bridge-derived native conversation heads through the real Pair Host SSE stream', async () => {
    const pairId = 'pair-p05-sse-publication';
    const ids = createPairSessionIds(pairId);
    const nativeInput = 'Publish this native composer message through Pair SSE.';
    const finalAnswer = 'The durable native answer advanced the shared projection.';
    const harness = await launchPair('sse-publication', pairId, [finalAnswer]);
    const pairHost = createPairHostServer({
      registry: harness.registry,
      coordinator: harness.coordinator,
      dshBuild: harness.runtime.adapter.getDshRuntimeAttestation().dshBuild,
      host: '127.0.0.1',
      port: 0,
    });
    let sse: ProjectionSseClient | undefined;
    try {
      await createPair(harness);
      const address = await pairHost.listen();
      sse = await openProjectionSse(
        `${address.origin}/api/pairs/${pairId}/events`,
      );
      const initial = await sse.next();

      await sendNativePrompt(
        harness.runtime,
        ids.navigatorSessionId,
        'p05-sse-native-message',
        nativeInput,
      );
      await harness.runtime.adapter.whenIdle(ids.navigatorSessionId);
      const events = await harness.store.read(pairId);
      const nativeUser = events.filter(
        (event) =>
          event.type === 'user.message' &&
          event.source === 'navigator-session' &&
          event.payload.text === nativeInput,
      );
      const final = events.filter(
        (event) =>
          event.type === 'agent.message' &&
          event.source === 'navigator-session' &&
          event.payload.kind === 'turn-output' &&
          event.payload.text === finalAnswer,
      );
      expect(nativeUser).toHaveLength(1);
      expect(final).toHaveLength(1);

      const published = [initial];
      while (published.at(-1)!.header.sharedHead < final[0]!.seq) {
        published.push(await sse.next());
      }
      expect(initial.header.sharedHead).toBeLessThan(nativeUser[0]!.seq);
      expect(
        published.some(
          (projection) => projection.header.sharedHead === nativeUser[0]!.seq,
        ),
      ).toBe(true);
      expect(
        published.some(
          (projection) =>
            projection.header.sharedHead === final[0]!.seq &&
            projection.header.ledgerHead >= final[0]!.seq,
        ),
      ).toBe(true);
      expect(events.find((event) => event.seq === published.at(-1)!.header.sharedHead))
        .toMatchObject({
          type: 'agent.message',
          payload: { text: finalAnswer },
        });
    } finally {
      await sse?.close();
      await closeBestEffort('P0.5 SSE publication cleanup', [
        async () => pairHost.close(),
        async () => harness.runtime.close(),
      ]);
    }
  }, 90_000);

  test('fails Pair Host mutations closed while a real Bridge is degraded and keeps reads available', async () => {
    const pairId = 'pair-p05-bridge-degraded';
    const ids = createPairSessionIds(pairId);
    let faultArmed = false;
    let faultActive = true;
    let faultInjectionCount = 0;
    const harness = await launchPair(
      'bridge-degraded',
      pairId,
      ['The native Turn completed while its Bridge faulted.'],
      {
        lifecycleFaults: {
          beforeBridgeRead(sessionId) {
            if (
              !faultArmed ||
              !faultActive ||
              sessionId !== ids.navigatorSessionId
            ) {
              return;
            }
            faultInjectionCount += 1;
            throw new Error('injected private Bridge cause');
          },
        },
      },
    );
    const pairHost = createPairHostServer({
      registry: harness.registry,
      coordinator: harness.coordinator,
      dshBuild: harness.runtime.adapter.getDshRuntimeAttestation().dshBuild,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      await createPair(harness);
      const address = await pairHost.listen();
      faultArmed = true;
      await sendNativePrompt(
        harness.runtime,
        ids.navigatorSessionId,
        'p05-degrade-bridge',
        'Create a durable native message before the injected Bridge failure.',
      );
      await expect(
        harness.runtime.adapter.whenIdle(ids.navigatorSessionId),
      ).rejects.toThrow(/Session bridge failed/i);
      expect(faultInjectionCount).toBeGreaterThan(0);

      const beforeAttempts = await harness.store.read(pairId);
      const captureCount = harness.runtime.adapter.captureRequests().length;
      const navigatorTurns = harness.runtime.adapter
        .sessionEvents(ids.navigatorSessionId)
        .filter((event) => event.type === 'turn/start').length;
      const pilotTurns = harness.runtime.adapter
        .sessionEvents(ids.pilotSessionId)
        .filter((event) => event.type === 'turn/start').length;

      for (const role of ['navigator', 'pilot'] as const) {
        const response = await fetch(
          `${address.origin}/api/pairs/${pairId}/messages/${role}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text: `Rejected ${role} Pair-level input.`,
              expectedLedgerHead: beforeAttempts.at(-1)!.seq,
            }),
          },
        );
        expect(response.status).toBe(503);
        const body = await readJson(response);
        expect(body).toEqual({
          error: {
            code: 'PAIR_BRIDGE_DEGRADED',
            message: 'Pair shared-conversation bridge is degraded',
          },
        });
        expect(JSON.stringify(body)).not.toContain('injected private Bridge cause');
      }

      expect(await harness.store.read(pairId)).toEqual(beforeAttempts);
      expect(
        beforeAttempts.some((event) =>
          String(event.payload.text ?? '').startsWith('Rejected '),
        ),
      ).toBe(false);
      expect(harness.runtime.adapter.captureRequests()).toHaveLength(captureCount);
      expect(
        harness.runtime.adapter
          .sessionEvents(ids.navigatorSessionId)
          .filter((event) => event.type === 'turn/start'),
      ).toHaveLength(navigatorTurns);
      expect(
        harness.runtime.adapter
          .sessionEvents(ids.pilotSessionId)
          .filter((event) => event.type === 'turn/start'),
      ).toHaveLength(pilotTurns);

      const loaded = await fetch(`${address.origin}/api/pairs/${pairId}`);
      const audit = await fetch(
        `${address.origin}/api/pairs/${pairId}/session-events?afterSeq=0&limit=500&view=all`,
      );
      expect(loaded.status).toBe(200);
      expect(audit.status).toBe(200);
    } finally {
      faultActive = false;
      await closeBestEffort('P0.5 Bridge degraded cleanup', [
        async () => pairHost.close(),
        async () => harness.runtime.close(),
      ]);
    }
  }, 90_000);

  test('waits for a gated final Bridge drain during supervised close and restarts idempotently', async () => {
    const pairId = 'pair-p05-close-drain';
    const ids = createPairSessionIds(pairId);
    const nativeInput = 'Close must durably derive this native message.';
    const finalAnswer = 'Close also durably derived this completed answer.';
    let gateArmed = false;
    let gateEntered = false;
    let announceGate!: () => void;
    let releaseGate!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      announceGate = resolveEntered;
    });
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });
    const harness = await launchPair(
      'close-drain',
      pairId,
      [finalAnswer],
      {
        lifecycleFaults: {
          async beforeBridgeRead(sessionId) {
            if (
              !gateArmed ||
              gateEntered ||
              sessionId !== ids.navigatorSessionId
            ) {
              return;
            }
            gateEntered = true;
            announceGate();
            await gate;
          },
        },
      },
    );
    let runtimeClosed = false;
    try {
      await createPair(harness);
      gateArmed = true;
      await sendNativePrompt(
        harness.runtime,
        ids.navigatorSessionId,
        'p05-close-drain-native',
        nativeInput,
      );
      await entered;
      const durableSessionJsonl = await readFile(
        harness.runtime.adapter.sessionArtifact(ids.navigatorSessionId).path,
        'utf8',
      );
      expect(durableSessionJsonl).toContain('p05-close-drain-native');
      expect(durableSessionJsonl).toContain(nativeInput);
      expect(
        (await harness.store.read(pairId)).some(
          (event) => event.payload.text === nativeInput,
        ),
      ).toBe(false);

      const closing = harness.runtime.close().then(() => {
        runtimeClosed = true;
      });
      await expect(
        Promise.race([
          closing.then(() => 'closed' as const),
          Promise.resolve('pending' as const),
        ]),
      ).resolves.toBe('pending');
      expect(runtimeClosed).toBe(false);

      releaseGate();
      await closing;
      expect(runtimeClosed).toBe(true);
      const afterClose = await harness.store.read(pairId);
      const nativeUser = afterClose.filter(
        (event) =>
          event.type === 'user.message' &&
          event.source === 'navigator-session' &&
          event.payload.text === nativeInput,
      );
      const final = afterClose.filter(
        (event) =>
          event.type === 'agent.message' &&
          event.source === 'navigator-session' &&
          event.payload.text === finalAnswer,
      );
      expect(nativeUser).toHaveLength(1);
      expect(final).toHaveLength(1);
      for (const represented of [...nativeUser, ...final]) {
        const links = afterClose.filter(
          (event) =>
            event.type === 'session_event.linked' &&
            event.payload.pairEventId === pairEventId(represented),
        );
        expect(links).toHaveLength(1);
        expect(represented.seq).toBeLessThan(links[0]!.seq);
      }

      await harness.coordinator.close();
      const restarted = await launchRecoveryRuntime(harness.dataRoot, pairId);
      try {
        await restarted.registry.recoverPair(pairId);
        expect(await restarted.store.read(pairId)).toEqual(afterClose);
        await assertArtifactVocabulariesSeparated(restarted);
      } finally {
        await closeBestEffort('P0.5 close-drain recovery cleanup', [
          async () => restarted.coordinator.close(),
          async () => restarted.runtime.close(),
        ]);
      }
    } finally {
      releaseGate?.();
      await closeBestEffort('P0.5 close-drain cleanup', [
        async () => harness.coordinator.close(),
        async () => harness.runtime.close(),
      ]);
    }
  }, 120_000);

  test('round-trips Peer Messages symmetrically, preserves causality, and rejects a fifth hop without wake', async () => {
    const pairId = 'pair-p05-peer-chain';
    const ids = createPairSessionIds(pairId);
    const harness = await launchPair('peer-chain', pairId, {
      [ids.navigatorSessionId]: [
        {
          toolCall: {
            id: 'call-peer-hop-1',
            name: 'pair_message_peer',
            arguments: { text: 'Navigator to Pilot at hop one.' },
          },
        },
        'Navigator completed hop one.',
        {
          toolCall: {
            id: 'call-peer-hop-3',
            name: 'pair_message_peer',
            arguments: { text: 'Navigator replied to Pilot at hop three.' },
          },
        },
        'Navigator completed hop three.',
        {
          toolCall: {
            id: 'call-peer-hop-5-rejected',
            name: 'pair_message_peer',
            arguments: { text: 'This fifth hop must be rejected.' },
          },
        },
        'Navigator observed the bounded hop rejection.',
      ],
      [ids.pilotSessionId]: [
        {
          toolCall: {
            id: 'call-peer-hop-2',
            name: 'pair_message_peer',
            arguments: { text: 'Pilot replied to Navigator at hop two.' },
          },
        },
        'Pilot completed hop two.',
        {
          toolCall: {
            id: 'call-peer-hop-4',
            name: 'pair_message_peer',
            arguments: { text: 'Pilot replied to Navigator at hop four.' },
          },
        },
        'Pilot completed hop four.',
      ],
    });
    try {
      await createPair(harness);
      const rootHead = (await harness.store.heads(pairId)).ledgerHead;
      await harness.coordinator.sendNavigator({
        pairId,
        text: 'Start the bounded peer round trip.',
        expectedLedgerHead: rootHead,
      });

      await expect.poll(
        () => harness.runtime.adapter.captureRequests().length,
        { timeout: 45_000 },
      ).toBe(10);
      await Promise.all([
        harness.runtime.adapter.whenIdle(ids.navigatorSessionId),
        harness.runtime.adapter.whenIdle(ids.pilotSessionId),
      ]);

      const events = await harness.store.read(pairId);
      const root = events.find(
        (event) =>
          event.type === 'user.message' &&
          event.source === 'pair' &&
          event.payload.text === 'Start the bounded peer round trip.',
      )!;
      const peers = events.filter(
        (event) =>
          event.type === 'agent.message' && event.payload.kind === 'peer-message',
      );
      expect(peers).toHaveLength(MAX_PEER_HOPS);
      expect(
        peers.map((event) => ({
          role: event.actor.kind === 'agent' ? event.actor.role : undefined,
          channel: event.channel,
          hop: event.payload.hop,
          causalRootId: event.payload.causalRootId,
        })),
      ).toEqual([
        { role: 'navigator', channel: 'pilot', hop: 1, causalRootId: pairEventId(root) },
        { role: 'pilot', channel: 'navigator', hop: 2, causalRootId: pairEventId(root) },
        { role: 'navigator', channel: 'pilot', hop: 3, causalRootId: pairEventId(root) },
        { role: 'pilot', channel: 'navigator', hop: 4, causalRootId: pairEventId(root) },
      ]);

      const captures = harness.runtime.adapter.captureRequests();
      for (const peer of peers) {
        const recipient = peer.channel === 'navigator'
          ? ids.navigatorSessionId
          : ids.pilotSessionId;
        const deliveryRequest = captures.find(
          (request) =>
            request.sessionId === recipient &&
            requestContains(request, `"pairEventId":"${pairEventId(peer)}"`),
        );
        expect(deliveryRequest).toBeDefined();
        expect(peer.seq).toBeLessThanOrEqual(
          deliveryRequest!.providerStartedAtLedgerHead,
        );
        expect(
          sharedEvents(deliveryRequest!).filter((event) => event.seq === peer.seq),
        ).toHaveLength(1);
      }

      const expectedPeerTool = {
        name: 'pair_message_peer',
        description: 'Send one bounded message to the other Pair Agent and wake it.',
        parameters: harness.router.toolDefinition().parameters,
      };
      for (const request of captures) {
        expect(request.tools).toEqual([expectedPeerTool]);
        expect(Object.keys(
          ((request.tools?.[0]?.parameters as JsonObject).properties as JsonObject),
        )).toEqual(['text']);
      }
      expect(
        harness.runtime.adapter
          .sessionEvents(ids.navigatorSessionId)
          .filter((event) => event.type === 'turn/start'),
      ).toHaveLength(3);
      expect(
        harness.runtime.adapter
          .sessionEvents(ids.pilotSessionId)
          .filter((event) => event.type === 'turn/start'),
      ).toHaveLength(2);
      expect(
        events.some((event) => event.payload.text === 'This fifth hop must be rejected.'),
      ).toBe(false);
      await assertArtifactVocabulariesSeparated(harness);
    } finally {
      await closeBestEffort('P0.5 peer round-trip cleanup', [
        async () => harness.coordinator.close(),
        async () => harness.runtime.close(),
      ]);
    }
  }, 120_000);

  test('recovers a crash after a durable native DSH message and before Pair derivation exactly once', async () => {
    const pairId = 'pair-p05-restart-gap';
    const dataRoot = await tempRoot('restart-gap');
    const pairRoot = join(dataRoot, 'pairs');
    await runCrashWindowChild(dataRoot, pairId);

    const crashedEvents = await new JsonlPairLedgerStore(pairRoot).read(pairId);
    expect(crashedEvents.find(
      (event) =>
        event.type === 'user.message' &&
        event.source === 'navigator-session' &&
        event.payload.text === 'Crash after this DSH-native message.',
    )).toBeUndefined();

    const first = await launchRecoveryRuntime(dataRoot, pairId, [recoveryHoldTool()]);
    let afterFirstRestart: PairEvent[];
    let pairHost: ReturnType<typeof createPairHostServer> | undefined;
    try {
      await first.registry.recoverPair(pairId);
      afterFirstRestart = await first.store.read(pairId);
      expect(afterFirstRestart).toHaveLength(crashedEvents.length + 2);
      const recoveredMessages = afterFirstRestart.filter(
        (event) =>
          event.type === 'user.message' &&
          event.source === 'navigator-session' &&
          event.payload.text === 'Crash after this DSH-native message.',
      );
      expect(recoveredMessages).toHaveLength(1);
      const recoveredMessage = recoveredMessages[0]!;
      const links = afterFirstRestart.filter(
        (event) =>
          event.type === 'session_event.linked' &&
          event.payload.pairEventId === pairEventId(recoveredMessage),
      );
      expect(links).toHaveLength(1);
      expect(recoveredMessage.seq).toBeLessThan(links[0]!.seq);

      pairHost = createPairHostServer({
        registry: first.registry,
        coordinator: first.coordinator,
        dshBuild: first.runtime.adapter.getDshRuntimeAttestation().dshBuild,
        host: '127.0.0.1',
        port: 0,
      });
      const address = await pairHost.listen();
      const response = await fetch(
        `${address.origin}/api/pairs/${pairId}/session-events?afterSeq=0&limit=500&view=all`,
      );
      expect(response.status).toBe(200);
      const page = await readJson(response) as {
        throughLedgerHead: number;
        nextAfterSeq: number;
        hasMore: boolean;
        events: PairEvent[];
      };
      expect(page.events).toEqual(afterFirstRestart);
      expect(page.throughLedgerHead).toBe(afterFirstRestart.at(-1)!.seq);
      expect(page.nextAfterSeq).toBe(afterFirstRestart.at(-1)!.seq);
      expect(page.hasMore).toBe(false);
    } finally {
      await closeBestEffort('P0.5 first recovery cleanup', [
        async () => pairHost?.close(),
        async () => first.coordinator.close(),
        async () => first.runtime.close(),
      ]);
    }

    const second = await launchRecoveryRuntime(dataRoot, pairId, [recoveryHoldTool()]);
    try {
      await second.registry.recoverPair(pairId);
      expect(await second.store.read(pairId)).toEqual(afterFirstRestart!);
      await assertArtifactVocabulariesSeparated(second);
    } finally {
      await closeBestEffort('P0.5 second recovery cleanup', [
        async () => second.coordinator.close(),
        async () => second.runtime.close(),
      ]);
    }
  }, 180_000);
});

function recoveryHoldTool(): DshPairToolDefinition {
  return {
    name: 'p05_crash_hold',
    description: 'Hold a capture request only inside the restart crash-window E2E.',
    parameters: { label: { type: 'string' } },
    async execute() {
      return [{ type: 'text', text: 'not resumed' }];
    },
  };
}

async function launchRecoveryRuntime(
  dataRoot: string,
  pairId: string,
  extraTools: readonly DshPairToolDefinition[] = [],
): Promise<LivePairHarness> {
  const pairRoot = join(dataRoot, 'pairs');
  const store = new JsonlPairLedgerStore(pairRoot);
  const router = new PeerMessageRouter();
  let registry!: PairRegistry;
  const runtime = await launchDshPairWebRuntime({
    source: { derivedRoot: dshRoot, lockPath: dshLockPath },
    dataRoot,
    store,
    commonSystem,
    provider: 'openai-completions',
    model: 'capture-model',
    capture: { responses: [] },
    tools: [router.toolDefinition(), ...extraTools],
    onLedgerAdvanced: async (advancedPairId) => {
      await registry.publish(advancedPairId);
    },
    web: { host: '127.0.0.1', port: 0 },
  });
  registry = new PairRegistry(store, runtime.adapter);
  const coordinator = new PairCoordinator(registry, store, runtime.adapter);
  router.bind(new PeerMessageService(coordinator, runtime.adapter));
  return { dataRoot, pairRoot, pairId, store, runtime, registry, coordinator, router };
}

async function runCrashWindowChild(dataRoot: string, pairId: string): Promise<void> {
  const requireFromMvp = createRequire(join(mvpRoot, 'package.json'));
  const vitestNode = requireFromMvp.resolve('vitest/node');
  const viteNodeCli = resolve(dirname(vitestNode), '../../vite-node/vite-node.mjs');
  const scriptPath = join(
    mvpRoot,
    'tests/e2e',
    `.p05-crash-${basename(dataRoot)}.ts`,
  );
  generatedCrashScripts.push(scriptPath);
  const script = `
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { JsonlPairLedgerStore } from '../../packages/ledger/src/index.ts';
import {
  PairCoordinator,
  PeerMessageRouter,
  PeerMessageService,
  PairRegistry,
  launchDshPairWebRuntime,
} from '../../packages/runtime/src/index.ts';

const dataRoot = ${JSON.stringify(dataRoot)};
const pairId = ${JSON.stringify(pairId)};
const mvpRoot = ${JSON.stringify(mvpRoot)};
let resolveCrashed;
const crashed = new Promise((resolve) => { resolveCrashed = resolve; });
let bridgeArmed = false;
let bridgeBlocked = false;
const navigatorSessionId = 'pair:' + pairId + ':navigator';
const store = new JsonlPairLedgerStore(join(dataRoot, 'pairs'));
const router = new PeerMessageRouter();
let registry;
let announceTool;
const toolStarted = new Promise((resolve) => { announceTool = resolve; });
const runtime = await launchDshPairWebRuntime({
  source: {
    derivedRoot: join(mvpRoot, '.runtime/deepseek-harness'),
    lockPath: join(mvpRoot, 'dsh.lock.json'),
  },
  dataRoot,
  store,
  commonSystem: ${JSON.stringify(commonSystem)},
  provider: 'openai-completions',
  model: 'capture-model',
  capture: {
    responses: [{
      toolCall: {
        id: 'call-p05-crash-hold',
        name: 'p05_crash_hold',
        arguments: { label: 'crash-window' },
      },
    }],
  },
  lifecycleFaults: {
    async beforeBridgeRead(sessionId) {
      if (!bridgeArmed || bridgeBlocked || sessionId !== navigatorSessionId) return;
      bridgeBlocked = true;
      resolveCrashed();
      await new Promise(() => {});
    },
  },
  tools: [
    router.toolDefinition(),
    {
      name: 'p05_crash_hold',
      description: 'Hold a capture request only inside the restart crash-window E2E.',
      parameters: { label: { type: 'string' } },
      async execute() {
        announceTool();
        return await new Promise(() => {});
      },
    },
  ],
  onLedgerAdvanced: async (advancedPairId) => {
    await registry.publish(advancedPairId);
  },
  web: { host: '127.0.0.1', port: 0 },
});
registry = new PairRegistry(store, runtime.adapter);
const coordinator = new PairCoordinator(registry, store, runtime.adapter);
router.bind(new PeerMessageService(coordinator, runtime.adapter));
const created = await coordinator.createPair({
  pairId,
  dshBuild: runtime.adapter.getDshRuntimeAttestation().dshBuild,
  expectedLedgerHead: 0,
});
if (created.status !== 'ready') throw new Error(created.reason);
bridgeArmed = true;
const ids = created.projection.header;
const promptResponse = await fetch(runtime.origin + '/api/session.prompt', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    type: 'client-request',
    rpcId: 'p05-crash-native-message',
    method: 'session.prompt',
    payload: {
      sessionId: ids.navigatorSessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'Crash after this DSH-native message.' }],
    },
  }),
});
if (promptResponse.status !== 200) throw new Error('native prompt HTTP failed');

await Promise.race([
  Promise.all([crashed, toolStarted]),
  new Promise((_, reject) => setTimeout(
    () => reject(new Error('crash window was not reached')),
    30_000,
  )),
]);
const events = await store.read(pairId);
const message = events.find((event) =>
  event.type === 'user.message' &&
  event.source === 'navigator-session' &&
  event.payload.text === 'Crash after this DSH-native message.'
);
if (message !== undefined) throw new Error('Pair derivation crossed the injected crash window');
const dshJsonl = await readFile(
  runtime.adapter.sessionArtifact(ids.navigatorSessionId).path,
  'utf8',
);
if (!dshJsonl.includes('p05-crash-native-message')) {
  throw new Error('native DSH message is not durable');
}
await new Promise((resolve, reject) => {
  process.stdout.write('P05_CRASH_WINDOW_READY\\n', (error) => {
    if (error) reject(error);
    else resolve();
  });
});
process.exit(0);
`;
  await writeFile(scriptPath, script, 'utf8');

  const { OPENAI_API_KEY: _openAi, DEEPSEEK_API_KEY: _deepSeek, ...safeEnv } =
    process.env;
  await new Promise<void>((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [viteNodeCli, scriptPath], {
      cwd: mvpRoot,
      env: safeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectChild(new Error(`Crash-window child timed out\n${stderr}`));
    }, 60_000);
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectChild(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && stdout.includes('P05_CRASH_WINDOW_READY')) {
        resolveChild();
        return;
      }
      rejectChild(
        new Error(
          `Crash-window child failed (${String(code ?? signal)})\n${stdout}\n${stderr}`,
        ),
      );
    });
  });
}
