import type {
  JsonObject,
  JsonValue,
  PairEvent,
  PairEventType,
} from './index.js';

export const MAX_PAIR_MESSAGE_BYTES = 64 * 1024;
export const MAX_PEER_HOPS = 4;
export const MAX_SESSION_EVENTS_PAGE_SIZE = 500;

export interface DshMessageOrigin {
  schemaVersion: 1;
  sessionId: string;
  sessionEventSeq: number;
  turn: number;
  messageId: string;
}

export interface PairMessagePayload {
  schemaVersion: 1;
  kind:
    | 'user-input'
    | 'turn-output'
    | 'peer-message'
    | 'completion-handoff';
  text: string;
  content: readonly JsonObject[];
  completion?: 'complete' | 'partial';
  origin?: DshMessageOrigin;
  deliveryId?: string;
  causalRootId?: string;
  hop?: number;
  expectsReply?: boolean;
  replyTo?: string;
}

export interface SessionEventLinkedPayload {
  schemaVersion: 1;
  sessionId: string;
  fromSessionSeq: number;
  throughSessionSeq: number;
  messageIds: readonly string[];
  pairEventId: string;
  representation: 'full' | 'summary' | 'artifact-ref';
  representedContentDigest?: string;
}

export interface DshTurnOrigin {
  schemaVersion: 1;
  sessionId: string;
  sessionEventSeq: number;
}

export interface AgentTurnFailedPayload {
  schemaVersion: 1;
  failedRole: 'navigator' | 'pilot';
  failedTurn: number;
  code: string;
  message: string;
  origin: DshTurnOrigin;
}

export type SessionEventsView = 'semantic' | 'all';

export interface ListPairSessionEventsQuery {
  afterSeq: number;
  limit: number;
  view: SessionEventsView;
}

export interface ListPairSessionEventsResponse {
  pairId: string;
  throughLedgerHead: number;
  sharedHead: number;
  events: PairEvent[];
  nextAfterSeq: number;
  hasMore: boolean;
}

const QUERY_KEYS = new Set(['afterSeq', 'limit', 'view']);
const MESSAGE_KEYS = new Set([
  'schemaVersion',
  'kind',
  'text',
  'content',
  'completion',
  'origin',
  'deliveryId',
  'causalRootId',
  'hop',
  'expectsReply',
  'replyTo',
]);
const ORIGIN_KEYS = new Set([
  'schemaVersion',
  'sessionId',
  'sessionEventSeq',
  'turn',
  'messageId',
]);
const LINK_KEYS = new Set([
  'schemaVersion',
  'sessionId',
  'fromSessionSeq',
  'throughSessionSeq',
  'messageIds',
  'pairEventId',
  'representation',
  'representedContentDigest',
]);
const TURN_FAILURE_KEYS = new Set([
  'schemaVersion',
  'failedRole',
  'failedTurn',
  'code',
  'message',
  'origin',
]);
const TURN_ORIGIN_KEYS = new Set([
  'schemaVersion',
  'sessionId',
  'sessionEventSeq',
]);

function assertPlainObject(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${path} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${path} must not contain symbol keys`);
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(`${path}.${key} must be an enumerable data property`);
    }
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${path}.${key} is unexpected`);
    }
  }
}

