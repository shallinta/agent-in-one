import {
  type AssignPairTaskRequest,
  assertJsonObject,
  canonicalJsonStringify,
  createPairSessionIds,
  isPeerAgentMessage,
  MAX_PEER_HOPS,
  parsePairId,
  type DshBuildRef,
  type GetPairResponse,
  type JsonObject,
  type ListPairSessionEventsQuery,
  type ListPairSessionEventsResponse,
  type PairEvent,
  type PairEventType,
  type PairRole,
  type SendPairMessageRequest,
  type SendPairMessageResponse,
} from '@pair-agent/contracts';
import { JsonlPairLedgerStore, paginatePairEvents } from '@pair-agent/ledger';

import {
  PairRegistry,
  type AgentAdapter,
  type PairCreationResult,
  type PairProjectionListener,
} from './pair-registry.js';

const MAX_TEXT_BYTES = 64 * 1024;

const SEMANTIC_PAIR_EVENT_TYPES: ReadonlySet<PairEventType> = new Set([
  'user.message',
  'agent.message',
  'goal.committed',
  'goal.revised',
  'task.assigned',
  'task.revised',
  'task.state_changed',
  'execution_plan.updated',
  'attention.requested',
  'attention.cleared',
  'pair.paused',
  'pair.resumed',
  'artifact.recorded',
]);

export function isSemanticPairEvent(event: PairEvent): boolean {
  return SEMANTIC_PAIR_EVENT_TYPES.has(event.type);
}

export class InvalidCommandError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidCommandError';
  }
}

export class DeliveryPendingError extends Error {
  readonly pairId: string;
  readonly acceptedAtLedgerHead: number;
  readonly deliveryId: string;

  constructor(
    pairId: string,
    acceptedAtLedgerHead: number,
    deliveryId: string,
    options?: ErrorOptions,
  ) {
    super(`Pair event ${deliveryId} is durable but Agent delivery is pending`, options);
    this.name = 'DeliveryPendingError';
    this.pairId = pairId;
    this.acceptedAtLedgerHead = acceptedAtLedgerHead;
    this.deliveryId = deliveryId;
  }
}

export interface CreatePairCommand {
  pairId: string;
  dshBuild: DshBuildRef;
  expectedLedgerHead: number;
}

export interface SendMessageCommand extends SendPairMessageRequest {
  pairId: string;
}

export interface AssignTaskCommand extends AssignPairTaskRequest {
  pairId: string;
}

export interface SendPeerMessageCommand {
  readonly pairId: string;
  readonly senderRole: PairRole;
  readonly senderSessionId: string;
  readonly senderTurn: number;
  readonly sourceIdentity: string;
  readonly text: string;
  readonly causalRootId: string;
  readonly hop: number;
}

export interface DeliveryResult extends SendPairMessageResponse {
  delivery: 'delivered';
}

export function pairEventId(event: Pick<PairEvent, 'pairId' | 'seq'>): string {
  return `${event.pairId}:${event.seq}`;
}

