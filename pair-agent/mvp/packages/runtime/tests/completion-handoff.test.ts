import {
  createPairSessionIds,
  type JsonObject,
  type PairEvent,
} from '@pair-agent/contracts';
import { describe, expect, test } from 'vitest';

import {
  CompletionHandoffInfrastructureError,
  CompletionHandoffPolicyError,
  CompletionHandoffRouter,
  CompletionHandoffService,
} from '../src/completion-handoff.js';
import type {
  PeerMessageExecutionPort,
  PeerMessageServiceContext,
  PeerMessageToolExecutionContext,
  PeerMessageTurnProvenance,
} from '../src/peer-message.js';

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function durableInput(pairId: string, seq = 1): PairEvent {
  return {
    pairId: pairId as PairEvent['pairId'],
    seq,
    type: 'user.message',
    actor: { kind: 'user' },
    source: 'pair',
    channel: 'pilot',
    visibility: 'shared',
    authority: 'user',
    refs: {},
    payload: {
      schemaVersion: 1,
      kind: 'user-input',
      text: 'delegated work',
      content: [{ type: 'text', text: 'delegated work' }],
    },
    occurredAt: '2026-09-03T00:00:00.000Z',
  };
}

function directedInput(
  pairId: string,
  seq: number,
  causalRootId: string,
  hop: number,
): PairEvent {
  return {
    pairId: pairId as PairEvent['pairId'],
    seq,
    type: 'agent.message',
    actor: { kind: 'agent', role: 'navigator' },
    source: 'navigator-session',
    channel: 'pilot',
    visibility: 'shared',
    authority: 'navigator',
    refs: {
      sourceEventIds: [
        `dsh:pair:${pairId}:navigator:turn:1:peer-message`,
      ],
    },
    payload: {
      schemaVersion: 1,
      kind: 'peer-message',
      text: 'delegated work',
      content: [{ type: 'text', text: 'delegated work' }],
      causalRootId,
      hop,
    },
    occurredAt: '2026-09-03T00:00:00.000Z',
  };
}

class MutableExecutionPort implements PeerMessageExecutionPort {
  readonly executions: PeerMessageToolExecutionContext[] = [];
  readonly provenanceContexts: PeerMessageServiceContext[] = [];
  context: PeerMessageServiceContext;
  provenance: PeerMessageTurnProvenance;
  activeContextError?: Error;

  constructor(readonly pairId: string) {
    const sessionId = createPairSessionIds(pairId).pilotSessionId;
    this.context = { agentId: sessionId, sessionId, turn: 1 };
    this.provenance = {
      pairId,
      senderRole: 'pilot',
      inputEvents: [durableInput(pairId)],
    };
  }

  activeContext(execution: PeerMessageToolExecutionContext): PeerMessageServiceContext {
    this.executions.push(execution);
    if (this.executions.length > 1 && this.activeContextError !== undefined) {
      throw this.activeContextError;
    }
    return { ...this.context };
  }

  async turnProvenance(
    context: PeerMessageServiceContext,
  ): Promise<PeerMessageTurnProvenance> {
    this.provenanceContexts.push(context);
    return structuredClone(this.provenance);
  }
}

class DeferredExecutionPort extends MutableExecutionPort {
  readonly provenanceEntered = deferred();
  readonly releaseProvenance = deferred();

  override async turnProvenance(
    context: PeerMessageServiceContext,
  ): Promise<PeerMessageTurnProvenance> {
    this.provenanceContexts.push(context);
    this.provenanceEntered.resolve();
    await this.releaseProvenance.promise;
    return structuredClone(this.provenance);
  }
}

function toolContext(agentId: string): PeerMessageToolExecutionContext {
  return {
    agentId,
    callId: 'call-completion-1',
    rootCallId: 'call-completion-1',
    signal: new AbortController().signal,
  };
}

