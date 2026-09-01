import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createPairSessionIds,
  type DshBuildRef,
  type JsonObject,
  type PairEvent,
  type PairRole,
} from '@pair-agent/contracts';
import { JsonlPairLedgerStore } from '@pair-agent/ledger';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { PairCoordinator, pairEventId } from '../src/coordinator.js';
import { DshPairAgentAdapter } from '../src/dsh-adapter.js';
import {
  PeerMessageInfrastructureError,
  PeerMessagePolicyError,
  PeerMessageRouter,
  PeerMessageService,
  type PeerMessageExecutionPort,
  type PeerMessageServiceContext,
  type PeerMessageToolExecutionContext,
  type PeerMessageTurnProvenance,
} from '../src/peer-message.js';
import {
  PairRegistry,
  RegistryClosedError,
  type AgentAdapter,
  type AgentHandle,
  type FollowupInput,
  type PreparePairAgentInput,
  type PreparedPairAgent,
} from '../src/pair-registry.js';
import { BridgeFault } from '../src/session-to-pair-bridge.js';

const roots: string[] = [];

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pair-runtime-peer-message-'));
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
  healthError?: Error;
  onFollowup?: (input: FollowupInput) => Promise<void>;
  onRelease?: (handle: AgentHandle) => Promise<void>;

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
    await this.onRelease?.(handle);
  }

  async resumePairAgent(input: PreparePairAgentInput): Promise<PreparedPairAgent> {
    return this.preparePairAgent(input);
  }

  async followup(input: FollowupInput): Promise<void> {
    this.followups.push(structuredClone(input));
    await this.onFollowup?.(input);
  }

  assertPairHealthy(): void {
    if (this.healthError !== undefined) throw this.healthError;
  }
}

function pairInput(
  pairId: string,
  seq: number,
  type: PairEvent['type'] = 'user.message',
): PairEvent {
  const role = 'navigator' as const;
  return {
    pairId: pairId as PairEvent['pairId'],
    seq,
    type,
    actor: type === 'agent.message'
      ? { kind: 'agent', role }
      : type === 'task.assigned'
        ? { kind: 'agent', role }
        : { kind: 'user' },
    source: type === 'user.message' ? 'pair' : 'navigator-session',
    channel: type === 'task.assigned' ? 'shared-control' : 'navigator',
    visibility: 'shared',
    authority: type === 'user.message' ? 'user' : role,
    refs: {},
    payload: type === 'user.message'
      ? {
          schemaVersion: 1,
          kind: 'user-input',
          text: 'root input',
          content: [{ type: 'text', text: 'root input' }],
        }
      : type === 'agent.message'
        ? {
            schemaVersion: 1,
            kind: 'turn-output',
            text: 'ordinary agent output',
            content: [{ type: 'text', text: 'ordinary agent output' }],
            completion: 'complete',
          }
        : { task: { id: 'task-1', revision: 1, summary: 'Do it', state: 'queued' } },
    occurredAt: '2026-09-01T00:00:00.000Z',
  };
}

function peerInput(
  pairId: string,
  seq: number,
  senderRole: PairRole,
  causalRootId: string,
  hop: number,
): PairEvent {
  const receiverRole = senderRole === 'navigator' ? 'pilot' : 'navigator';
  return {
    pairId: pairId as PairEvent['pairId'],
    seq,
    type: 'agent.message',
    actor: { kind: 'agent', role: senderRole },
    source: `${senderRole}-session`,
    channel: receiverRole,
    visibility: 'shared',
    authority: senderRole,
    refs: { sourceEventIds: [`dsh:pair:${pairId}:${senderRole}:turn:1:peer-message`] },
    payload: {
      schemaVersion: 1,
      kind: 'peer-message',
      text: 'prior peer input',
      content: [{ type: 'text', text: 'prior peer input' }],
      causalRootId,
      hop,
    },
    occurredAt: '2026-09-01T00:00:00.000Z',
  };
}

