import { createHash } from 'node:crypto';

import {
  assertJsonObject,
  canonicalJsonStringify,
  type JsonObject,
  type JsonValue,
  type PairAttention,
  type PairEvent,
  type PairExecutionPlan,
  type PairGoal,
  type PairId,
  type PairPause,
  type PairProjection,
  type PairTask,
} from '@pair-agent/contracts';

export type NormalizedMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface NormalizedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export type NormalizedMessage =
  | {
      readonly role: 'system' | 'user';
      readonly content: JsonValue;
      readonly name?: string;
      readonly toolCallId?: never;
      readonly toolCalls?: never;
    }
  | {
      readonly role: 'assistant';
      readonly content: JsonValue;
      readonly name?: string;
      readonly toolCallId?: never;
      readonly toolCalls?: readonly NormalizedToolCall[];
    }
  | {
      readonly role: 'tool';
      readonly content: JsonValue;
      readonly toolCallId: string;
      readonly name?: never;
      readonly toolCalls?: never;
    };

export interface CommonSystemDefinition {
  version: string;
  content: string;
}

export interface BuildSharedContextOptions {
  commonSystem: CommonSystemDefinition;
  sharedEventContextFormat: SharedEventContextFormat;
}

export const SHARED_EVENT_CONTEXT_FULL_V1 = 'pair-event-context/full-v1';
export const SHARED_EVENT_CONTEXT_TEXT_DEDUP_V1 =
  'pair-event-context/text-dedup-v1';

export type SharedEventContextFormat =
  | typeof SHARED_EVENT_CONTEXT_FULL_V1
  | typeof SHARED_EVENT_CONTEXT_TEXT_DEDUP_V1;

export interface SharedProjection {
  readonly schemaVersion: 1;
  readonly pairId: PairId;
  readonly sharedHead: number;
  readonly sessions: {
    readonly navigatorSessionId: string;
    readonly pilotSessionId: string;
  };
  readonly goal?: PairGoal;
  readonly task?: PairTask;
  readonly executionPlan?: PairExecutionPlan;
  readonly attention: PairAttention;
  readonly pause: PairPause;
}

export class InvalidNormalizedMessageError extends TypeError {
  constructor(message: string) {
    super(`Invalid normalized message: ${message}`);
    this.name = 'InvalidNormalizedMessageError';
  }
}

export class SharedContextInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SharedContextInvariantError';
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SharedContextInvariantError(message);
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidNormalizedMessageError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new InvalidNormalizedMessageError(
      `${label} contains unknown field ${unknown[0]}`,
    );
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidNormalizedMessageError(`${label} must be a non-empty string`);
  }
  return value;
}

export function canonicalJsonClone<T extends JsonValue>(value: T): T {
  return JSON.parse(canonicalJsonStringify(value)) as T;
}

export function deepFreezeJson<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreezeJson(nested);
  }
  return Object.freeze(value);
}

