import {
  createPairSessionIds,
  MAX_PAIR_MESSAGE_BYTES,
  parsePairId,
  type JsonObject,
  type PairEvent,
  type PairRole,
} from '@pair-agent/contracts';

import {
  CanonicalDirectedCausalityError,
  deriveCanonicalDirectedCausality,
} from './canonical-directed-causality.js';
import { isCanonicalDirectedPeerMessage } from './peer-message-event.js';
import {
  DeliveryPendingError,
  InvalidCommandError,
  PairCoordinator,
  type DeliveryResult,
} from './coordinator.js';

export interface PeerMessageToolExecutionContext {
  readonly agentId?: string;
  readonly callId: string;
  readonly rootCallId: string;
  readonly signal: AbortSignal;
}

export interface PeerMessageServiceContext {
  readonly agentId: string;
  readonly sessionId: string;
  readonly turn: number;
}

export interface PeerMessageTurnProvenance {
  readonly pairId: string;
  readonly senderRole: PairRole;
  readonly inputEvents: readonly PairEvent[];
}

export interface PeerMessageExecutionPort {
  activeContext(execution: PeerMessageToolExecutionContext): PeerMessageServiceContext;
  turnProvenance(
    context: PeerMessageServiceContext,
  ): Promise<PeerMessageTurnProvenance>;
}

export interface PeerMessageArgs {
  readonly text: string;
  readonly expectsReply?: true;
  readonly replyTo?: string;
}

export type PeerMessageSendResult =
  | (DeliveryResult & { readonly status: 'delivered' })
  | {
      readonly status: 'pending';
      readonly acceptedAtLedgerHead: number;
      readonly deliveryId: string;
      readonly error: string;
    };

export class PeerMessageInfrastructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PeerMessageInfrastructureError';
  }
}

export class PeerMessagePolicyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PeerMessagePolicyError';
  }
}

export interface PeerMessageToolDefinition {
  readonly name: 'pair_message_peer';
  readonly description: 'Send one bounded message to the other Pair Agent and wake it.';
  readonly parameters: JsonObject;
  execute(
    args: JsonObject,
    context: PeerMessageToolExecutionContext,
  ): Promise<readonly JsonObject[]>;
}

function validateArgs(args: JsonObject): PeerMessageArgs {
  const allowedKeys = new Set(['text', 'expectsReply', 'replyTo']);
  if (
    typeof args !== 'object' ||
    args === null ||
    Array.isArray(args) ||
    !Object.keys(args).every((key) => allowedKeys.has(key)) ||
    !Object.hasOwn(args, 'text')
  ) {
    throw new PeerMessagePolicyError(
      'Peer Message arguments may contain only text, expectsReply, and replyTo',
    );
  }
  const text = args.text;
  if (
    typeof text !== 'string' ||
    text.trim().length === 0 ||
    Buffer.byteLength(text, 'utf8') > MAX_PAIR_MESSAGE_BYTES
  ) {
    throw new PeerMessagePolicyError(
      `Peer Message text must be non-empty and at most ${MAX_PAIR_MESSAGE_BYTES} UTF-8 bytes`,
    );
  }
  if (
    args.expectsReply !== undefined &&
    typeof args.expectsReply !== 'boolean'
  ) {
    throw new PeerMessagePolicyError('Peer Message expectsReply must be boolean');
  }
  if (
    args.replyTo !== undefined &&
    (typeof args.replyTo !== 'string' ||
      args.replyTo.trim() === '' ||
      args.replyTo.length > 160)
  ) {
    throw new PeerMessagePolicyError(
      'Peer Message replyTo must be a non-empty Pair Event ID of at most 160 characters',
    );
  }
  if (args.expectsReply === true && args.replyTo !== undefined) {
    throw new PeerMessagePolicyError(
      'A Peer Message reply cannot request another reply',
    );
  }
  return {
    text,
    ...(args.expectsReply === true ? { expectsReply: true } : {}),
    ...(typeof args.replyTo === 'string' ? { replyTo: args.replyTo } : {}),
  };
}

function validateReplyBinding(
  provenance: PeerMessageTurnProvenance,
  replyTo: string | undefined,
): void {
  if (replyTo === undefined) return;
  const matches = provenance.inputEvents.filter(
    (event) =>
      `${event.pairId}:${String(event.seq)}` === replyTo &&
      isCanonicalDirectedPeerMessage(event) &&
      event.channel === provenance.senderRole &&
      event.payload.expectsReply === true,
  );
  if (matches.length !== 1) {
    throw new PeerMessagePolicyError(
      'Peer Message replyTo must identify the current reply-required Peer request',
    );
  }
}

function pendingMessage(error: DeliveryPendingError): string {
  const cause = error.cause;
  return cause instanceof Error && cause.message.length > 0
    ? cause.message.slice(0, 4096)
    : 'receiver delivery failed';
}