function nativeComposerInput(pairId: string, seq: number): PairEvent {
  const sessionId = createPairSessionIds(pairId).navigatorSessionId;
  return {
    ...pairInput(pairId, seq),
    source: 'navigator-session',
    authority: 'user-derived',
    refs: { sourceEventIds: [`dsh:${sessionId}:1:user.message`] },
    payload: {
      schemaVersion: 1,
      kind: 'user-input',
      text: 'native composer input',
      content: [{ type: 'text', text: 'native composer input' }],
      origin: {
        schemaVersion: 1,
        sessionId,
        sessionEventSeq: 1,
        turn: 1,
        messageId: 'native-message-1',
      },
    },
  };
}

class MutableExecutionPort implements PeerMessageExecutionPort {
  readonly toolContexts: PeerMessageToolExecutionContext[] = [];
  context: PeerMessageServiceContext;
  provenance: PeerMessageTurnProvenance;

  constructor(pairId: string) {
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    this.context = { agentId: sessionId, sessionId, turn: 1 };
    this.provenance = {
      pairId,
      senderRole: 'navigator',
      inputEvents: [pairInput(pairId, 2)],
    };
  }

  activeContext(execution: PeerMessageToolExecutionContext): PeerMessageServiceContext {
    this.toolContexts.push(execution);
    return { ...this.context };
  }

  async turnProvenance(
    context: PeerMessageServiceContext,
  ): Promise<PeerMessageTurnProvenance> {
    expect(context).toEqual(this.context);
    return structuredClone(this.provenance);
  }
}

function toolContext(agentId: string): PeerMessageToolExecutionContext {
  return {
    agentId,
    callId: 'call-peer-1',
    rootCallId: 'call-peer-1',
    signal: new AbortController().signal,
  };
}