export function normalizeMessage(input: unknown): NormalizedMessage {
  const clonedInput = JSON.parse(canonicalJsonStringify(input)) as unknown;
  const message = plainRecord(clonedInput, 'message');
  rejectUnknownKeys(
    message,
    new Set(['role', 'content', 'name', 'toolCallId', 'toolCalls']),
    'message',
  );
  if (
    message.role !== 'system' &&
    message.role !== 'user' &&
    message.role !== 'assistant' &&
    message.role !== 'tool'
  ) {
    throw new InvalidNormalizedMessageError('role is invalid');
  }
  if (!Object.hasOwn(message, 'content')) {
    throw new InvalidNormalizedMessageError('content is required');
  }

  const content = message.content as JsonValue;
  const readToolCalls = (): readonly NormalizedToolCall[] => {
    if (!Array.isArray(message.toolCalls) || message.toolCalls.length === 0) {
      throw new InvalidNormalizedMessageError('toolCalls must be a non-empty array');
    }
    return message.toolCalls.map((inputCall, index) => {
      const call = plainRecord(inputCall, `toolCalls[${index}]`);
      rejectUnknownKeys(
        call,
        new Set(['id', 'name', 'arguments']),
        `toolCalls[${index}]`,
      );
      assertJsonObject(call.arguments);
      return {
        id: nonEmptyString(call.id, `toolCalls[${index}].id`),
        name: nonEmptyString(call.name, `toolCalls[${index}].name`),
        arguments: call.arguments,
      };
    });
  };

  switch (message.role) {
    case 'system':
    case 'user': {
      if (message.toolCallId !== undefined) {
        throw new InvalidNormalizedMessageError(
          `${message.role} message cannot contain toolCallId`,
        );
      }
      if (message.toolCalls !== undefined) {
        throw new InvalidNormalizedMessageError(
          `${message.role} message cannot contain toolCalls`,
        );
      }
      return deepFreezeJson({
        role: message.role,
        content,
        ...(message.name === undefined
          ? {}
          : { name: nonEmptyString(message.name, 'name') }),
      });
    }
    case 'assistant': {
      if (message.toolCallId !== undefined) {
        throw new InvalidNormalizedMessageError(
          'assistant message cannot contain toolCallId',
        );
      }
      return deepFreezeJson({
        role: 'assistant',
        content,
        ...(message.name === undefined
          ? {}
          : { name: nonEmptyString(message.name, 'name') }),
        ...(message.toolCalls === undefined
          ? {}
          : { toolCalls: readToolCalls() }),
      });
    }
    case 'tool': {
      if (message.name !== undefined) {
        throw new InvalidNormalizedMessageError(
          'tool message cannot contain name',
        );
      }
      if (message.toolCalls !== undefined) {
        throw new InvalidNormalizedMessageError(
          'tool message cannot contain toolCalls',
        );
      }
      return deepFreezeJson({
        role: 'tool',
        content,
        toolCallId: nonEmptyString(message.toolCallId, 'tool message toolCallId'),
      });
    }
  }
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function positiveSafeInteger(value: number, label: string): void {
  invariant(
    Number.isSafeInteger(value) && value > 0,
    `${label} must be a positive safe integer`,
  );
}

export function serializeSharedEvents(
  events: readonly PairEvent[],
  sharedHead: number,
  format: SharedEventContextFormat,
): string {
  positiveSafeInteger(sharedHead, 'sharedHead');
  invariant(events.length > 0, 'shared events must not be empty');
  invariant(
    format === SHARED_EVENT_CONTEXT_FULL_V1 ||
      format === SHARED_EVENT_CONTEXT_TEXT_DEDUP_V1,
    `unsupported shared event context format ${String(format)}`,
  );

  let previousSeq = 0;
  let pairId: string | undefined;
  const lines = events.map((event) => {
    canonicalJsonStringify(event);
    invariant(
      event.visibility === 'shared',
      `event seq ${event.seq} must have visibility=shared`,
    );
    positiveSafeInteger(event.seq, 'event seq');
    invariant(
      event.seq > previousSeq,
      `event seq must be strictly increasing; found ${event.seq} after ${previousSeq}`,
    );
    invariant(
      event.seq <= sharedHead,
      `event seq ${event.seq} exceeds sharedHead ${sharedHead}`,
    );
    if (pairId === undefined) pairId = event.pairId;
    invariant(event.pairId === pairId, 'all shared events must have the same pairId');
    previousSeq = event.seq;
    if (format === SHARED_EVENT_CONTEXT_FULL_V1) {
      return canonicalJsonStringify(event);
    }
    const projected = JSON.parse(canonicalJsonStringify(event)) as JsonObject;
    const payload = projected.payload;
    if (
      typeof payload === 'object' &&
      payload !== null &&
      !Array.isArray(payload)
    ) {
      const payloadObject = payload as Record<string, JsonValue>;
      if (
        typeof payloadObject.text === 'string' &&
        Array.isArray(payloadObject.content) &&
        canonicalJsonStringify(payloadObject.content) ===
          canonicalJsonStringify([{ type: 'text', text: payloadObject.text }])
      ) {
        delete payloadObject.content;
      }
    }
    return canonicalJsonStringify(projected);
  });

  invariant(
    previousSeq === sharedHead,
    `shared events must end at sharedHead ${sharedHead}; found ${previousSeq}`,
  );
  const eventBytes = lines.join('\n');
  const schema =
    format === SHARED_EVENT_CONTEXT_FULL_V1
      ? 'pair-events/v1'
      : SHARED_EVENT_CONTEXT_TEXT_DEDUP_V1;
  return [
    `<pair-session-events schema="${schema}" pair-id="${pairId}" from-seq="${events[0]?.seq}">`,
    eventBytes,
    `<pair-events-watermark shared-head="${sharedHead}" digest="${sha256(eventBytes)}" />`,
    '</pair-session-events>',
  ].join('\n');
}

export function buildSharedProjection(
  projection: PairProjection,
): SharedProjection {
  canonicalJsonStringify(projection);
  positiveSafeInteger(projection.header.sharedHead, 'projection sharedHead');
  const shared: SharedProjection = {
    schemaVersion: projection.header.schemaVersion,
    pairId: projection.header.pairId,
    sharedHead: projection.header.sharedHead,
    sessions: {
      navigatorSessionId: projection.header.navigatorSessionId,
      pilotSessionId: projection.header.pilotSessionId,
    },
    ...(projection.goal === undefined ? {} : { goal: projection.goal }),
    ...(projection.task === undefined ? {} : { task: projection.task }),
    ...(projection.executionPlan === undefined
      ? {}
      : { executionPlan: projection.executionPlan }),
    attention: projection.attention,
    pause: projection.pause,
  };
  return deepFreezeJson(
    canonicalJsonClone(
      shared as unknown as JsonValue,
    ) as unknown as SharedProjection,
  );
}

export function serializeSharedProjection(projection: PairProjection): string {
  const shared = buildSharedProjection(projection);
  return [
    `<pair-projection schema="pair-projection/v1" pair-id="${shared.pairId}" shared-head="${shared.sharedHead}">`,
    canonicalJsonStringify(shared),
    '</pair-projection>',
  ].join('\n');
}

export function buildSharedContext(
  events: readonly PairEvent[],
  projection: PairProjection,
  options: BuildSharedContextOptions,
): readonly [NormalizedMessage, NormalizedMessage, NormalizedMessage] {
  invariant(
    typeof options.commonSystem.version === 'string' &&
      options.commonSystem.version.length > 0,
    'commonSystem.version must be a non-empty string',
  );
  invariant(
    typeof options.commonSystem.content === 'string' &&
      options.commonSystem.content.length > 0,
    'commonSystem.content must be a non-empty string',
  );
  canonicalJsonStringify(options.commonSystem);

  const serializedEvents = serializeSharedEvents(
    events,
    projection.header.sharedHead,
    options.sharedEventContextFormat,
  );
  invariant(
    events[0]?.pairId === projection.header.pairId,
    'projection pairId must match shared events',
  );

  return [
    normalizeMessage({ role: 'system', content: options.commonSystem.content }),
    normalizeMessage({ role: 'user', content: serializedEvents }),
    normalizeMessage({
      role: 'user',
      content: serializeSharedProjection(projection),
    }),
  ];
}