describe('Pilot completion handoff registration', () => {
  test('publishes the exact empty-object tool contract and fails closed before binding', async () => {
    const pairId = 'pair-completion-contract';
    const port = new MutableExecutionPort(pairId);
    const router = new CompletionHandoffRouter();
    const definition = router.toolDefinition();

    expect(definition).toEqual(expect.objectContaining({
      name: 'pair_report_completion',
      description:
        "Register this Pilot Turn's final public answer for delivery to Navigator after durable turn completion.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    }));
    await expect(
      definition.execute({}, toolContext(port.context.agentId)),
    ).rejects.toBeInstanceOf(CompletionHandoffInfrastructureError);
    expect(port.executions).toEqual([]);
  });

  test.each([
    { text: 'model-supplied result' } as JsonObject,
    { pairId: 'pair-other' } as JsonObject,
    { senderRole: 'pilot' } as JsonObject,
  ])('rejects every model-supplied field: %j', async (args) => {
    const pairId = 'pair-completion-args';
    const port = new MutableExecutionPort(pairId);
    const router = new CompletionHandoffRouter();
    router.bind(new CompletionHandoffService(port));

    await expect(
      router.toolDefinition().execute(args, toolContext(port.context.agentId)),
    ).rejects.toBeInstanceOf(CompletionHandoffPolicyError);
    expect(port.provenanceContexts).toEqual([]);
  });

  test('registers one Pilot Turn and returns only the deterministic non-delivery acknowledgement', async () => {
    const pairId = 'pair-completion-success';
    const port = new MutableExecutionPort(pairId);
    const router = new CompletionHandoffRouter();
    router.bind(new CompletionHandoffService(port));

    await expect(
      router.toolDefinition().execute({}, toolContext(port.context.agentId)),
    ).resolves.toEqual([{
      type: 'text',
      text:
        'Completion handoff registered for this Pilot Turn. Provide the complete final report now; Navigator will be notified only after the Turn is durably completed.',
    }]);
    expect(port.executions).toHaveLength(2);
    expect(port.provenanceContexts).toEqual([port.context]);
  });

  test.each([
    ['Turn changes', 'turn'],
    ['Session binding changes', 'binding'],
  ] as const)(
    'rejects when the active %s while durable provenance is awaited',
    async (_label, change) => {
      const pairId = `pair-completion-revalidate-${change}`;
      const port = new DeferredExecutionPort(pairId);
      const originalContext = { ...port.context };
      const service = new CompletionHandoffService(port);
      const pending = service.execute({}, toolContext(port.context.agentId));
      await port.provenanceEntered.promise;

      port.context = change === 'turn'
        ? { ...port.context, turn: port.context.turn + 1 }
        : {
            agentId: createPairSessionIds(pairId).navigatorSessionId,
            sessionId: createPairSessionIds(pairId).navigatorSessionId,
            turn: port.context.turn,
          };
      port.releaseProvenance.resolve();

      await expect(pending).rejects.toBeInstanceOf(
        CompletionHandoffInfrastructureError,
      );
      expect(port.executions).toHaveLength(2);

      port.context = originalContext;
      await expect(
        service.execute({}, toolContext(originalContext.agentId)),
      ).resolves.toBeUndefined();
    },
  );

  test('wraps an authoritative closed-session revalidation failure without registering', async () => {
    const pairId = 'pair-completion-revalidate-closed';
    const port = new DeferredExecutionPort(pairId);
    const service = new CompletionHandoffService(port);
    const closedError = new Error('active Pair Session closed');
    port.activeContextError = closedError;
    const pending = service.execute({}, toolContext(port.context.agentId));
    await port.provenanceEntered.promise;
    port.releaseProvenance.resolve();

    const rejection = await pending.catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(CompletionHandoffInfrastructureError);
    expect((rejection as Error).cause).toBe(closedError);

    port.activeContextError = undefined;
    await expect(
      service.execute({}, toolContext(port.context.agentId)),
    ).resolves.toBeUndefined();
  });

  test('does not register when the tool execution is aborted while awaiting provenance', async () => {
    const pairId = 'pair-completion-abort-await';
    const port = new DeferredExecutionPort(pairId);
    const service = new CompletionHandoffService(port);
    const controller = new AbortController();
    const execution = {
      ...toolContext(port.context.agentId),
      signal: controller.signal,
    };
    const pending = service.execute({}, execution);
    await port.provenanceEntered.promise;
    const abortReason = new Error('cancelled while awaiting provenance');
    controller.abort(abortReason);
    port.releaseProvenance.resolve();

    await expect(pending).rejects.toBe(abortReason);
    await expect(
      service.execute({}, toolContext(port.context.agentId)),
    ).resolves.toBeUndefined();
  });

  test('rejects Navigator registration', async () => {
    const pairId = 'pair-completion-navigator';
    const port = new MutableExecutionPort(pairId);
    const navigatorSessionId = createPairSessionIds(pairId).navigatorSessionId;
    port.context = {
      agentId: navigatorSessionId,
      sessionId: navigatorSessionId,
      turn: 2,
    };
    port.provenance = {
      pairId,
      senderRole: 'navigator',
      inputEvents: [durableInput(pairId, 2)],
    };
    const service = new CompletionHandoffService(port);

    await expect(service.execute({}, toolContext(navigatorSessionId))).rejects.toBeInstanceOf(
      CompletionHandoffPolicyError,
    );
  });

  test.each([
    ['different Agent and Session identities', { agentId: 'agent-other', turn: 1 }],
    ['zero Turn', { turn: 0 }],
    ['fractional Turn', { turn: 1.5 }],
  ])('rejects an invalid active Pair context: %s', async (_label, override) => {
    const pairId = 'pair-completion-context';
    const port = new MutableExecutionPort(pairId);
    port.context = { ...port.context, ...override };
    const service = new CompletionHandoffService(port);

    await expect(
      service.execute({}, toolContext(port.context.agentId)),
    ).rejects.toBeInstanceOf(CompletionHandoffInfrastructureError);
  });

  test('rejects a Pilot role that is not bound to the active Pilot Session', async () => {
    const pairId = 'pair-completion-binding';
    const port = new MutableExecutionPort(pairId);
    const navigatorSessionId = createPairSessionIds(pairId).navigatorSessionId;
    port.context = {
      agentId: navigatorSessionId,
      sessionId: navigatorSessionId,
      turn: 1,
    };
    const service = new CompletionHandoffService(port);

    await expect(
      service.execute({}, toolContext(navigatorSessionId)),
    ).rejects.toBeInstanceOf(CompletionHandoffInfrastructureError);
  });

  test.each([
    ['missing', []],
    ['cross-Pair', [durableInput('pair-other', 1)]],
  ])('rejects %s durable input provenance', async (_label, inputEvents) => {
    const pairId = 'pair-completion-provenance';
    const port = new MutableExecutionPort(pairId);
    port.provenance = { ...port.provenance, inputEvents };
    const service = new CompletionHandoffService(port);

    await expect(
      service.execute({}, toolContext(port.context.agentId)),
    ).rejects.toBeInstanceOf(CompletionHandoffPolicyError);
  });

  test.each([
    [
      'mixed root and directed messages',
      [
        durableInput('pair-completion-canonical-provenance', 1),
        directedInput(
          'pair-completion-canonical-provenance',
          2,
          'root-1',
          1,
        ),
      ],
    ],
    [
      'multiple directed roots',
      [
        directedInput(
          'pair-completion-canonical-provenance',
          1,
          'root-1',
          1,
        ),
        directedInput(
          'pair-completion-canonical-provenance',
          2,
          'root-2',
          1,
        ),
      ],
    ],
    [
      'hop overflow',
      [
        directedInput(
          'pair-completion-canonical-provenance',
          1,
          'root-1',
          4,
        ),
      ],
    ],
    [
      'ordinary agent message',
      [
        {
          ...directedInput(
            'pair-completion-canonical-provenance',
            1,
            'root-1',
            1,
          ),
          payload: {
            schemaVersion: 1,
            kind: 'turn-output',
            text: 'ordinary output',
            content: [{ type: 'text', text: 'ordinary output' }],
            completion: 'complete',
          },
        } as PairEvent,
      ],
    ],
  ] as const)('rejects non-canonical %s provenance', async (_label, inputEvents) => {
    const pairId = 'pair-completion-canonical-provenance';
    const port = new MutableExecutionPort(pairId);
    port.provenance = { ...port.provenance, inputEvents };
    const service = new CompletionHandoffService(port);

    await expect(
      service.execute({}, toolContext(port.context.agentId)),
    ).rejects.toBeInstanceOf(CompletionHandoffPolicyError);
  });

  test('wraps malformed authoritative Pair identity as an infrastructure error', async () => {
    const port = new MutableExecutionPort('pair-completion-malformed-id');
    port.provenance = { ...port.provenance, pairId: 'pair/invalid' };
    const service = new CompletionHandoffService(port);

    const rejection = await service.execute(
      {},
      toolContext(port.context.agentId),
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(CompletionHandoffInfrastructureError);
    expect((rejection as Error).cause).toBeInstanceOf(Error);
  });

  test('wraps authoritative provenance lookup failures as infrastructure errors', async () => {
    const pairId = 'pair-completion-provenance-error';
    const port = new MutableExecutionPort(pairId);
    const provenanceError = new Error('durable provenance unavailable');
    port.turnProvenance = async () => {
      throw provenanceError;
    };
    const service = new CompletionHandoffService(port);

    const rejection = await service.execute(
      {},
      toolContext(port.context.agentId),
    ).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(CompletionHandoffInfrastructureError);
    expect((rejection as Error).cause).toBe(provenanceError);
  });

  test('allows at most one successful registration per sender Session and Turn', async () => {
    const pairId = 'pair-completion-once';
    const port = new MutableExecutionPort(pairId);
    const service = new CompletionHandoffService(port);

    const results = await Promise.allSettled([
      service.execute({}, toolContext(port.context.agentId)),
      service.execute({}, toolContext(port.context.agentId)),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(CompletionHandoffPolicyError),
    });
    expect(port.provenanceContexts).toHaveLength(1);
  });

  test('propagates a queued abort before duplicate policy without reading provenance', async () => {
    const pairId = 'pair-completion-queued-abort';
    const port = new DeferredExecutionPort(pairId);
    const service = new CompletionHandoffService(port);
    const first = service.execute({}, toolContext(port.context.agentId));
    await port.provenanceEntered.promise;

    const controller = new AbortController();
    const queued = service.execute({}, {
      ...toolContext(port.context.agentId),
      callId: 'call-completion-queued',
      rootCallId: 'call-completion-queued',
      signal: controller.signal,
    });
    const abortReason = new Error('queued completion call cancelled');
    controller.abort(abortReason);
    port.releaseProvenance.resolve();

    await expect(first).resolves.toBeUndefined();
    await expect(queued).rejects.toBe(abortReason);
    expect(port.provenanceContexts).toHaveLength(1);
  });

  test('allows the same Pilot Session to register a later Turn', async () => {
    const pairId = 'pair-completion-later-turn';
    const port = new MutableExecutionPort(pairId);
    const service = new CompletionHandoffService(port);

    await service.execute({}, toolContext(port.context.agentId));
    port.context = { ...port.context, turn: 2 };
    port.provenance = {
      ...port.provenance,
      inputEvents: [durableInput(pairId, 2)],
    };

    await expect(
      service.execute({}, toolContext(port.context.agentId)),
    ).resolves.toBeUndefined();
    expect(port.provenanceContexts).toHaveLength(2);
  });

  test('retains one-success-per-current-Turn behavior across multiple later Turns', async () => {
    const pairId = 'pair-completion-many-turns';
    const port = new MutableExecutionPort(pairId);
    const service = new CompletionHandoffService(port);

    for (const turn of [1, 2, 3, 4]) {
      port.context = { ...port.context, turn };
      port.provenance = {
        ...port.provenance,
        inputEvents: [durableInput(pairId, turn)],
      };
      await expect(
        service.execute({}, toolContext(port.context.agentId)),
      ).resolves.toBeUndefined();
    }

    await expect(
      service.execute({}, toolContext(port.context.agentId)),
    ).rejects.toBeInstanceOf(CompletionHandoffPolicyError);
  });

  test('rejects an aborted call before consulting the active Pair context', async () => {
    const pairId = 'pair-completion-aborted';
    const port = new MutableExecutionPort(pairId);
    const service = new CompletionHandoffService(port);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(service.execute({}, {
      ...toolContext(port.context.agentId),
      signal: controller.signal,
    })).rejects.toThrow('cancelled');
    expect(port.executions).toEqual([]);
  });

  test('rejects non-object arguments even when the host bypasses the JSON schema', async () => {
    const pairId = 'pair-completion-runtime-args';
    const port = new MutableExecutionPort(pairId);
    const service = new CompletionHandoffService(port);

    await expect(
      service.execute([] as unknown as JsonObject, toolContext(port.context.agentId)),
    ).rejects.toBeInstanceOf(CompletionHandoffPolicyError);
  });
});
