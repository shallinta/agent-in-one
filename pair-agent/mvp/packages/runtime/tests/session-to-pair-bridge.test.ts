import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type DshBuildRef,
  type JsonObject,
  type PairId,
  parsePairId,
} from '@pair-agent/contracts';
import { JsonlPairLedgerStore } from '@pair-agent/ledger';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  PairDerivedEventWriter,
  PairRegistry,
  SessionToPairBridge,
  type AgentAdapter,
  type AgentHandle,
  type DshSessionEvent,
  type PairSessionBridgePort,
  type PreparePairAgentInput,
  type PreparedPairAgent,
} from '../src/index.js';

const roots: string[] = [];
const registries: PairRegistry[] = [];

const dshBuild: DshBuildRef = {
  upstreamRepository: 'openai/deepseek-harness',
  upstreamCommit: 'a'.repeat(40),
  sourceRepository: 'example/pair-agent',
  sourceCommit: 'b'.repeat(40),
  requestLayoutSeamVersion: 1,
};

class RegistryAdapter implements AgentAdapter {
  followups: string[] = [];
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
  resumePairAgent(input: PreparePairAgentInput): Promise<PreparedPairAgent> {
    return this.preparePairAgent(input);
  }
  async release(_handle: AgentHandle): Promise<void> {}
  async followup(input: { sessionId: string }): Promise<void> {
    this.followups.push(input.sessionId);
  }
  async close(): Promise<void> {}
}

class FakeBridgePort implements PairSessionBridgePort {
  readonly durable = new Map<string, DshSessionEvent[]>();
  readonly flushes = new Map<string, number>();
  readonly reads: Array<[string, number]> = [];
  readonly idles: string[] = [];
  flushFailure?: Error;
  onRead?: (sessionId: string, fromSeq: number) => Promise<void> | void;
  #listener?: (sessionId: string, event: DshSessionEvent) => void;

  onSessionEvent(listener: (sessionId: string, event: DshSessionEvent) => void) {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
    };
  }

  async flushSession(sessionId: string): Promise<void> {
    this.flushes.set(sessionId, (this.flushes.get(sessionId) ?? 0) + 1);
    if (this.flushFailure !== undefined) {
      const failure = this.flushFailure;
      this.flushFailure = undefined;
      throw failure;
    }
  }

  async readDurableFrom(sessionId: string, fromSeq: number) {
    this.reads.push([sessionId, fromSeq]);
    const suffix = (this.durable.get(sessionId) ?? []).filter(
      (event) => event.seq >= fromSeq,
    );
    await this.onRead?.(sessionId, fromSeq);
    return suffix;
  }

  async whenAgentIdle(sessionId: string): Promise<void> {
    this.idles.push(sessionId);
  }

  append(sessionId: string, event: DshSessionEvent, notify = true): void {
    const events = this.durable.get(sessionId) ?? [];
    events.push(event);
    this.durable.set(sessionId, events);
    if (notify) this.#listener?.(sessionId, event);
  }
}

function event(type: string, seq: number, data: JsonObject, time = 1_800_000_000_000 + seq): DshSessionEvent {
  return { type, seq, time, data };
}

function completeTurn(turn: number, offset = 0, answer = 'done'): DshSessionEvent[] {
  return [
    event('turn/start', offset, { turn }),
    event('user/message', offset + 1, {
      id: `u-${turn}`,
      role: 'user',
      content: [{ type: 'text', text: `question ${turn}` }],
      source: { kind: 'user' },
    }),
    event('assistant/message', offset + 2, {
      turn,
      step: 1,
      message: {
        id: `a-${turn}`,
        role: 'assistant',
        content: [{ type: 'text', text: answer }],
        source: { kind: 'model', provider: 'capture', model: 'capture' },
      },
    }),
    event('turn/end', offset + 3, { turn, reason: { kind: 'completed' } }),
  ];
}

