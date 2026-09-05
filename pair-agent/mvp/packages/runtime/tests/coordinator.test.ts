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

  test('lists semantic Pair events from a mutation-queue snapshot with physical cursors', async () => {
    await coordinator.sendNavigator({
      pairId: 'pair-commands',
      text: 'first semantic input',
      expectedLedgerHead: 2,
    });
    await store.append(
      'pair-commands',
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
          sessionId: 'pair:pair-commands:navigator',
          fromSessionSeq: 1,
          throughSessionSeq: 1,
          messageIds: ['message-1'],
          pairEventId: 'pair-commands:3',
          representation: 'full',
        },
      },
      3,
    );
    await store.append(
      'pair-commands',
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
      'pair-commands',
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
      pairId: 'pair-commands',
      text: 'second semantic input',
      expectedLedgerHead: 6,
    });

    await expect(coordinator.listSessionEvents('pair-commands', {
      afterSeq: 0,
      limit: 2,
      view: 'semantic',
    })).resolves.toMatchObject({
      pairId: 'pair-commands',
      throughLedgerHead: 7,
      sharedHead: 7,
      events: [
        { seq: 3, type: 'user.message' },
        { seq: 7, type: 'user.message' },
      ],
      nextAfterSeq: 7,
      hasMore: false,
    });

    const all = await coordinator.listSessionEvents('pair-commands', {
      afterSeq: 0,
      limit: 20,
      view: 'all',
    });
    expect(all.events.map(({ type }) => type)).toEqual([
      'pair.created',
      'pair.agent_ready',
      'user.message',
      'session_event.linked',
      'pair.request_built',
      'delivery.completed',
      'user.message',
    ]);
  });

  test('advances an empty semantic page through hidden physical events', async () => {
    const page = await coordinator.listSessionEvents('pair-commands', {
      afterSeq: 0,
      limit: 2,
      view: 'semantic',
    });

    expect(page).toMatchObject({
      pairId: 'pair-commands',
      throughLedgerHead: 2,
      sharedHead: 1,
      events: [],
      nextAfterSeq: 2,
      hasMore: false,
    });
  });

  test('rejects an unknown Pair when listing Session Events', async () => {
    await expect(coordinator.listSessionEvents('unknown-pair', {
      afterSeq: 0,
      limit: 2,
      view: 'semantic',
    })).rejects.toMatchObject({ name: 'PairNotFoundError' });
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

  test('deduplicates a durable peer message by sender Turn identity before retrying delivery', async () => {
    const identity = 'dsh:pair:pair-commands:navigator:turn:7:peer-message';
    adapter.onFollowup = async () => {
      throw new Error('pilot offline');
    };

    const first = await coordinator
      .sendPeerMessage({
        pairId: 'pair-commands',
        senderRole: 'navigator',
        senderSessionId: 'pair:pair-commands:navigator',
        senderTurn: 7,
        sourceIdentity: identity,
        text: 'one semantic message',
        causalRootId: 'pair-commands:2',
        hop: 1,
      })
      .catch((error: unknown) => error);

    expect(first).toBeInstanceOf(DeliveryPendingError);
    adapter.onFollowup = undefined;
    await expect(
      coordinator.sendPeerMessage({
        pairId: 'pair-commands',
        senderRole: 'navigator',
        senderSessionId: 'pair:pair-commands:navigator',
        senderTurn: 7,
        sourceIdentity: identity,
        text: 'one semantic message',
        causalRootId: 'pair-commands:2',
        hop: 1,
      }),
    ).resolves.toMatchObject({ delivery: 'delivered' });

    const messages = (await store.read('pair-commands')).filter(
      (event) => event.type === 'agent.message' && event.payload.kind === 'peer-message',
    );
    expect(messages).toHaveLength(1);
    expect(adapter.followups).toHaveLength(2);
    expect(adapter.followups[0]?.deliveryId).toBe(adapter.followups[1]?.deliveryId);
  });

  test('rejects malformed Peer reply metadata before appending or delivering', async () => {
    const base = {
      pairId: 'pair-commands',
      senderRole: 'navigator' as const,
      senderSessionId: 'pair:pair-commands:navigator',
      senderTurn: 9,
      sourceIdentity: 'dsh:pair:pair-commands:navigator:turn:9:peer-message',
      text: 'invalid correlated message',
      causalRootId: 'pair-commands:2',
      hop: 1,
    };
    const before = await store.heads('pair-commands');

    await expect(coordinator.sendPeerMessage({ ...base, replyTo: '  ' }))
      .rejects.toBeInstanceOf(InvalidCommandError);
    await expect(coordinator.sendPeerMessage({
      ...base,
      expectsReply: true,
      replyTo: 'pair-commands:2',
    })).rejects.toBeInstanceOf(InvalidCommandError);

    expect(await store.heads('pair-commands')).toEqual(before);
    expect(adapter.followups).toEqual([]);
  });

  test('fails closed when a sender Turn identity is already owned by a non-canonical event', async () => {
    const identity = 'dsh:pair:pair-commands:navigator:turn:8:peer-message';
    const head = (await store.heads('pair-commands')).ledgerHead;
    await store.append(
      'pair-commands',
      {
        type: 'agent.message',
        actor: { kind: 'agent', role: 'navigator' },
        source: 'navigator-session',
        channel: 'pilot',
        visibility: 'local',
        authority: 'navigator',
        refs: { sourceEventIds: [identity] },
        payload: {
          schemaVersion: 1,
          kind: 'peer-message',
          text: 'must not deliver',
          content: [{ type: 'text', text: 'must not deliver' }],
          causalRootId: 'pair-commands:2',
          hop: 1,
        },
      },
      head,
    );

    await expect(
      coordinator.sendPeerMessage({
        pairId: 'pair-commands',
        senderRole: 'navigator',
        senderSessionId: 'pair:pair-commands:navigator',
        senderTurn: 8,
        sourceIdentity: identity,
        text: 'must not deliver',
        causalRootId: 'pair-commands:2',
        hop: 1,
      }),
    ).rejects.toBeInstanceOf(InvalidCommandError);
    expect(adapter.followups).toEqual([]);
    expect(
      (await store.read('pair-commands')).filter(
        (event) => event.refs.sourceEventIds?.includes(identity),
      ),
    ).toHaveLength(1);
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