describe('bounded bidirectional Peer Message communication', () => {
  let pairId: string;
  let store: JsonlPairLedgerStore;
  let adapter: RecordingAdapter;
  let registry: PairRegistry;
  let coordinator: PairCoordinator;
  let port: MutableExecutionPort;
  let router: PeerMessageRouter;

  beforeEach(async () => {
    pairId = 'pair-peer-message';
    store = new JsonlPairLedgerStore(await createRoot());
    adapter = new RecordingAdapter();
    registry = new PairRegistry(store, adapter);
    coordinator = new PairCoordinator(registry, store, adapter);
    await coordinator.createPair({ pairId, dshBuild, expectedLedgerHead: 0 });
    port = new MutableExecutionPort(pairId);
    router = new PeerMessageRouter();
  });

  test('publishes only the exact bounded text tool contract and fails closed before binding', async () => {
    const definition = router.toolDefinition();
    expect(definition).toMatchObject({
      name: 'pair_message_peer',
      description: 'Send one bounded message to the other Pair Agent and wake it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 65_536 },
        },
      },
    });
    expect(Object.keys(definition.parameters.properties as JsonObject)).toEqual(['text']);
    const head = (await store.heads(pairId)).ledgerHead;

    await expect(
      definition.execute({ text: 'not yet' }, toolContext(port.context.agentId)),
    ).rejects.toBeInstanceOf(PeerMessageInfrastructureError);
    expect((await store.heads(pairId)).ledgerHead).toBe(head);
    expect(adapter.followups).toEqual([]);
  });

  test('rejects every model-supplied authority field because args contain only text', async () => {
    router.bind(new PeerMessageService(coordinator, port));
    const head = (await store.heads(pairId)).ledgerHead;

    await expect(
      router.toolDefinition().execute(
        { text: 'attempt', sender: 'pilot' },
        toolContext(port.context.agentId),
      ),
    ).rejects.toBeInstanceOf(PeerMessagePolicyError);
    expect((await store.heads(pairId)).ledgerHead).toBe(head);
    expect(adapter.followups).toEqual([]);
  });

  test('takes sender Session and role from active tool context, appends durably, then wakes only the opposite role', async () => {
    const service = new PeerMessageService(coordinator, port);
    router.bind(service);
    adapter.onFollowup = async (followup) => {
      const durable = (await store.read(pairId)).find(
        (event) => pairEventId(event) === followup.deliveryId,
      );
      expect(durable).toBeDefined();
    };
    const definition = router.toolDefinition();

    const result = await definition.execute(
      { text: 'Pilot, please inspect this.' },
      toolContext(port.context.agentId),
    );

    expect(port.toolContexts).toEqual([
      expect.objectContaining({
        agentId: createPairSessionIds(pairId).navigatorSessionId,
        callId: 'call-peer-1',
        rootCallId: 'call-peer-1',
      }),
    ]);
    expect(result[0]).toMatchObject({ type: 'text', text: expect.stringContaining('delivered') });
    expect(adapter.followups).toEqual([
      expect.objectContaining({ sessionId: createPairSessionIds(pairId).pilotSessionId }),
    ]);
    expect((await store.read(pairId)).at(-1)).toMatchObject({
      type: 'agent.message',
      actor: { kind: 'agent', role: 'navigator' },
      source: 'navigator-session',
      channel: 'pilot',
      visibility: 'shared',
      authority: 'navigator',
      refs: {
        sourceEventIds: [
          `dsh:${createPairSessionIds(pairId).navigatorSessionId}:turn:1:peer-message`,
        ],
      },
      payload: {
        schemaVersion: 1,
        kind: 'peer-message',
        text: 'Pilot, please inspect this.',
        content: [{ type: 'text', text: 'Pilot, please inspect this.' }],
        causalRootId: `${pairId}:2`,
        hop: 1,
      },
    });
  });

  test('rejects a queued Peer tool admission when the opposite Session Bridge becomes faulty', async () => {
    const mutationEntered = deferred();
    const releaseMutation = deferred();
    const blocker = registry.runDerivedMutation(pairId, async () => {
      mutationEntered.resolve();
      await releaseMutation.promise;
    });
    await mutationEntered.promise;
    router.bind(new PeerMessageService(coordinator, port));
    const before = await store.read(pairId);
    const sending = router.toolDefinition().execute(
      { text: 'Do not append across a Pilot Bridge fault.' },
      toolContext(port.context.agentId),
    );
    await new Promise<void>((resolveQueued) => setImmediate(resolveQueued));
    const ids = createPairSessionIds(pairId);
    adapter.healthError = new BridgeFault(
      pairId as never,
      ids.pilotSessionId,
      new Error('Pilot Bridge failed'),
    );
    releaseMutation.resolve();

    await expect(sending).rejects.toBeInstanceOf(BridgeFault);
    await blocker;
    expect(await store.read(pairId)).toEqual(before);
    expect(adapter.followups).toEqual([]);
  });

  test('rejects an already-queued Peer tool when Registry shutdown starts before admission', async () => {
    const mutationEntered = deferred();
    const releaseMutation = deferred();
    const blocker = registry.runDerivedMutation(pairId, async () => {
      mutationEntered.resolve();
      await releaseMutation.promise;
    });
    await mutationEntered.promise;
    router.bind(new PeerMessageService(coordinator, port));
    const before = await store.read(pairId);
    const sending = router.toolDefinition().execute(
      { text: 'Do not append after shutdown admission closes.' },
      toolContext(port.context.agentId),
    );
    await new Promise<void>((resolveQueued) => setImmediate(resolveQueued));

    const releaseEntered = deferred();
    const releaseShutdown = deferred();
    adapter.onRelease = async () => {
      releaseEntered.resolve();
      await releaseShutdown.promise;
    };
    const closing = coordinator.close();
    await releaseEntered.promise;
    releaseMutation.resolve();
    try {
      await expect(sending).rejects.toBeInstanceOf(RegistryClosedError);
      await blocker;
      expect(await store.read(pairId)).toEqual(before);
      expect(adapter.followups).toEqual([]);
    } finally {
      releaseShutdown.resolve();
      await closing;
    }
  });

  test.each(['', '   ', 'x'.repeat(65_537), '🙂'.repeat(16_385)])(
    'rejects empty or over-64-KiB text before append and wake',
    async (text) => {
      router.bind(new PeerMessageService(coordinator, port));
      const head = (await store.heads(pairId)).ledgerHead;
      await expect(
        router.toolDefinition().execute({ text }, toolContext(port.context.agentId)),
      ).rejects.toBeInstanceOf(PeerMessagePolicyError);
      expect((await store.heads(pairId)).ledgerHead).toBe(head);
      expect(adapter.followups).toEqual([]);
    },
  );

  test('allows one successful send per sender Turn and serializes competing calls', async () => {
    router.bind(new PeerMessageService(coordinator, port));
    const definition = router.toolDefinition();

    const results = await Promise.allSettled([
      definition.execute({ text: 'first' }, toolContext(port.context.agentId)),
      definition.execute({ text: 'second' }, toolContext(port.context.agentId)),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(PeerMessagePolicyError),
    });
    expect(
      (await store.read(pairId)).filter((event) => event.type === 'agent.message'),
    ).toHaveLength(1);
  });

  test('rejects the same text after a successful live-Turn delivery without another wake', async () => {
    router.bind(new PeerMessageService(coordinator, port));
    const definition = router.toolDefinition();

    await expect(
      definition.execute({ text: 'deliver only once' }, toolContext(port.context.agentId)),
    ).resolves.toBeDefined();
    await expect(
      definition.execute({ text: 'deliver only once' }, toolContext(port.context.agentId)),
    ).rejects.toBeInstanceOf(PeerMessagePolicyError);

    expect(
      (await store.read(pairId)).filter((event) => event.type === 'agent.message'),
    ).toHaveLength(1);
    expect(adapter.followups).toHaveLength(1);
  });

  test('allows the same Session to send again from a later active Turn', async () => {
    router.bind(new PeerMessageService(coordinator, port));
    const definition = router.toolDefinition();

    await definition.execute({ text: 'turn one' }, toolContext(port.context.agentId));
    port.context = { ...port.context, turn: 2 };
    port.provenance = {
      ...port.provenance,
      inputEvents: [pairInput(pairId, 5)],
    };
    await definition.execute({ text: 'turn two' }, toolContext(port.context.agentId));

    expect(
      (await store.read(pairId)).filter((event) => event.type === 'agent.message'),
    ).toHaveLength(2);
    expect(adapter.followups).toHaveLength(2);
  });

  test('routes a bound Pilot sender only to Navigator', async () => {
    const ids = createPairSessionIds(pairId);
    port.context = { agentId: ids.pilotSessionId, sessionId: ids.pilotSessionId, turn: 3 };
    port.provenance = {
      pairId,
      senderRole: 'pilot',
      inputEvents: [{ ...pairInput(pairId, 6), channel: 'pilot' }],
    };
    router.bind(new PeerMessageService(coordinator, port));

    await router.toolDefinition().execute(
      { text: 'Navigator, please decide.' },
      toolContext(ids.pilotSessionId),
    );

    expect(adapter.followups.at(-1)?.sessionId).toBe(ids.navigatorSessionId);
    expect((await store.read(pairId)).at(-1)).toMatchObject({
      actor: { kind: 'agent', role: 'pilot' },
      source: 'pilot-session',
      authority: 'pilot',
      channel: 'navigator',
    });
  });

  test.each([
    ['user input', [pairInput('pair-peer-message', 7)], 'pair-peer-message:7', 1],
    ['task input', [pairInput('pair-peer-message', 8, 'task.assigned')], 'pair-peer-message:8', 1],
    [
      'native-composer input',
      [nativeComposerInput('pair-peer-message', 10)],
      'pair-peer-message:10',
      1,
    ],
    [
      'peer input',
      [peerInput('pair-peer-message', 9, 'pilot', 'root-from-user', 3)],
      'root-from-user',
      4,
    ],
  ] as const)(
    'derives causal root and hop from durable %s provenance',
    async (_label, inputEvents, causalRootId, hop) => {
      port.provenance = { pairId, senderRole: 'navigator', inputEvents };
      router.bind(new PeerMessageService(coordinator, port));

      await router.toolDefinition().execute(
        { text: `derived from ${_label}` },
        toolContext(port.context.agentId),
      );

      expect((await store.read(pairId)).at(-1)?.payload).toMatchObject({
        kind: 'peer-message',
        causalRootId,
        hop,
      });
    },
  );

  test.each([
    [
      'attempted hop 5',
      [peerInput('pair-peer-message', 10, 'pilot', 'root', 4)],
    ],
    [
      'multiple peer roots',
      [
        peerInput('pair-peer-message', 10, 'pilot', 'root-a', 1),
        peerInput('pair-peer-message', 11, 'pilot', 'root-b', 1),
      ],
    ],
    [
      'ordinary agent.message input',
      [pairInput('pair-peer-message', 12, 'agent.message')],
    ],
    [
      'malformed directed peer input',
      [
        {
          ...peerInput('pair-peer-message', 13, 'pilot', 'root', 1),
          source: 'navigator-session' as const,
        },
      ],
    ],
    [
      'directed peer input without durable sender-Turn identity',
      [
        {
          ...peerInput('pair-peer-message', 14, 'pilot', 'root', 1),
          refs: {},
        },
      ],
    ],
  ] as const)('fails closed for %s without append or wake', async (_label, inputEvents) => {
    port.provenance = { pairId, senderRole: 'navigator', inputEvents };
    router.bind(new PeerMessageService(coordinator, port));
    const head = (await store.heads(pairId)).ledgerHead;

    await expect(
      router.toolDefinition().execute(
        { text: 'must not escape' },
        toolContext(port.context.agentId),
      ),
    ).rejects.toBeInstanceOf(PeerMessagePolicyError);
    expect((await store.heads(pairId)).ledgerHead).toBe(head);
    expect(adapter.followups).toEqual([]);
  });

  test('returns pending after synchronous wake failure and retries the same durable identity without a second message', async () => {
    let fail = true;
    adapter.onFollowup = async () => {
      if (fail) throw new Error('receiver temporarily unavailable');
    };
    router.bind(new PeerMessageService(coordinator, port));
    const definition = router.toolDefinition();

    const pending = await definition.execute(
      { text: 'durable exactly once' },
      toolContext(port.context.agentId),
    );
    expect(pending[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/pending.*receiver temporarily unavailable/i),
    });
    expect(
      (await store.read(pairId)).filter((event) => event.type === 'agent.message'),
    ).toHaveLength(1);

    fail = false;
    const delivered = await definition.execute(
      { text: 'durable exactly once' },
      toolContext(port.context.agentId),
    );
    expect(delivered[0]).toMatchObject({ type: 'text', text: expect.stringContaining('delivered') });
    expect(
      (await store.read(pairId)).filter((event) => event.type === 'agent.message'),
    ).toHaveLength(1);
    expect(adapter.followups).toHaveLength(2);
    expect(adapter.followups[0]?.deliveryId).toBe(adapter.followups[1]?.deliveryId);
  });

  test('rebuilds per-Turn quota from durable source identity after service restart', async () => {
    router.bind(new PeerMessageService(coordinator, port));
    await router.toolDefinition().execute(
      { text: 'persisted quota' },
      toolContext(port.context.agentId),
    );
    await coordinator.close();

    const restartedCoordinator = new PairCoordinator(
      new PairRegistry(store, adapter),
      store,
      adapter,
    );
    await restartedCoordinator.getPair(pairId);
    const restartedRouter = new PeerMessageRouter();
    restartedRouter.bind(new PeerMessageService(restartedCoordinator, port));
    const head = (await store.heads(pairId)).ledgerHead;

    await expect(
      restartedRouter.toolDefinition().execute(
        { text: 'different semantic message' },
        toolContext(port.context.agentId),
      ),
    ).rejects.toBeInstanceOf(PeerMessagePolicyError);
    expect((await store.heads(pairId)).ledgerHead).toBe(head);
  });

  test('uses the real DSH ToolRunContext Agent identity and wakes the opposite bound Session', async () => {
    const realPairId = 'pair-peer-real-dsh';
    const mvpRoot = resolve(import.meta.dirname, '../../..');
    const lockPath = join(mvpRoot, 'dsh.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
      upstreamRepository: string;
      upstreamCommit: string;
      sourceRepository: string;
      expectedDerivedCommit: string;
      requestLayoutSeamVersion: 1;
    };
    const realRouter = new PeerMessageRouter();
    const realStore = new JsonlPairLedgerStore(await createRoot());
    let realRegistry: PairRegistry;
    const realAdapter = await DshPairAgentAdapter.create({
      source: {
        derivedRoot: join(mvpRoot, '.runtime/deepseek-harness'),
        lockPath,
      },
      store: realStore,
      sessionRoot: await createRoot(),
      commonSystem: {
        version: 'pair-prompt/v1',
        content: 'Navigator governs and Pilot executes.',
      },
      provider: 'openai-completions',
      model: 'capture-model',
      capture: {
        responses: [
          {
            toolCall: {
              id: 'call-peer-real',
              name: 'pair_message_peer',
              arguments: { text: 'Message derived only from active Navigator context.' },
            },
          },
          'Navigator completed its tool step.',
          'Pilot received the peer message.',
          'Spare deterministic response.',
        ],
      },
      tools: [realRouter.toolDefinition()],
      onLedgerAdvanced: async (advancedPairId) => {
        await realRegistry.publish(advancedPairId);
      },
    });
    realRegistry = new PairRegistry(realStore, realAdapter);
    const realCoordinator = new PairCoordinator(
      realRegistry,
      realStore,
      realAdapter,
    );
    realRouter.bind(new PeerMessageService(realCoordinator, realAdapter));
    const ids = createPairSessionIds(realPairId);
    await realCoordinator.createPair({
      pairId: realPairId,
      dshBuild: {
        upstreamRepository: lock.upstreamRepository,
        upstreamCommit: lock.upstreamCommit,
        sourceRepository: lock.sourceRepository,
        sourceCommit: lock.expectedDerivedCommit,
        requestLayoutSeamVersion: lock.requestLayoutSeamVersion,
      },
      expectedLedgerHead: 0,
    });
    const head = (await realStore.heads(realPairId)).ledgerHead;

    await realCoordinator.sendNavigator({
      pairId: realPairId,
      text: 'Use the peer tool now.',
      expectedLedgerHead: head,
    });
    await realAdapter.whenIdle(ids.navigatorSessionId);
    await realAdapter.whenIdle(ids.pilotSessionId);

    const peerEvents = (await realStore.read(realPairId)).filter(
      (event) => event.type === 'agent.message' && event.payload.kind === 'peer-message',
    );
    expect(peerEvents).toHaveLength(1);
    expect(peerEvents[0]).toMatchObject({
      actor: { kind: 'agent', role: 'navigator' },
      source: 'navigator-session',
      authority: 'navigator',
      channel: 'pilot',
      payload: { hop: 1, causalRootId: `${realPairId}:${head + 1}` },
    });
    const requests = realAdapter.captureRequests();
    expect(requests[0]?.sessionId).toBe(ids.navigatorSessionId);
    expect(requests[0]?.tools).toEqual([
      {
        name: 'pair_message_peer',
        description: 'Send one bounded message to the other Pair Agent and wake it.',
        parameters: realRouter.toolDefinition().parameters,
      },
    ]);
    expect(
      requests.some(
        (request) =>
          request.sessionId === ids.pilotSessionId &&
          JSON.stringify(request.messages).includes('pair-trigger'),
      ),
    ).toBe(true);
    await realCoordinator.close();
  }, 30_000);

  test('rejects a real Navigator Peer tool when the opposite Pilot Bridge is degraded', async () => {
    const realPairId = 'pair-peer-opposite-bridge-fault';
    const mvpRoot = resolve(import.meta.dirname, '../../..');
    const lockPath = join(mvpRoot, 'dsh.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
      upstreamRepository: string;
      upstreamCommit: string;
      sourceRepository: string;
      expectedDerivedCommit: string;
      requestLayoutSeamVersion: 1;
    };
    const ids = createPairSessionIds(realPairId);
    let faultActive = false;
    const realRouter = new PeerMessageRouter();
    const realStore = new JsonlPairLedgerStore(await createRoot());
    let realRegistry: PairRegistry;
    const realAdapter = await DshPairAgentAdapter.create({
      source: {
        derivedRoot: join(mvpRoot, '.runtime/deepseek-harness'),
        lockPath,
      },
      store: realStore,
      sessionRoot: await createRoot(),
      commonSystem: {
        version: 'pair-prompt/v1',
        content: 'Navigator governs and Pilot executes.',
      },
      provider: 'openai-completions',
      model: 'capture-model',
      capture: {
        responsesBySession: {
          [ids.pilotSessionId]: ['Pilot completed the faulting native Turn.'],
          [ids.navigatorSessionId]: [
            {
              toolCall: {
                id: 'call-peer-opposite-bridge-fault',
                name: 'pair_message_peer',
                arguments: { text: 'This must not cross the Pilot Bridge fault.' },
              },
            },
            'Navigator observed the rejected Peer tool.',
          ],
        },
      },
      tools: [realRouter.toolDefinition()],
      lifecycleFaults: {
        beforeBridgeRead(sessionId) {
          if (faultActive && sessionId === ids.pilotSessionId) {
            throw new Error('Pilot Bridge injected fault');
          }
        },
      },
      onLedgerAdvanced: async (advancedPairId) => {
        await realRegistry.publish(advancedPairId);
      },
    });
    realRegistry = new PairRegistry(realStore, realAdapter);
    const realCoordinator = new PairCoordinator(realRegistry, realStore, realAdapter);
    realRouter.bind(new PeerMessageService(realCoordinator, realAdapter));
    const created = await realCoordinator.createPair({
      pairId: realPairId,
      dshBuild: {
        upstreamRepository: lock.upstreamRepository,
        upstreamCommit: lock.upstreamCommit,
        sourceRepository: lock.sourceRepository,
        sourceCommit: lock.expectedDerivedCommit,
        requestLayoutSeamVersion: lock.requestLayoutSeamVersion,
      },
      expectedLedgerHead: 0,
    });
    expect(created.status).toBe('ready');
    faultActive = true;
    const agents = realAdapter.context.agents as unknown as {
      get(sessionId: string): {
        followup(message: {
          id: string;
          role: 'user';
          content: readonly JsonObject[];
          source: JsonObject;
        }): void;
        whenIdle(): Promise<void>;
      } | undefined;
    };
    const pilot = agents.get(ids.pilotSessionId);
    const navigator = agents.get(ids.navigatorSessionId);
    expect(pilot).toBeDefined();
    expect(navigator).toBeDefined();

    try {
      pilot!.followup({
        id: 'pilot-native-bridge-fault',
        role: 'user',
        content: [{ type: 'text', text: 'Degrade only the Pilot Bridge.' }],
        source: { kind: 'user' },
      });
      await pilot!.whenIdle();
      await expect(
        realAdapter.whenIdle(ids.pilotSessionId),
      ).rejects.toBeInstanceOf(BridgeFault);
      expect(() => realAdapter.assertPairHealthy(realPairId as never))
        .toThrow(BridgeFault);
      const beforePeer = await realStore.read(realPairId);
      const pilotTurnsBefore = realAdapter
        .sessionEvents(ids.pilotSessionId)
        .filter((event) => event.type === 'turn/start').length;
      const pilotCapturesBefore = realAdapter.captureRequests().filter(
        (request) => request.sessionId === ids.pilotSessionId,
      ).length;

      navigator!.followup({
        id: 'navigator-native-peer-attempt',
        role: 'user',
        content: [{ type: 'text', text: 'Attempt the Peer tool while Pilot is degraded.' }],
        source: { kind: 'user' },
      });
      await navigator!.whenIdle();

      expect(
        realAdapter.captureRequests().some(
          (request) => request.sessionId === ids.navigatorSessionId,
        ),
      ).toBe(true);
      expect(
        (await realStore.read(realPairId)).filter(
          (event) =>
            event.type === 'agent.message' &&
            event.payload.kind === 'peer-message' &&
            event.payload.text === 'This must not cross the Pilot Bridge fault.',
        ),
      ).toHaveLength(0);
      expect(
        realAdapter
          .sessionEvents(ids.pilotSessionId)
          .filter((event) => event.type === 'turn/start'),
      ).toHaveLength(pilotTurnsBefore);
      expect(
        realAdapter.captureRequests().filter(
          (request) => request.sessionId === ids.pilotSessionId,
        ),
      ).toHaveLength(pilotCapturesBefore);
      expect(
        beforePeer.some(
          (event) => event.payload.text === 'This must not cross the Pilot Bridge fault.',
        ),
      ).toBe(false);
    } finally {
      faultActive = false;
      await realCoordinator.close();
    }
  }, 30_000);

  test('waits for delayed native-composer Bridge derivation before resolving Peer provenance', async () => {
    const realPairId = 'pair-peer-native-barrier';
    const mvpRoot = resolve(import.meta.dirname, '../../..');
    const lockPath = join(mvpRoot, 'dsh.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
      upstreamRepository: string;
      upstreamCommit: string;
      sourceRepository: string;
      expectedDerivedCommit: string;
      requestLayoutSeamVersion: 1;
    };
    let releaseRead!: () => void;
    let observeBlockedRead!: () => void;
    const blockedRead = new Promise<void>((resolveBlocked) => {
      observeBlockedRead = resolveBlocked;
    });
    const readGate = new Promise<void>((resolveRead) => {
      releaseRead = resolveRead;
    });
    let delayNativeRead = false;
    let blocked = false;
    const realRouter = new PeerMessageRouter();
    const realStore = new JsonlPairLedgerStore(await createRoot());
    let realRegistry: PairRegistry;
    const realAdapter = await DshPairAgentAdapter.create({
      source: {
        derivedRoot: join(mvpRoot, '.runtime/deepseek-harness'),
        lockPath,
      },
      store: realStore,
      sessionRoot: await createRoot(),
      commonSystem: {
        version: 'pair-prompt/v1',
        content: 'Navigator governs and Pilot executes.',
      },
      provider: 'openai-completions',
      model: 'capture-model',
      capture: {
        responses: [
          {
            toolCall: {
              id: 'call-peer-native-barrier',
              name: 'pair_message_peer',
              arguments: { text: 'Wait for native provenance before sending.' },
            },
          },
          'Navigator completed after the durable barrier.',
          'Pilot received the native-rooted peer message.',
          'Spare deterministic response.',
        ],
      },
      tools: [realRouter.toolDefinition()],
      lifecycleFaults: {
        async beforeBridgeRead(sessionId) {
          if (
            delayNativeRead &&
            sessionId === createPairSessionIds(realPairId).navigatorSessionId
          ) {
            if (!blocked) {
              blocked = true;
              observeBlockedRead();
            }
            await readGate;
          }
        },
      },
      onLedgerAdvanced: async (advancedPairId) => {
        await realRegistry.publish(advancedPairId);
      },
    });
    realRegistry = new PairRegistry(realStore, realAdapter);
    const realCoordinator = new PairCoordinator(realRegistry, realStore, realAdapter);
    realRouter.bind(new PeerMessageService(realCoordinator, realAdapter));
    const ids = createPairSessionIds(realPairId);
    await realCoordinator.createPair({
      pairId: realPairId,
      dshBuild: {
        upstreamRepository: lock.upstreamRepository,
        upstreamCommit: lock.upstreamCommit,
        sourceRepository: lock.sourceRepository,
        sourceCommit: lock.expectedDerivedCommit,
        requestLayoutSeamVersion: lock.requestLayoutSeamVersion,
      },
      expectedLedgerHead: 0,
    });
    delayNativeRead = true;
    const navigator = (realAdapter.context.agents as unknown as {
      get(sessionId: string): {
        followup(message: {
          id: string;
          role: 'user';
          content: readonly JsonObject[];
          source: JsonObject;
        }): void;
      } | undefined;
    }).get(ids.navigatorSessionId);
    expect(navigator).toBeDefined();

    navigator!.followup({
      id: 'native-composer-message',
      role: 'user',
      content: [{ type: 'text', text: 'Native composer root.' }],
      source: { kind: 'user' },
    });
    await blockedRead;
    await vi.waitFor(() => {
      expect(realAdapter.captureRequests().length).toBeGreaterThan(0);
    });
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

    expect(realAdapter.captureRequests()).toHaveLength(1);
    expect(
      (await realStore.read(realPairId)).some(
        (event) =>
          event.type === 'user.message' &&
          (event.payload.origin as JsonObject | undefined)?.messageId ===
            'native-composer-message',
      ),
    ).toBe(false);

    releaseRead();
    await realAdapter.whenIdle(ids.navigatorSessionId);
    await realAdapter.whenIdle(ids.pilotSessionId);

    const events = await realStore.read(realPairId);
    const native = events.find(
      (event) =>
        event.type === 'user.message' &&
        (event.payload.origin as JsonObject | undefined)?.messageId ===
          'native-composer-message',
    );
    const peer = events.find(
      (event) => event.type === 'agent.message' && event.payload.kind === 'peer-message',
    );
    expect(native).toBeDefined();
    expect(peer?.payload).toMatchObject({
      causalRootId: pairEventId(native!),
      hop: 1,
    });
    await realCoordinator.close();
  }, 30_000);
});
