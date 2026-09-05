import {
  createPairSessionIds,
  parsePairId,
  type JsonObject,
} from '@pair-agent/contracts';

import {
  CanonicalDirectedCausalityError,
  deriveCanonicalDirectedCausality,
} from './canonical-directed-causality.js';
import type {
  PeerMessageExecutionPort,
  PeerMessageServiceContext,
  PeerMessageToolExecutionContext,
} from './peer-message.js';

const REGISTRATION_ACKNOWLEDGEMENT =
  'Completion handoff registered for this Pilot Turn. Provide the complete final report now; Navigator will be notified only after the Turn is durably completed.';

export class CompletionHandoffInfrastructureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CompletionHandoffInfrastructureError';
  }
}

export class CompletionHandoffPolicyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CompletionHandoffPolicyError';
  }
}

export interface CompletionHandoffToolDefinition {
  readonly name: 'pair_report_completion';
  readonly description:
    "Register this Pilot Turn's final public answer for delivery to Navigator after durable turn completion.";
  readonly parameters: JsonObject;
  execute(
    args: JsonObject,
    context: PeerMessageToolExecutionContext,
  ): Promise<readonly JsonObject[]>;
}

function validateArgs(args: JsonObject): void {
  if (
    typeof args !== 'object' ||
    args === null ||
    Array.isArray(args) ||
    (Object.getPrototypeOf(args) !== Object.prototype &&
      Object.getPrototypeOf(args) !== null) ||
    Object.getOwnPropertyNames(args).length !== 0 ||
    Object.getOwnPropertySymbols(args).length !== 0
  ) {
    throw new CompletionHandoffPolicyError(
      'Completion handoff arguments must be an exact empty object',
    );
  }
}

function turnKey(context: PeerMessageServiceContext): string {
  return `${context.sessionId}\0${String(context.turn)}`;
}

export class CompletionHandoffService {
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #lastSuccessfulTurnBySession = new Map<string, number>();

  constructor(readonly executionPort: PeerMessageExecutionPort) {}

  async execute(
    args: JsonObject,
    execution: PeerMessageToolExecutionContext,
  ): Promise<void> {
    execution.signal.throwIfAborted();
    validateArgs(args);
    let context: PeerMessageServiceContext;
    try {
      context = this.executionPort.activeContext(execution);
    } catch (error) {
      execution.signal.throwIfAborted();
      if (
        error instanceof CompletionHandoffInfrastructureError ||
        error instanceof CompletionHandoffPolicyError
      ) {
        throw error;
      }
      throw new CompletionHandoffInfrastructureError(
        'Completion handoff could not resolve the active Pair context',
        { cause: error },
      );
    }
    await this.register(context, execution);
  }

  register(
    context: PeerMessageServiceContext,
    execution: PeerMessageToolExecutionContext,
  ): Promise<void> {
    const key = turnKey(context);
    const prior = this.#tails.get(key) ?? Promise.resolve();
    const operation = prior
      .catch(() => undefined)
      .then(async () => {
        execution.signal.throwIfAborted();
        if (
          this.#lastSuccessfulTurnBySession.get(context.sessionId) ===
          context.turn
        ) {
          throw new CompletionHandoffPolicyError(
            'Completion handoff was already registered for this Pilot Turn',
          );
        }
        await this.#register(context, execution);
        this.#lastSuccessfulTurnBySession.set(context.sessionId, context.turn);
      });
    this.#tails.set(key, operation);
    return operation.finally(() => {
      if (this.#tails.get(key) === operation) this.#tails.delete(key);
    });
  }

  async #register(
    context: PeerMessageServiceContext,
    execution: PeerMessageToolExecutionContext,
  ): Promise<void> {
    try {
      if (
        context.agentId !== context.sessionId ||
        !Number.isSafeInteger(context.turn) ||
        context.turn <= 0
      ) {
        throw new CompletionHandoffInfrastructureError(
          'Completion handoff active Agent, Session, or Turn identity is invalid',
        );
      }

      const provenance = await this.executionPort.turnProvenance(context);
      execution.signal.throwIfAborted();
      const current = this.executionPort.activeContext(execution);
      if (
        current.agentId !== context.agentId ||
        current.sessionId !== context.sessionId ||
        current.turn !== context.turn
      ) {
        throw new CompletionHandoffInfrastructureError(
          'Completion handoff active Pair context changed while awaiting durable provenance',
        );
      }

      const pairId = parsePairId(provenance.pairId);
      if (provenance.senderRole !== 'pilot') {
        throw new CompletionHandoffPolicyError(
          'Completion handoff may be registered only by Pilot',
        );
      }
      const expectedSessionId = createPairSessionIds(pairId).pilotSessionId;
      if (expectedSessionId !== context.sessionId) {
        throw new CompletionHandoffInfrastructureError(
          'Completion handoff Pilot role is not bound to the active Session',
        );
      }
      try {
        deriveCanonicalDirectedCausality(pairId, provenance.inputEvents);
      } catch (error) {
        if (error instanceof CanonicalDirectedCausalityError) {
          throw new CompletionHandoffPolicyError(error.message, { cause: error });
        }
        throw error;
      }
    } catch (error) {
      execution.signal.throwIfAborted();
      if (
        error instanceof CompletionHandoffInfrastructureError ||
        error instanceof CompletionHandoffPolicyError
      ) {
        throw error;
      }
      throw new CompletionHandoffInfrastructureError(
        'Completion handoff authoritative Pair context validation failed',
        { cause: error },
      );
    }
  }
}

export class CompletionHandoffRouter {
  #service?: CompletionHandoffService;
  readonly #definition: CompletionHandoffToolDefinition;

  constructor() {
    this.#definition = {
      name: 'pair_report_completion',
      description:
        "Register this Pilot Turn's final public answer for delivery to Navigator after durable turn completion.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      execute: async (args, context) => {
        const service = this.#service;
        if (service === undefined) {
          throw new CompletionHandoffInfrastructureError(
            'Completion handoff service is not bound before Pair Agent execution',
          );
        }
        await service.execute(args, context);
        return [{ type: 'text', text: REGISTRATION_ACKNOWLEDGEMENT }];
      },
    };
  }

  toolDefinition(): CompletionHandoffToolDefinition {
    return this.#definition;
  }

  bind(service: CompletionHandoffService): void {
    if (this.#service !== undefined && this.#service !== service) {
      throw new CompletionHandoffInfrastructureError(
        'Completion handoff router is already bound to another service',
      );
    }
    this.#service = service;
  }
}
