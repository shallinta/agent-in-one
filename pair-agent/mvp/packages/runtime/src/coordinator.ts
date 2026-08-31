import {
  type AssignPairTaskRequest,
  assertJsonObject,
  parsePairId,
  type DshBuildRef,
  type GetPairResponse,
  type JsonObject,
  type PairEvent,
  type PairRole,
  type SendPairMessageRequest,
  type SendPairMessageResponse,
} from '@pair-agent/contracts';
import { JsonlPairLedgerStore } from '@pair-agent/ledger';

import {
  PairRegistry,
  type AgentAdapter,
  type PairCreationResult,
  type PairProjectionListener,
} from './pair-registry.js';

const MAX_TEXT_BYTES = 64 * 1024;

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
          payload: { text },
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