function assertJsonSafe(value: unknown, path: string, ancestors: Set<object>): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${path} must be JSON-safe`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${path} contains a circular reference`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const names = Object.getOwnPropertyNames(value);
      if (
        Object.getOwnPropertySymbols(value).length > 0 ||
        names.length !== value.length + 1
      ) {
        throw new TypeError(`${path} must be a dense JSON array`);
      }
      for (let index = 0; index < value.length; index += 1) {
        if (names[index] !== String(index)) {
          throw new TypeError(`${path} must be a dense JSON array`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        ) {
          throw new TypeError(`${path}[${index}] must be a data property`);
        }
        assertJsonSafe(descriptor.value, `${path}[${index}]`, ancestors);
      }
      return;
    }

    assertPlainObject(value, path);
    for (const key of Object.keys(value)) {
      assertJsonSafe(value[key], `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function parseInteger(
  name: 'afterSeq' | 'limit',
  value: unknown,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be an integer string`);
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new TypeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function parseSessionEventsQuery(
  input: Readonly<Record<string, unknown>>,
): ListPairSessionEventsQuery {
  assertPlainObject(input, 'query');
  assertExactKeys(input, QUERY_KEYS, 'query');
  const view = input.view ?? 'semantic';
  if (view !== 'semantic' && view !== 'all') {
    throw new TypeError('view must be semantic or all');
  }
  return {
    afterSeq: parseInteger(
      'afterSeq',
      input.afterSeq,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    limit: parseInteger(
      'limit',
      input.limit,
      100,
      1,
      MAX_SESSION_EVENTS_PAGE_SIZE,
    ),
    view,
  };
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${path} must be a non-empty string`);
  }
}

function assertSafeNonNegativeInteger(
  value: unknown,
  path: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
}

function assertOrigin(value: unknown): asserts value is DshMessageOrigin {
  assertPlainObject(value, 'payload.origin');
  assertExactKeys(value, ORIGIN_KEYS, 'payload.origin');
  if (value.schemaVersion !== 1) {
    throw new TypeError('payload.origin.schemaVersion must be 1');
  }
  assertNonEmptyString(value.sessionId, 'payload.origin.sessionId');
  assertSafeNonNegativeInteger(
    value.sessionEventSeq,
    'payload.origin.sessionEventSeq',
  );
  assertSafeNonNegativeInteger(value.turn, 'payload.origin.turn');
  assertNonEmptyString(value.messageId, 'payload.origin.messageId');
}

function assertMessagePayload(
  type: 'user.message' | 'agent.message',
  payload: unknown,
): asserts payload is PairMessagePayload & JsonObject {
  assertPlainObject(payload, 'payload');
  assertJsonSafe(payload, 'payload', new Set());
  assertExactKeys(payload, MESSAGE_KEYS, 'payload');
  if (payload.schemaVersion !== 1) {
    throw new TypeError('payload.schemaVersion must be 1');
  }
  const allowedKinds =
    type === 'user.message'
      ? new Set(['user-input'])
      : new Set(['turn-output', 'peer-message', 'completion-handoff']);
  if (typeof payload.kind !== 'string' || !allowedKinds.has(payload.kind)) {
    throw new TypeError(`payload.kind is invalid for ${type}`);
  }
  assertNonEmptyString(payload.text, 'payload.text');
  if (new TextEncoder().encode(payload.text).byteLength > MAX_PAIR_MESSAGE_BYTES) {
    throw new TypeError('payload.text must not exceed 64 KiB of UTF-8');
  }
  if (!Array.isArray(payload.content)) {
    throw new TypeError('payload.content must be an array');
  }
  for (const [index, block] of payload.content.entries()) {
    assertPlainObject(block, `payload.content[${index}]`);
  }
  if (payload.origin !== undefined) assertOrigin(payload.origin);
  if (payload.deliveryId !== undefined) {
    assertNonEmptyString(payload.deliveryId, 'payload.deliveryId');
  }
  if (payload.causalRootId !== undefined) {
    assertNonEmptyString(payload.causalRootId, 'payload.causalRootId');
  }
  if (payload.hop !== undefined) {
    if (
      !Number.isSafeInteger(payload.hop) ||
      (payload.hop as number) < 0 ||
      (payload.hop as number) > MAX_PEER_HOPS
    ) {
      throw new TypeError(`payload.hop must be between 0 and ${MAX_PEER_HOPS}`);
    }
  }
  if (
    payload.expectsReply !== undefined &&
    typeof payload.expectsReply !== 'boolean'
  ) {
    throw new TypeError('payload.expectsReply must be boolean');
  }
  if (payload.replyTo !== undefined) {
    assertNonEmptyString(payload.replyTo, 'payload.replyTo');
    if ((payload.replyTo as string).length > 160) {
      throw new TypeError('payload.replyTo must not exceed 160 characters');
    }
  }

  if (payload.kind === 'turn-output') {
    if (payload.completion !== 'complete' && payload.completion !== 'partial') {
      throw new TypeError('payload.completion is required for turn-output');
    }
  } else if (payload.kind === 'completion-handoff') {
    if (payload.completion !== 'complete') {
      throw new TypeError(
        'payload.completion must be complete for completion-handoff',
      );
    }
  } else if (payload.completion !== undefined) {
    throw new TypeError(`payload.completion is invalid for ${payload.kind}`);
  }

  if (
    payload.kind === 'peer-message' ||
    payload.kind === 'completion-handoff'
  ) {
    assertNonEmptyString(payload.causalRootId, 'payload.causalRootId');
    if (
      !Number.isSafeInteger(payload.hop) ||
      (payload.hop as number) < 1 ||
      (payload.hop as number) > MAX_PEER_HOPS
    ) {
      throw new TypeError(`payload.hop must be between 1 and ${MAX_PEER_HOPS}`);
    }
  }
  if (payload.kind === 'peer-message') {
    if (payload.expectsReply === false) {
      throw new TypeError('payload.expectsReply must be omitted when false');
    }
    if (payload.replyTo !== undefined && payload.expectsReply === true) {
      throw new TypeError('payload.replyTo cannot request another reply');
    }
  } else if (
    payload.expectsReply !== undefined ||
    payload.replyTo !== undefined
  ) {
    throw new TypeError(
      `payload reply metadata is invalid for ${payload.kind}`,
    );
  }
}

function assertLinkedPayload(
  payload: unknown,
): asserts payload is SessionEventLinkedPayload & JsonObject {
  assertPlainObject(payload, 'payload');
  assertJsonSafe(payload, 'payload', new Set());
  assertExactKeys(payload, LINK_KEYS, 'payload');
  if (payload.schemaVersion !== 1) {
    throw new TypeError('payload.schemaVersion must be 1');
  }
  assertNonEmptyString(payload.sessionId, 'payload.sessionId');
  assertSafeNonNegativeInteger(payload.fromSessionSeq, 'payload.fromSessionSeq');
  assertSafeNonNegativeInteger(
    payload.throughSessionSeq,
    'payload.throughSessionSeq',
  );
  if ((payload.throughSessionSeq as number) < (payload.fromSessionSeq as number)) {
    throw new TypeError(
      'payload.throughSessionSeq must not precede payload.fromSessionSeq',
    );
  }
  if (!Array.isArray(payload.messageIds) || payload.messageIds.length === 0) {
    throw new TypeError('payload.messageIds must be a non-empty array');
  }
  const messageIds = new Set<string>();
  for (const messageId of payload.messageIds) {
    assertNonEmptyString(messageId, 'payload.messageIds[]');
    if (messageIds.has(messageId)) {
      throw new TypeError('payload.messageIds must be unique');
    }
    messageIds.add(messageId);
  }
  assertNonEmptyString(payload.pairEventId, 'payload.pairEventId');
  if (
    payload.representation !== 'full' &&
    payload.representation !== 'summary' &&
    payload.representation !== 'artifact-ref'
  ) {
    throw new TypeError('payload.representation is invalid');
  }
  if (payload.representation === 'summary') {
    if (payload.messageIds.length !== 1) {
      throw new TypeError(
        'payload.messageIds must contain one message for summary',
      );
    }
    if (
      typeof payload.representedContentDigest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(payload.representedContentDigest)
    ) {
      throw new TypeError(
        'payload.representedContentDigest must be a sha256 digest for summary',
      );
    }
  } else if (payload.representedContentDigest !== undefined) {
    throw new TypeError(
      'payload.representedContentDigest is valid only for summary',
    );
  }
}

function assertTurnFailurePayload(
  payload: unknown,
): asserts payload is AgentTurnFailedPayload & JsonObject {
  assertPlainObject(payload, 'payload');
  assertJsonSafe(payload, 'payload', new Set());
  assertExactKeys(payload, TURN_FAILURE_KEYS, 'payload');
  if (payload.schemaVersion !== 1) {
    throw new TypeError('payload.schemaVersion must be 1');
  }
  if (payload.failedRole !== 'navigator' && payload.failedRole !== 'pilot') {
    throw new TypeError('payload.failedRole is invalid');
  }
  assertSafeNonNegativeInteger(payload.failedTurn, 'payload.failedTurn');
  if ((payload.failedTurn as number) === 0) {
    throw new TypeError('payload.failedTurn must be positive');
  }
  assertNonEmptyString(payload.code, 'payload.code');
  assertNonEmptyString(payload.message, 'payload.message');
  if (
    new TextEncoder().encode(payload.message as string).byteLength >
    MAX_PAIR_MESSAGE_BYTES
  ) {
    throw new TypeError('payload.message must not exceed 64 KiB of UTF-8');
  }
  assertPlainObject(payload.origin, 'payload.origin');
  assertExactKeys(payload.origin, TURN_ORIGIN_KEYS, 'payload.origin');
  if (payload.origin.schemaVersion !== 1) {
    throw new TypeError('payload.origin.schemaVersion must be 1');
  }
  assertNonEmptyString(payload.origin.sessionId, 'payload.origin.sessionId');
  assertSafeNonNegativeInteger(
    payload.origin.sessionEventSeq,
    'payload.origin.sessionEventSeq',
  );
}

export function assertP05PairEventPayload(
  type: 'user.message' | 'agent.message',
  payload: unknown,
): PairMessagePayload & JsonObject;
export function assertP05PairEventPayload(
  type: 'session_event.linked',
  payload: unknown,
): SessionEventLinkedPayload & JsonObject;
export function assertP05PairEventPayload(
  type: 'agent.turn_failed',
  payload: unknown,
): AgentTurnFailedPayload & JsonObject;
export function assertP05PairEventPayload(
  type:
    | 'user.message'
    | 'agent.message'
    | 'agent.turn_failed'
    | 'session_event.linked',
  payload: unknown,
): (
  | PairMessagePayload
  | AgentTurnFailedPayload
  | SessionEventLinkedPayload
) & JsonObject;
export function assertP05PairEventPayload(
  type: PairEventType,
  payload: unknown,
): (
  | PairMessagePayload
  | AgentTurnFailedPayload
  | SessionEventLinkedPayload
) & JsonObject {
  if (type === 'user.message' || type === 'agent.message') {
    assertMessagePayload(type, payload);
    return payload;
  }
  if (type === 'session_event.linked') {
    assertLinkedPayload(payload);
    return payload;
  }
  if (type === 'agent.turn_failed') {
    assertTurnFailurePayload(payload);
    return payload;
  }
  throw new TypeError(`${type} does not have a P0.5 payload contract`);
}

export function isPeerAgentMessage(event: PairEvent): boolean {
  return (
    event.type === 'agent.message' &&
    event.actor.kind === 'agent' &&
    (event.channel === 'navigator' || event.channel === 'pilot') &&
    event.actor.role !== event.channel &&
    typeof event.payload === 'object' &&
    event.payload !== null &&
    !Array.isArray(event.payload) &&
    event.payload.kind === 'peer-message'
  );
}

export function isCompletionHandoffAgentMessage(event: PairEvent): boolean {
  const payload = event.payload;
  const origin = plainObjectValue(payload.origin);
  const content = payload.content;
  const contentBlock = Array.isArray(content) ? content[0] : undefined;
  const textBlock = plainObjectValue(contentBlock);
  const sourceEventIds = event.refs.sourceEventIds;
  return (
    event.type === 'agent.message' &&
    event.actor.kind === 'agent' &&
    event.actor.role === 'pilot' &&
    event.source === 'pilot-session' &&
    event.channel === 'navigator' &&
    event.visibility === 'shared' &&
    event.authority === 'pilot' &&
    payload.schemaVersion === 1 &&
    payload.kind === 'completion-handoff' &&
    typeof payload.text === 'string' &&
    payload.text.trim().length > 0 &&
    new TextEncoder().encode(payload.text).byteLength <= MAX_PAIR_MESSAGE_BYTES &&
    Array.isArray(content) &&
    content.length === 1 &&
    textBlock !== undefined &&
    Object.keys(textBlock).length === 2 &&
    textBlock.type === 'text' &&
    textBlock.text === payload.text &&
    payload.completion === 'complete' &&
    payload.deliveryId === undefined &&
    typeof payload.causalRootId === 'string' &&
    payload.causalRootId.trim().length > 0 &&
    Number.isSafeInteger(payload.hop) &&
    (payload.hop as number) >= 1 &&
    (payload.hop as number) <= MAX_PEER_HOPS &&
    origin !== undefined &&
    origin.schemaVersion === 1 &&
    origin.sessionId === `pair:${event.pairId}:pilot` &&
    Number.isSafeInteger(origin.sessionEventSeq) &&
    (origin.sessionEventSeq as number) >= 0 &&
    Number.isSafeInteger(origin.turn) &&
    (origin.turn as number) > 0 &&
    typeof origin.messageId === 'string' &&
    origin.messageId.length > 0 &&
    sourceEventIds?.length === 1 &&
    sourceEventIds[0] ===
      `dsh:${origin.sessionId}:${String(origin.sessionEventSeq)}:agent.message`
  );
}

function plainObjectValue(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