function deriveCausality(
  provenance: PeerMessageTurnProvenance,
): { readonly causalRootId: string; readonly hop: number } {
  const pairId = parsePairId(provenance.pairId);
  try {
    return deriveCanonicalDirectedCausality(pairId, provenance.inputEvents);
  } catch (error) {
    if (error instanceof CanonicalDirectedCausalityError) {
      throw new PeerMessagePolicyError(error.message, { cause: error });
    }
    throw error;
  }
}

export class PeerMessageService {
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #deliveredTurnBySession = new Map<string, number>();

  constructor(
    readonly coordinator: PairCoordinator,
    readonly executionPort: PeerMessageExecutionPort,
  ) {}

  execute(
    args: JsonObject,
    execution: PeerMessageToolExecutionContext,
  ): Promise<PeerMessageSendResult> {
    execution.signal.throwIfAborted();
    const context = this.executionPort.activeContext(execution);
    return this.send(context, args);
  }

  send(
    context: PeerMessageServiceContext,
    args: JsonObject,
  ): Promise<PeerMessageSendResult> {
    const key = `${context.sessionId}\0${String(context.turn)}`;
    const prior = this.#tails.get(key) ?? Promise.resolve();
    const operation = prior
      .catch(() => undefined)
      .then(async () => {
        if (this.#deliveredTurnBySession.get(context.sessionId) === context.turn) {
          throw new PeerMessagePolicyError(
            'Peer Message was already delivered successfully for this sender Turn',
          );
        }
        const result = await this.#send(context, args);
        if (result.status === 'delivered') {
          this.#deliveredTurnBySession.set(context.sessionId, context.turn);
        }
        return result;
      });
    this.#tails.set(key, operation);
    return operation.finally(() => {
      if (this.#tails.get(key) === operation) this.#tails.delete(key);
    });
  }

  async #send(
    context: PeerMessageServiceContext,
    args: JsonObject,
  ): Promise<PeerMessageSendResult> {
    const { text, expectsReply, replyTo } = validateArgs(args);
    if (
      context.agentId !== context.sessionId ||
      !Number.isSafeInteger(context.turn) ||
      context.turn <= 0
    ) {
      throw new PeerMessageInfrastructureError(
        'Peer Message active Agent, Session, or Turn identity is invalid',
      );
    }
    const provenance = await this.executionPort.turnProvenance(context);
    const pairId = parsePairId(provenance.pairId);
    const ids = createPairSessionIds(pairId);
    const expectedSessionId = provenance.senderRole === 'navigator'
      ? ids.navigatorSessionId
      : ids.pilotSessionId;
    if (expectedSessionId !== context.sessionId) {
      throw new PeerMessageInfrastructureError(
        'Peer Message sender role is not bound to the active Session',
      );
    }
    validateReplyBinding(provenance, replyTo);
    const { causalRootId, hop } = deriveCausality(provenance);
    const sourceIdentity =
      `dsh:${context.sessionId}:turn:${String(context.turn)}:peer-message`;
    try {
      const delivered = await this.coordinator.sendPeerMessage({
        pairId,
        senderRole: provenance.senderRole,
        senderSessionId: context.sessionId,
        senderTurn: context.turn,
        sourceIdentity,
        text,
        causalRootId,
        hop,
        ...(expectsReply === true ? { expectsReply: true } : {}),
        ...(replyTo === undefined ? {} : { replyTo }),
      });
      return { ...delivered, status: 'delivered' };
    } catch (error) {
      if (error instanceof InvalidCommandError) {
        throw new PeerMessagePolicyError(error.message, { cause: error });
      }
      if (!(error instanceof DeliveryPendingError)) throw error;
      return {
        status: 'pending',
        acceptedAtLedgerHead: error.acceptedAtLedgerHead,
        deliveryId: error.deliveryId,
        error: pendingMessage(error),
      };
    }
  }
}

export class PeerMessageRouter {
  #service?: PeerMessageService;
  readonly #definition: PeerMessageToolDefinition;

  constructor() {
    this.#definition = {
      name: 'pair_message_peer',
      description: 'Send one bounded message to the other Pair Agent and wake it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', minLength: 1, maxLength: 65_536 },
          expectsReply: { type: 'boolean' },
          replyTo: { type: 'string', minLength: 1, maxLength: 160 },
        },
      },
      execute: async (args, context) => {
        const service = this.#service;
        if (service === undefined) {
          throw new PeerMessageInfrastructureError(
            'Peer Message service is not bound before Pair Agent execution',
          );
        }
        const result = await service.execute(args, context);
        const text = result.status === 'delivered'
          ? `Peer message delivered (${result.deliveryId}).`
          : `Peer message is durable but delivery is pending (${result.deliveryId}): ${result.error}`;
        return [{ type: 'text', text }];
      },
    };
  }

  toolDefinition(): PeerMessageToolDefinition {
    return this.#definition;
  }

  bind(service: PeerMessageService): void {
    if (this.#service !== undefined && this.#service !== service) {
      throw new PeerMessageInfrastructureError(
        'Peer Message router is already bound to another service',
      );
    }
    this.#service = service;
  }
}