async function harness(name = 'pair-bridge'): Promise<{
  pairId: PairId;
  registry: PairRegistry;
  adapter: RegistryAdapter;
  port: FakeBridgePort;
  bridge: SessionToPairBridge;
  sessions: { navigator: string; pilot: string };
}> {
  const root = await mkdtemp(join(tmpdir(), 'pair-bridge-'));
  roots.push(root);
  const store = new JsonlPairLedgerStore(root);
  const adapter = new RegistryAdapter();
  const registry = new PairRegistry(store, adapter);
  registries.push(registry);
  const pairId = parsePairId(name);
  const ready = await registry.createPair({ pairId, dshBuild, expectedLedgerHead: 0 });
  if (ready.status !== 'ready') throw new Error(ready.reason);
  const port = new FakeBridgePort();
  const bridge = new SessionToPairBridge(port, new PairDerivedEventWriter(registry));
  const sessions = {
    navigator: ready.panes[0].sessionId,
    pilot: ready.panes[1].sessionId,
  };
  bridge.bindSession(pairId, 'navigator', sessions.navigator);
  bridge.bindSession(pairId, 'pilot', sessions.pilot);
  await bridge.catchUpPair(pairId);
  return { pairId, registry, adapter, port, bridge, sessions };
}

afterEach(async () => {
  await Promise.allSettled(registries.splice(0).map((registry) => registry.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('SessionToPairBridge', () => {
  test('ignores unrelated Sessions and drains only an allowed direct user message', async () => {
    const { pairId, registry, port, bridge, sessions } = await harness();
    port.append('unrelated', completeTurn(1)[1]!);
    port.append(sessions.navigator, completeTurn(1)[0]!, false);
    port.append(sessions.navigator, completeTurn(1)[1]!);
    await bridge.whenCaughtUp();

    const events = await registry.readEvents(pairId);
    expect(events.filter((candidate) => candidate.type === 'user.message')).toHaveLength(1);
    expect(port.flushes.has('unrelated')).toBe(false);
    expect(port.flushes.get(sessions.navigator)).toBe(2);
    expect(port.flushes.get(sessions.pilot)).toBe(1);
  });

  test('turn/end drains a final answer without waking the other Agent', async () => {
    const { pairId, registry, adapter, port, bridge, sessions } = await harness();
    for (const candidate of completeTurn(1)) {
      port.append(sessions.navigator, candidate, candidate.type === 'turn/end');
    }
    await bridge.whenCaughtUp([sessions.navigator]);

    const messages = (await registry.readEvents(pairId)).filter(
      (candidate) => candidate.type === 'agent.message',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload).toMatchObject({ text: 'done', completion: 'complete' });
    expect(adapter.followups).toEqual([]);
  });

  test('coalesces repeated notifications into one serial drain', async () => {
    const { port, bridge, sessions } = await harness();
    const flush = vi.spyOn(port, 'flushSession');
    const turn = completeTurn(1);
    for (const candidate of turn) port.append(sessions.navigator, candidate);
    await bridge.whenCaughtUp([sessions.navigator]);

    expect(flush.mock.calls.filter(([id]) => id === sessions.navigator)).toHaveLength(1);
  });

  test('retries a transient flush failure on the next dirty signal without advancing the cursor', async () => {
    const { pairId, registry, port, bridge, sessions } = await harness();
    port.flushFailure = new Error('flush unavailable');
    port.append(sessions.navigator, completeTurn(1)[0]!, false);
    port.append(sessions.navigator, completeTurn(1)[1]!);
    await expect(bridge.whenCaughtUp([sessions.navigator])).rejects.toThrow(/flush unavailable/);
    expect(() => bridge.assertHealthy(pairId)).toThrow(/flush unavailable/);
    expect((await registry.readEvents(pairId)).filter((event) => event.type === 'user.message')).toHaveLength(0);

    port.append(sessions.navigator, event('todo/write', 2, { todos: [] }));
    port.append(sessions.navigator, event('user/message', 3, {
      id: 'u-retry',
      role: 'user',
      content: [{ type: 'text', text: 'retry' }],
      source: { kind: 'user' },
    }));
    await bridge.whenCaughtUp([sessions.navigator]);
    expect(() => bridge.assertHealthy(pairId)).not.toThrow();

    expect(port.reads.filter(([id]) => id === sessions.navigator).at(-1)).toEqual([
      sessions.navigator,
      0,
    ]);
    expect((await registry.readEvents(pairId)).filter((event) => event.type === 'user.message')).toHaveLength(2);
  });

  test('buffers an assistant event read before its later turn/end', async () => {
    const { pairId, registry, port, bridge, sessions } = await harness();
    const [start, directUser, answer, end] = completeTurn(1);
    port.append(sessions.navigator, start!, false);
    port.append(sessions.navigator, directUser!);
    port.append(sessions.navigator, answer!, false);
    await bridge.whenCaughtUp([sessions.navigator]);
    port.append(sessions.navigator, end!);
    await bridge.whenCaughtUp([sessions.navigator]);

    expect((await registry.readEvents(pairId)).filter((event) => event.type === 'agent.message')).toHaveLength(1);
  });

  test('re-drains an event notified after a catch-up durable read', async () => {
    const { pairId, registry, port, bridge, sessions } = await harness();
    const turn = completeTurn(1);
    port.append(sessions.navigator, turn[0]!, false);
    port.append(sessions.navigator, turn[1]!, false);
    port.onRead = (sessionId) => {
      if (sessionId !== sessions.navigator) return;
      port.onRead = undefined;
      port.append(
        sessions.navigator,
        event('user/message', 2, {
          id: 'u-late',
          role: 'user',
          content: [{ type: 'text', text: 'late question' }],
          source: { kind: 'user' },
        }),
      );
    };

    await bridge.recoverPair(pairId);

    expect(
      (await registry.readEvents(pairId)).filter(
        (candidate) => candidate.type === 'user.message',
      ),
    ).toHaveLength(2);
  });

  test('recovery catch-up sorts cross-Session groups by time, role, then Session seq', async () => {
    const { pairId, registry, port, bridge, sessions } = await harness();
    const navigator = completeTurn(1, 0, 'navigator answer').map((candidate) => ({
      ...candidate,
      time: candidate.type === 'user/message' ? 100 : candidate.type === 'assistant/message' ? 300 : candidate.time,
    }));
    const pilot = completeTurn(1, 0, 'pilot answer').map((candidate) => ({
      ...candidate,
      time: candidate.type === 'user/message' ? 100 : candidate.type === 'assistant/message' ? 200 : candidate.time,
    }));
    port.durable.set(sessions.navigator, navigator);
    port.durable.set(sessions.pilot, pilot);

    await bridge.recoverPair(pairId);
    const shared = (await registry.readEvents(pairId)).filter(
      (candidate) => candidate.type === 'user.message' || candidate.type === 'agent.message',
    );
    expect(shared.map((candidate) => [candidate.actor, candidate.payload])).toMatchObject([
      [{ kind: 'user' }, { text: 'question 1' }],
      [{ kind: 'user' }, { text: 'question 1' }],
      [{ kind: 'agent', role: 'pilot' }, { text: 'pilot answer' }],
      [{ kind: 'agent', role: 'navigator' }, { text: 'navigator answer' }],
    ]);
    const head = shared.at(-1)?.seq;
    await bridge.recoverPair(pairId);
    expect((await registry.readEvents(pairId)).at(-1)?.seq).toBeGreaterThanOrEqual(head ?? 0);
    expect((await registry.readEvents(pairId)).filter(
      (candidate) => candidate.type === 'user.message' || candidate.type === 'agent.message',
    )).toHaveLength(4);
  });
});
