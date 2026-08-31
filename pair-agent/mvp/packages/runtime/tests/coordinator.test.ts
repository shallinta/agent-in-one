import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type DshBuildRef, type PairRole } from '@pair-agent/contracts';
import {
  JsonlPairLedgerStore,
  LedgerConflictError,
  replayPairProjection,
} from '@pair-agent/ledger';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  DeliveryPendingError,
  InvalidCommandError,
  PairCoordinator,
  pairEventId,
} from '../src/coordinator.js';
import {
  PairRegistry,
  type AgentAdapter,
  type AgentHandle,
  type FollowupInput,
  type PreparePairAgentInput,
  type PreparedPairAgent,
} from '../src/pair-registry.js';

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pair-runtime-coordinator-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

const dshBuild: DshBuildRef = {
  upstreamRepository: 'openai/deepseek-harness',
  upstreamCommit: 'a'.repeat(40),
  sourceRepository: 'example/pair-agent',
  sourceCommit: 'b'.repeat(40),
  requestLayoutSeamVersion: 1,
};

class RecordingAdapter implements AgentAdapter {
  readonly followups: FollowupInput[] = [];
  onFollowup?: (input: FollowupInput) => Promise<void>;

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

  async release(_handle: AgentHandle): Promise<void> {}

  async resumePairAgent(input: PreparePairAgentInput): Promise<PreparedPairAgent> {
    return this.preparePairAgent(input);
  }

  async followup(input: FollowupInput): Promise<void> {
    this.followups.push(input);
    await this.onFollowup?.(input);
  }
}