function validateText(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES
  ) {
    throw new InvalidCommandError(
      `${label} must be non-empty and at most ${MAX_TEXT_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

function jsonSafe(value: unknown, label: string): void {
  try {
    assertJsonObject(value);
  } catch (error) {
    throw new InvalidCommandError(`${label} must be JSON-safe`, { cause: error });
  }
}

export class PairCoordinator {
  constructor(
    readonly registry: PairRegistry,
    readonly store: JsonlPairLedgerStore,
    readonly adapter: AgentAdapter,
  ) {}

  async createPair(command: CreatePairCommand): Promise<PairCreationResult> {
    return this.registry.createPair(command);
  }

  async getPair(pairId: string): Promise<GetPairResponse> {
    const ready = await this.registry.getReadyPair(pairId);
    return { projection: ready.projection, panes: ready.panes };
  }

  async listSessionEvents(
    pairIdInput: string,
    query: ListPairSessionEventsQuery,
  ): Promise<ListPairSessionEventsResponse> {
    const pairId = parsePairId(pairIdInput);
    return this.registry.readSnapshot(pairId, ({ projection, events }) => {
      const page = paginatePairEvents(events, {
        ...query,
        include: query.view === 'all' ? undefined : isSemanticPairEvent,
      });
      return {
        pairId,
        throughLedgerHead: projection.header.ledgerHead,
        sharedHead: projection.header.sharedHead,
        events: page.events,
        nextAfterSeq: page.nextAfterSeq,
        hasMore: page.hasMore,
      };
    });
  }

  async sendNavigator(command: SendMessageCommand): Promise<DeliveryResult> {
    return this.#sendMessage('navigator', command);
  }

  async sendPilot(command: SendMessageCommand): Promise<DeliveryResult> {
    return this.#sendMessage('pilot', command);
  }

  async assignTask(command: AssignTaskCommand): Promise<DeliveryResult> {
    const pairId = parsePairId(command.pairId);
    jsonSafe(
      {
        task: command.task,
        ...(command.goalRef === undefined ? {} : { goalRef: command.goalRef }),
      },
      'task command',
    );
    return this.registry.runPairMutation(
      pairId,
      command.expectedLedgerHead,
      async ({ projection, ready, append }) => {
        if (projection.task !== undefined) {
          throw new InvalidCommandError(
            'Phase 0 supports only the initial task assignment',
          );
        }
        const taskId = validateText(command.task.id, 'task.id');
        const summary = validateText(command.task.summary, 'task.summary');
        const expectedRevision = 1;
        if (command.task.revision !== expectedRevision) {
          throw new InvalidCommandError(
            `Task revision must be ${expectedRevision}`,
          );
        }
        if (command.task.state !== 'queued') {
          throw new InvalidCommandError('Initial task state must be queued');
        }
        if (command.goalRef !== undefined) {
          validateText(command.goalRef.id, 'goalRef.id');
          if (
            !Number.isSafeInteger(command.goalRef.version) ||
            command.goalRef.version <= 0
          ) {
            throw new InvalidCommandError(
              'goalRef.version must be a positive integer',
            );
          }
        }
        const task = {
          id: taskId,
          revision: expectedRevision,
          summary,
          state: 'queued',
        } as const;
        const event = await append({
          type: 'task.assigned',
          actor: { kind: 'agent', role: 'navigator' },
          source: 'navigator-session',
          channel: 'shared-control',
          visibility: 'shared',
          authority: 'navigator',
          refs: {
            task: { id: taskId, revision: task.revision },
            ...(command.goalRef === undefined
              ? {}
              : { goal: command.goalRef }),
          },
          payload: { task },
        });
        return this.#deliver(pairId, ready.panes[1].sessionId, event, {
          kind: 'task.assigned',
          pairEventId: pairEventId(event),
          task,
        });
      },
    );
  }

  async sendPeerMessage(command: SendPeerMessageCommand): Promise<DeliveryResult> {
    const pairId = parsePairId(command.pairId);
    const text = validateText(command.text, 'text');
    const ids = createPairSessionIds(pairId);
    const expectedSenderSessionId = command.senderRole === 'navigator'
      ? ids.navigatorSessionId
      : ids.pilotSessionId;
    if (command.senderSessionId !== expectedSenderSessionId) {
      throw new InvalidCommandError('Peer sender Session does not match its Pair role');
    }
    if (!Number.isSafeInteger(command.senderTurn) || command.senderTurn <= 0) {
      throw new InvalidCommandError('Peer sender Turn must be a positive integer');
    }
    const expectedSourceIdentity =
      `dsh:${command.senderSessionId}:turn:${String(command.senderTurn)}:peer-message`;
    if (command.sourceIdentity !== expectedSourceIdentity) {
      throw new InvalidCommandError('Peer source identity is not canonical for the sender Turn');
    }
    if (typeof command.causalRootId !== 'string' || command.causalRootId.length === 0) {
      throw new InvalidCommandError('Peer causal root must be non-empty');
    }
    if (
      !Number.isSafeInteger(command.hop) ||
      command.hop < 1 ||
      command.hop > MAX_PEER_HOPS
    ) {
      throw new InvalidCommandError(`Peer hop must be between 1 and ${MAX_PEER_HOPS}`);
    }

    const receiverRole: PairRole =
      command.senderRole === 'navigator' ? 'pilot' : 'navigator';
    const receiverSessionId = receiverRole === 'navigator'
      ? ids.navigatorSessionId
      : ids.pilotSessionId;
    const source = command.senderRole === 'navigator'
      ? 'navigator-session' as const
      : 'pilot-session' as const;

    return this.registry.runDerivedMutation(pairId, async ({ events, appendDerived }) => {
      const prior = events.filter(
        (event) => event.refs.sourceEventIds?.includes(command.sourceIdentity),
      );
      if (prior.length > 1) {
        throw new InvalidCommandError(
          'Peer sender Turn has multiple durable semantic messages',
        );
      }
      const event = prior[0] ?? await appendDerived({
        type: 'agent.message',
        actor: { kind: 'agent', role: command.senderRole },
        source,
        channel: receiverRole,
        visibility: 'shared',
        authority: command.senderRole,
        refs: { sourceEventIds: [command.sourceIdentity] },
        payload: {
          schemaVersion: 1,
          kind: 'peer-message',
          text,
          content: [{ type: 'text', text }],
          causalRootId: command.causalRootId,
          hop: command.hop,
        },
      });
      if (
        !isPeerAgentMessage(event) ||
        event.type !== 'agent.message' ||
        event.actor.kind !== 'agent' ||
        event.actor.role !== command.senderRole ||
        event.source !== source ||
        event.channel !== receiverRole ||
        event.visibility !== 'shared' ||
        event.authority !== command.senderRole ||
        event.refs.sourceEventIds?.length !== 1 ||
        event.payload.kind !== 'peer-message' ||
        event.payload.text !== text ||
        canonicalJsonStringify(event.payload.content) !==
          canonicalJsonStringify([{ type: 'text', text }]) ||
        event.payload.causalRootId !== command.causalRootId ||
        event.payload.hop !== command.hop
      ) {
        throw new InvalidCommandError(
          'Peer sender Turn already owns a different durable semantic message',
        );
      }
      return this.#deliver(pairId, receiverSessionId, event, {
        kind: 'agent.message',
        role: receiverRole,
        text,
        pairEventId: pairEventId(event),
        causalRootId: command.causalRootId,
        hop: command.hop,
      });
    });
  }

  subscribe(pairId: string, listener: PairProjectionListener): () => void {
    return this.registry.subscribe(pairId, listener);
  }

  subscriberCount(pairId: string): number {
    return this.registry.subscriberCount(pairId);
  }

  close(): Promise<void> {
    return this.registry.close();
  }

  async #sendMessage(
    role: PairRole,
    command: SendMessageCommand,
  ): Promise<DeliveryResult> {
    const pairId = parsePairId(command.pairId);
    const text = validateText(command.text, 'text');
    return this.registry.runPairMutation(
      pairId,
      command.expectedLedgerHead,
      async ({ ready, append }) => {
        const event = await append({
          type: 'user.message',
          actor: { kind: 'user' },
          source: 'pair',
          channel: role,
          visibility: 'shared',
          authority: 'user',
          refs: {},
          payload: {
            schemaVersion: 1,
            kind: 'user-input',
            text,
            content: [{ type: 'text', text }],
          },
        });
        const pane = ready.panes.find((candidate) => candidate.role === role)!;
        return this.#deliver(pairId, pane.sessionId, event, {
          kind: 'user.message',
          role,
          text,
          pairEventId: pairEventId(event),
        });
      },
    );
  }

  async #deliver(
    pairId: string,
    sessionId: string,
    event: PairEvent,
    trigger: JsonObject,
  ): Promise<DeliveryResult> {
    const deliveryId = pairEventId(event);
    try {
      await this.adapter.followup({ sessionId, deliveryId, trigger });
    } catch (error) {
      throw new DeliveryPendingError(pairId, event.seq, deliveryId, {
        cause: error,
      });
    }
    return {
      acceptedAtLedgerHead: event.seq,
      deliveryId,
      delivery: 'delivered',
    };
  }
}