describe('PairCoordinator durable delivery', () => {
  let store: JsonlPairLedgerStore;
  let adapter: RecordingAdapter;
  let coordinator: PairCoordinator;

  beforeEach(async () => {
    store = new JsonlPairLedgerStore(await createRoot());
    adapter = new RecordingAdapter();
    coordinator = new PairCoordinator(new PairRegistry(store, adapter), store, adapter);
    const created = await coordinator.createPair({
      pairId: 'pair-commands',
      dshBuild,
      expectedLedgerHead: 0,
    });
    expect(created.status).toBe('ready');
  });

  test.each([
    ['navigator', 'sendNavigator'],
    ['pilot', 'sendPilot'],
  ] as const)('flushes a %s user.message before waking that role', async (role, method) => {
    adapter.onFollowup = async (delivery) => {
      const events = await store.read('pair-commands');
      const durable = events.find(
        (event) => pairEventId(event) === delivery.deliveryId,
      );
      expect(durable).toMatchObject({
        type: 'user.message',
        actor: { kind: 'user' },
        source: 'pair',
        channel: role,
        visibility: 'shared',
        authority: 'user',
        payload: { text: `hello ${role}` },
      });
    };
    const expectedLedgerHead = (await store.heads('pair-commands')).ledgerHead;

    const result = await coordinator[method]({
      pairId: 'pair-commands',
      text: `hello ${role}`,
      expectedLedgerHead,
    });

    expect(result).toEqual({
      acceptedAtLedgerHead: expectedLedgerHead + 1,
      deliveryId: `pair-commands:${expectedLedgerHead + 1}`,
      delivery: 'delivered',
    });
    expect(adapter.followups.at(-1)?.sessionId).toBe(
      `pair:pair-commands:${role}`,
    );
  });

  test('assigns the exported version-1 queued PairTask from Navigator and wakes only Pilot', async () => {
    const expectedLedgerHead = (await store.heads('pair-commands')).ledgerHead;

    const result = await coordinator.assignTask({
      pairId: 'pair-commands',
      expectedLedgerHead,
      task: {
        id: 'task-01',
        revision: 1,
        summary: 'Implement the host vertical',
        state: 'queued',
      },
      goalRef: { id: 'goal-01', version: 1 },
    });

    expect(result.delivery).toBe('delivered');
    expect(adapter.followups).toHaveLength(1);
    expect(adapter.followups[0]).toMatchObject({
      sessionId: 'pair:pair-commands:pilot',
      deliveryId: `pair-commands:${expectedLedgerHead + 1}`,
      trigger: { kind: 'task.assigned', pairEventId: `pair-commands:${expectedLedgerHead + 1}` },
    });
    const event = (await store.read('pair-commands')).at(-1);
    expect(event).toMatchObject({
      type: 'task.assigned',
      actor: { kind: 'agent', role: 'navigator' },
      authority: 'navigator',
      refs: {
        task: { id: 'task-01', revision: 1 },
        goal: { id: 'goal-01', version: 1 },
      },
      payload: {
        task: {
          id: 'task-01',
          revision: 1,
          summary: 'Implement the host vertical',
          state: 'queued',
        },
      },
    });
  });

  test.each([
    [{ id: 'task-01', revision: 2, summary: 'Skipped revision', state: 'queued' }],
    [{ id: 'task-01', revision: 1, summary: 'Already active', state: 'active' }],
  ] as const)('rejects an invalid initial task assignment before writing or waking', async (task) => {
    const expectedLedgerHead = (await store.heads('pair-commands')).ledgerHead;
    await expect(
      coordinator.assignTask({
        pairId: 'pair-commands',
        task,
        expectedLedgerHead,
      }),
    ).rejects.toBeInstanceOf(InvalidCommandError);
    expect((await store.heads('pair-commands')).ledgerHead).toBe(expectedLedgerHead);
    expect(adapter.followups).toEqual([]);
  });

  test('keeps the event durable and reports pending when adapter delivery fails', async () => {
    adapter.onFollowup = async () => {
      throw new Error('adapter offline');
    };
    const expectedLedgerHead = (await store.heads('pair-commands')).ledgerHead;

    const pending = await coordinator
      .sendNavigator({
        pairId: 'pair-commands',
        text: 'durable first',
        expectedLedgerHead,
      })
      .catch((error: unknown) => error);

    expect(pending).toBeInstanceOf(DeliveryPendingError);
    expect(pending).toMatchObject({
      pairId: 'pair-commands',
      acceptedAtLedgerHead: expectedLedgerHead + 1,
      deliveryId: `pair-commands:${expectedLedgerHead + 1}`,
    });
    expect((await store.read('pair-commands')).at(-1)).toMatchObject({
      type: 'user.message',
      payload: { text: 'durable first' },
    });
  });

  test('applies expectedLedgerHead CAS before every command', async () => {
    const actual = (await store.heads('pair-commands')).ledgerHead;

    await expect(
      coordinator.sendPilot({
        pairId: 'pair-commands',
        text: 'stale',
        expectedLedgerHead: actual - 1,
      }),
    ).rejects.toBeInstanceOf(LedgerConflictError);
    expect(adapter.followups).toEqual([]);
  });

  test.each(['', ' '.repeat(2), 'x'.repeat(65_537)])(
    'rejects invalid message text without appending: %s',
    async (text) => {
      const head = (await store.heads('pair-commands')).ledgerHead;
      await expect(
        coordinator.sendNavigator({
          pairId: 'pair-commands',
          text,
          expectedLedgerHead: head,
        }),
      ).rejects.toBeInstanceOf(InvalidCommandError);
      expect((await store.heads('pair-commands')).ledgerHead).toBe(head);
    },
  );

  test('rejects non-JSON-safe task input before appending', async () => {
    const head = (await store.heads('pair-commands')).ledgerHead;
    const cyclic = { id: 'task-json' } as Record<string, unknown>;
    cyclic.self = cyclic;
    await expect(
      coordinator.assignTask({
        pairId: 'pair-commands',
        task: cyclic as never,
        expectedLedgerHead: head,
      }),
    ).rejects.toBeInstanceOf(InvalidCommandError);
    expect((await store.heads('pair-commands')).ledgerHead).toBe(head);
  });

  test('publishes command projection updates and supports cleanup', async () => {
    const heads: number[] = [];
    const unsubscribe = coordinator.subscribe('pair-commands', (projection) => {
      heads.push(projection.header.ledgerHead);
    });
    const head = (await store.heads('pair-commands')).ledgerHead;

    await coordinator.sendNavigator({
      pairId: 'pair-commands',
      text: 'publish me',
      expectedLedgerHead: head,
    });
    unsubscribe();

    expect(heads).toEqual([head + 1]);
    expect(coordinator.subscriberCount('pair-commands')).toBe(0);
  });

  test('serializes concurrent task mutations so only one assignment is durable and replayable', async () => {
    const first = coordinator.assignTask({
      pairId: 'pair-commands',
      expectedLedgerHead: 2,
      task: { id: 'task-01', revision: 1, summary: 'First', state: 'queued' },
    });
    const second = coordinator.assignTask({
      pairId: 'pair-commands',
      expectedLedgerHead: 3,
      task: { id: 'task-02', revision: 1, summary: 'Second', state: 'queued' },
    });

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(InvalidCommandError),
    });
    const events = await store.read('pair-commands');
    expect(events.filter((event) => event.type === 'task.assigned')).toHaveLength(1);
    expect(() => replayPairProjection(events)).not.toThrow();
  });

  test('a throwing projection subscriber cannot block the durable Agent wake', async () => {
    coordinator.subscribe('pair-commands', () => {
      throw new Error('subscriber failed');
    });

    const result = await coordinator.sendNavigator({
      pairId: 'pair-commands',
      text: 'still wake',
      expectedLedgerHead: 2,
    });

    expect(result.delivery).toBe('delivered');
    expect(adapter.followups).toHaveLength(1);
  });
});
