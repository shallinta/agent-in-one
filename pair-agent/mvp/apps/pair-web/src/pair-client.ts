import {
  canonicalJsonStringify,
  createPairSessionIds,
  isPairEventType,
  isPairTaskState,
  parsePairId,
  type GetPairResponse,
  type ListPairSessionEventsQuery,
  type ListPairSessionEventsResponse,
  type PairEvent,
  type PairHeader,
  type PairPaneDescriptor,
  type PairProjection,
  type PairRole,
  type PairRuntimeCapabilities,
  type SendPairMessageRequest,
  type SendPairMessageResponse,
} from '@pair-agent/contracts';

export { normalizeDshWebOrigin, normalizeShellOrigin } from './origin.js';

export interface PairWebConfig {
  readonly apiBase?: string;
  readonly dshWebOrigin?: string;
  readonly shellOrigin?: string;
}

export interface ValidatedPairPane extends PairPaneDescriptor {
  readonly pairId: string;
}

export interface ValidatedPairResponse {
  readonly projection: PairProjection;
  readonly panes: readonly [ValidatedPairPane, ValidatedPairPane];
  readonly capabilities: PairRuntimeCapabilities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isHead(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export class InvalidPairHostResponseError extends TypeError {
  constructor(detail: string) {
    super(`Invalid Pair Host response: ${detail}`);
    this.name = 'InvalidPairHostResponseError';
  }
}

function invalidResponse(detail: string): never {
  throw new InvalidPairHostResponseError(detail);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalidResponse(`${label}.${key} is unexpected`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) invalidResponse(`${label}.${key} is required`);
  }
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((item) => isJsonValue(item, ancestors));
    }
    if (!isRecord(value)) return false;
    return Object.values(value).every((item) => isJsonValue(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

function validateHeader(value: unknown, expectedPairId: string): PairHeader {
  if (!isRecord(value)) invalidResponse('header must be an object');

  let pairId: string;
  try {
    pairId = parsePairId(value.pairId);
  } catch {
    return invalidResponse('header contains an invalid pairId');
  }
  if (pairId !== expectedPairId) invalidResponse('header pairId does not match the request');
  if (value.schemaVersion !== 1) invalidResponse('unsupported schemaVersion');
  if (!isNonEmptyString(value.navigatorSessionId)) {
    invalidResponse('navigatorSessionId must be a non-empty string');
  }
  if (!isNonEmptyString(value.pilotSessionId)) {
    invalidResponse('pilotSessionId must be a non-empty string');
  }
  if (value.navigatorSessionId === value.pilotSessionId) {
    invalidResponse('Navigator and Pilot sessions must be distinct');
  }
  const expectedSessions = createPairSessionIds(pairId);
  if (
    value.navigatorSessionId !== expectedSessions.navigatorSessionId ||
    value.pilotSessionId !== expectedSessions.pilotSessionId
  ) {
    invalidResponse('session IDs do not match the Pair ID mapping');
  }
  if (!isPositiveInteger(value.ledgerHead) || !isPositiveInteger(value.sharedHead)) {
    invalidResponse('projection heads must be positive safe integers');
  }
  if (value.sharedHead > value.ledgerHead) {
    invalidResponse('sharedHead cannot exceed ledgerHead');
  }
  if (value.dshBuild !== undefined) {
    if (!isRecord(value.dshBuild)) invalidResponse('dshBuild must be an object');
    const commitPattern = /^[0-9a-f]{40}$/i;
    if (
      !isNonEmptyString(value.dshBuild.upstreamRepository) ||
      typeof value.dshBuild.upstreamCommit !== 'string' ||
      !commitPattern.test(value.dshBuild.upstreamCommit) ||
      !isNonEmptyString(value.dshBuild.sourceRepository) ||
      typeof value.dshBuild.sourceCommit !== 'string' ||
      !commitPattern.test(value.dshBuild.sourceCommit) ||
      value.dshBuild.requestLayoutSeamVersion !== 1
    ) {
      invalidResponse('dshBuild must match the DshBuildRef contract');
    }
  }
  if (value.dshRuntimeArtifacts !== undefined) {
    if (!isRecord(value.dshRuntimeArtifacts)) {
      invalidResponse('dshRuntimeArtifacts must be an object');
    }
    const artifacts = value.dshRuntimeArtifacts;
    if (
      artifacts.schemaVersion !== 1 ||
      artifacts.buildProfile !== 'official' ||
      !Array.isArray(artifacts.roots) ||
      artifacts.roots.join('/') !== 'apps/native/packages/vendor' ||
      !isPositiveInteger(artifacts.fileCount) ||
      typeof artifacts.digest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(artifacts.digest)
    ) {
      invalidResponse('dshRuntimeArtifacts must match the runtime artifact contract');
    }
  }

  return value as unknown as PairHeader;
}

function validateProjectionShape(value: unknown, expectedPairId: string): PairProjection {
  if (!isRecord(value)) invalidResponse('projection must be an object');
  validateHeader(value.header, expectedPairId);

  if (!isRecord(value.attention) || typeof value.attention.requested !== 'boolean') {
    invalidResponse('attention must be a valid object');
  }
  if (
    value.attention.reason !== undefined &&
    !isNonEmptyString(value.attention.reason)
  ) {
    invalidResponse('attention reason must be a non-empty string');
  }
  if (
    value.attention.requestedBy !== undefined &&
    value.attention.requestedBy !== 'navigator' &&
    value.attention.requestedBy !== 'pilot'
  ) {
    invalidResponse('attention requestedBy must be a Pair role');
  }
  if (
    value.attention.requestedAtSeq !== undefined &&
    (!isPositiveInteger(value.attention.requestedAtSeq) ||
      value.attention.requestedAtSeq > (value.header as PairHeader).sharedHead)
  ) {
    invalidResponse('attention requestedAtSeq must be within sharedHead');
  }
  if (value.attention.requested && value.attention.requestedAtSeq === undefined) {
    invalidResponse('requested attention requires requestedAtSeq');
  }
  if (
    !value.attention.requested &&
    (value.attention.reason !== undefined ||
      value.attention.requestedBy !== undefined ||
      value.attention.requestedAtSeq !== undefined)
  ) {
    invalidResponse('cleared attention must not retain request metadata');
  }
  if (!isRecord(value.pause) || typeof value.pause.paused !== 'boolean') {
    invalidResponse('pause must be a valid object');
  }
  if (
    !isPositiveInteger(value.pause.changedAtSeq) ||
    value.pause.changedAtSeq > (value.header as PairHeader).sharedHead
  ) {
    invalidResponse('pause changedAtSeq must be within sharedHead');
  }
  if (value.pause.reason !== undefined && !isNonEmptyString(value.pause.reason)) {
    invalidResponse('pause reason must be a non-empty string');
  }

  if (value.goal !== undefined) {
    if (
      !isRecord(value.goal) ||
      !isNonEmptyString(value.goal.id) ||
      !isPositiveInteger(value.goal.version) ||
      !isNonEmptyString(value.goal.summary) ||
      (value.goal.successCriteria !== undefined &&
        (!Array.isArray(value.goal.successCriteria) ||
          !value.goal.successCriteria.every((item) => typeof item === 'string'))) ||
      (value.goal.constraints !== undefined &&
        (!Array.isArray(value.goal.constraints) ||
          !value.goal.constraints.every((item) => typeof item === 'string')))
    ) {
      invalidResponse('goal must match the PairProjection contract');
    }
  }

  if (value.task !== undefined) {
    if (
      !isRecord(value.task) ||
      !isNonEmptyString(value.task.id) ||
      !isPositiveInteger(value.task.revision) ||
      !isNonEmptyString(value.task.summary) ||
      !isPairTaskState(value.task.state)
    ) {
      invalidResponse('task must match the PairProjection contract');
    }
  }

  if (value.executionPlan !== undefined) {
    if (
      !isRecord(value.executionPlan) ||
      !isNonEmptyString(value.executionPlan.id) ||
      !isPositiveInteger(value.executionPlan.revision) ||
      (value.executionPlan.summary !== undefined &&
        !isNonEmptyString(value.executionPlan.summary)) ||
      !Array.isArray(value.executionPlan.steps) ||
      !value.executionPlan.steps.every((step) => typeof step === 'string')
    ) {
      invalidResponse('executionPlan must match the PairProjection contract');
    }
  }

  return value as unknown as PairProjection;
}

function descriptorFor(
  value: unknown,
  role: PairRole,
  expectedSessionId: string,
): PairPaneDescriptor {
  if (!isRecord(value)) invalidResponse(`${role} descriptor must be an object`);
  const expectedSource: PairPaneDescriptor['source'] =
    role === 'navigator' ? 'navigator-session' : 'pilot-session';
  if (
    value.role !== role ||
    value.source !== expectedSource ||
    value.sessionId !== expectedSessionId
  ) {
    invalidResponse(`${role} descriptor does not match the Pair Header`);
  }
  return {
    role,
    source: expectedSource,
    sessionId: expectedSessionId,
  };
}

const CAPABILITY_KEYS = [
  'schemaVersion',
  'stage',
  'sharedConversation',
  'peerMessaging',
  'completionHandoff',
  'requestAudit',
  'pilotWebSearch',
  'goalControl',
  'taskControl',
  'executionPlanControl',
  'attentionControl',
  'pauseControl',
  'subagents',
] as const;

function validateRuntimeCapabilities(value: unknown): PairRuntimeCapabilities {
  if (!isRecord(value)) invalidResponse('capabilities must be an object');
  hasExactKeys(value, CAPABILITY_KEYS, 'capabilities');
  if (value.schemaVersion !== 1 || value.stage !== 'P0.5') {
    invalidResponse('capabilities schemaVersion or stage is unsupported');
  }
  for (const key of CAPABILITY_KEYS.slice(2)) {
    if (typeof value[key] !== 'boolean') {
      invalidResponse(`capabilities.${key} must be boolean`);
    }
  }
  return value as unknown as PairRuntimeCapabilities;
}

export function parsePairIdFromSearch(search: string): string {
  const pairId = new URLSearchParams(search).get('pairId');
  return parsePairId(pairId);
}

export function normalizeApiBase(
  value: string | undefined,
  sameOrigin: string,
): string {
  let url: URL;
  try {
    url = new URL(value?.trim() || sameOrigin, sameOrigin);
  } catch {
    throw new TypeError('Pair API base must be a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Pair API base must use http or https');
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '' || url.search !== '') {
    throw new TypeError('Pair API base must not contain credentials, query, or hash');
  }
  return url.href.replace(/\/$/, '');
}

export function pairApiUrl(apiBase: string, pairId: string, suffix = ''): string {
  return `${apiBase}/api/pairs/${encodeURIComponent(parsePairId(pairId))}${suffix}`;
}

const PAIR_EVENT_KEYS = [
  'pairId',
  'seq',
  'type',
  'actor',
  'source',
  'channel',
  'visibility',
  'authority',
  'refs',
  'payload',
  'occurredAt',
] as const;

function validateVersionedRef(
  value: unknown,
  label: 'goal' | 'task' | 'executionPlan',
  counter: 'version' | 'revision',
): void {
  if (!isRecord(value)) invalidResponse(`event.refs.${label} must be an object`);
  hasExactKeys(value, ['id', counter], `event.refs.${label}`);
  if (!isNonEmptyString(value.id) || !isPositiveInteger(value[counter])) {
    invalidResponse(`event.refs.${label} must contain a non-empty id and positive ${counter}`);
  }
}

function validatePairEvent(value: unknown, expectedPairId: string): PairEvent {
  if (!isRecord(value)) invalidResponse('event must be an object');
  hasExactKeys(value, PAIR_EVENT_KEYS, 'event');
  if (value.pairId !== expectedPairId) invalidResponse('event pairId does not match the request');
  if (!isPositiveInteger(value.seq)) invalidResponse('event seq must be a positive safe integer');
  if (!isPairEventType(value.type)) invalidResponse('event type is invalid');

  if (!isRecord(value.actor)) invalidResponse('event actor must be an object');
  if (value.actor.kind === 'agent') {
    hasExactKeys(value.actor, ['kind', 'role'], 'event.actor');
    if (value.actor.role !== 'navigator' && value.actor.role !== 'pilot') {
      invalidResponse('event actor role is invalid');
    }
  } else {
    hasExactKeys(value.actor, ['kind'], 'event.actor');
    if (
      value.actor.kind !== 'user' &&
      value.actor.kind !== 'host' &&
      value.actor.kind !== 'pair'
    ) {
      invalidResponse('event actor kind is invalid');
    }
  }
  if (
    value.source !== 'pair' &&
    value.source !== 'navigator-session' &&
    value.source !== 'pilot-session'
  ) {
    invalidResponse('event source is invalid');
  }
  if (
    value.channel !== 'navigator' &&
    value.channel !== 'pilot' &&
    value.channel !== 'shared-control'
  ) {
    invalidResponse('event channel is invalid');
  }
  if (
    value.visibility !== 'shared' &&
    value.visibility !== 'local' &&
    value.visibility !== 'infrastructure'
  ) {
    invalidResponse('event visibility is invalid');
  }
  if (
    value.authority !== 'user' &&
    value.authority !== 'user-derived' &&
    value.authority !== 'navigator' &&
    value.authority !== 'pilot' &&
    value.authority !== 'host'
  ) {
    invalidResponse('event authority is invalid');
  }
  if (!isRecord(value.refs)) invalidResponse('event refs must be an object');
  const refKeys = new Set(['goal', 'task', 'executionPlan', 'sourceEventIds']);
  for (const key of Object.keys(value.refs)) {
    if (!refKeys.has(key)) invalidResponse(`event.refs.${key} is unexpected`);
  }
  if (value.refs.goal !== undefined) {
    validateVersionedRef(value.refs.goal, 'goal', 'version');
  }
  if (value.refs.task !== undefined) {
    validateVersionedRef(value.refs.task, 'task', 'revision');
  }
  if (value.refs.executionPlan !== undefined) {
    validateVersionedRef(value.refs.executionPlan, 'executionPlan', 'revision');
  }
  if (value.refs.sourceEventIds !== undefined) {
    if (
      !Array.isArray(value.refs.sourceEventIds) ||
      !value.refs.sourceEventIds.every(isNonEmptyString)
    ) {
      invalidResponse(
        'event.refs.sourceEventIds must be an array of non-empty strings',
      );
    }
  }
  if (!isJsonValue(value.refs) || !isJsonValue(value.payload)) {
    invalidResponse('event refs and payload must be JSON-safe');
  }
  if (
    typeof value.occurredAt !== 'string' ||
    value.occurredAt.length === 0 ||
    !Number.isFinite(Date.parse(value.occurredAt))
  ) {
    invalidResponse('event occurredAt must be a timestamp');
  }
  return value as unknown as PairEvent;
}

export function validateListPairSessionEventsResponse(
  value: unknown,
  expectedPairId: string,
  afterSeq: number,
): ListPairSessionEventsResponse {
  if (!isRecord(value)) invalidResponse('session-events body must be an object');
  hasExactKeys(
    value,
    [
      'pairId',
      'throughLedgerHead',
      'sharedHead',
      'events',
      'nextAfterSeq',
      'hasMore',
    ],
    'session-events',
  );
  if (value.pairId !== expectedPairId) {
    invalidResponse('session-events pairId does not match the request');
  }
  const throughLedgerHead = value.throughLedgerHead;
  const sharedHead = value.sharedHead;
  const nextAfterSeq = value.nextAfterSeq;
  if (!isHead(throughLedgerHead) || !isHead(sharedHead)) {
    invalidResponse('session-events heads must be non-negative safe integers');
  }
  if (sharedHead > throughLedgerHead) {
    invalidResponse('session-events sharedHead cannot exceed throughLedgerHead');
  }
  if (!Array.isArray(value.events)) invalidResponse('session-events events must be an array');
  if (!isHead(nextAfterSeq)) invalidResponse('session-events cursor must be non-negative');
  if (typeof value.hasMore !== 'boolean') invalidResponse('session-events hasMore must be boolean');
  if (nextAfterSeq < afterSeq || nextAfterSeq > throughLedgerHead) {
    invalidResponse('session-events cursor did not progress within the snapshot');
  }
  if (value.hasMore && nextAfterSeq <= afterSeq) {
    invalidResponse('session-events cursor must advance while hasMore is true');
  }

  let previousSeq = 0;
  const events = value.events.map((candidate) => {
    const event = validatePairEvent(candidate, expectedPairId);
    if (event.seq <= previousSeq) invalidResponse('session-events events must be ascending');
    if (event.seq > throughLedgerHead) {
      invalidResponse('event seq cannot exceed throughLedgerHead');
    }
    if (event.seq > nextAfterSeq) {
      invalidResponse('event seq cannot exceed the physical cursor');
    }
    previousSeq = event.seq;
    return event;
  });
  if (value.hasMore && nextAfterSeq >= throughLedgerHead) {
    invalidResponse('session-events cursor cannot have more past the snapshot head');
  }
  if (!value.hasMore && nextAfterSeq !== throughLedgerHead) {
    invalidResponse('session-events terminal cursor must reach throughLedgerHead');
  }
  return { ...value, events } as unknown as ListPairSessionEventsResponse;
}

export async function listPairSessionEvents(
  fetcher: typeof fetch,
  apiBase: string,
  pairId: string,
  query: ListPairSessionEventsQuery,
  signal?: AbortSignal,
): Promise<ListPairSessionEventsResponse> {
  const url = new URL(pairApiUrl(apiBase, pairId, '/session-events'));
  url.searchParams.set('afterSeq', String(query.afterSeq));
  url.searchParams.set('limit', String(query.limit));
  url.searchParams.set('view', query.view);
  const response = await fetcher(url.href, { signal });
  const body = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) {
    const message =
      isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
        ? body.error.message
        : `Pair Host request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return validateListPairSessionEventsResponse(body, pairId, query.afterSeq);
}

export class LedgerConflictError extends Error {
  constructor(
    message: string,
    readonly expectedLedgerHead: number,
    readonly actualLedgerHead: number,
  ) {
    super(message);
    this.name = 'LedgerConflictError';
  }
}

function validateSendPairMessageResponse(value: unknown): SendPairMessageResponse {
  if (!isRecord(value)) invalidResponse('message body must be an object');
  hasExactKeys(
    value,
    ['acceptedAtLedgerHead', 'deliveryId', 'delivery'],
    'message',
  );
  if (
    !isPositiveInteger(value.acceptedAtLedgerHead) ||
    !isNonEmptyString(value.deliveryId) ||
    (value.delivery !== 'delivered' && value.delivery !== 'pending')
  ) {
    invalidResponse('message body does not match SendPairMessageResponse');
  }
  return value as unknown as SendPairMessageResponse;
}

export async function sendPairMessage(
  fetcher: typeof fetch,
  apiBase: string,
  pairId: string,
  role: PairRole,
  input: SendPairMessageRequest,
  signal?: AbortSignal,
): Promise<SendPairMessageResponse> {
  if (role !== 'navigator' && role !== 'pilot') {
    throw new TypeError('Pair message role must be navigator or pilot');
  }
  if (!isNonEmptyString(input.text) || !isHead(input.expectedLedgerHead)) {
    throw new TypeError('Pair message input is invalid');
  }
  const response = await fetcher(pairApiUrl(apiBase, pairId, `/messages/${role}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  const body = await response.json().catch(() => undefined) as unknown;
  if (response.status === 409 && isRecord(body) && isRecord(body.error)) {
    const { error } = body;
    if (
      error.code === 'LEDGER_CONFLICT' &&
      typeof error.message === 'string' &&
      isRecord(error.details) &&
      isHead(error.details.expectedLedgerHead) &&
      isHead(error.details.actualLedgerHead)
    ) {
      throw new LedgerConflictError(
        error.message,
        error.details.expectedLedgerHead,
        error.details.actualLedgerHead,
      );
    }
  }
  if (!response.ok || response.status !== 202) {
    const message =
      isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string'
        ? body.error.message
        : `Pair Host request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return validateSendPairMessageResponse(body);
}

export function validateGetPairResponse(
  value: unknown,
  expectedPairId: string,
): ValidatedPairResponse {
  if (!isRecord(value)) invalidResponse('body must be an object');
  const projection = validateProjectionShape(value.projection, expectedPairId);
  if (!Array.isArray(value.panes) || value.panes.length !== 2) {
    invalidResponse('panes must contain exactly Navigator and Pilot');
  }
  const navigatorRaw = value.panes.find(
    (candidate) => isRecord(candidate) && candidate.role === 'navigator',
  );
  const pilotRaw = value.panes.find(
    (candidate) => isRecord(candidate) && candidate.role === 'pilot',
  );
  const navigator = descriptorFor(
    navigatorRaw,
    'navigator',
    projection.header.navigatorSessionId,
  );
  const pilot = descriptorFor(pilotRaw, 'pilot', projection.header.pilotSessionId);
  const capabilities = validateRuntimeCapabilities(value.capabilities);

  return {
    projection,
    capabilities,
    panes: [
      { pairId: expectedPairId, ...navigator },
      { pairId: expectedPairId, ...pilot },
    ],
  };
}

export function validateProjectionUpdate(
  value: unknown,
  expectedHeader: PairHeader,
): PairProjection {
  const projection = validateProjectionShape(value, expectedHeader.pairId);
  const header = projection.header;
  if (
    header.schemaVersion !== expectedHeader.schemaVersion ||
    header.navigatorSessionId !== expectedHeader.navigatorSessionId ||
    header.pilotSessionId !== expectedHeader.pilotSessionId ||
    canonicalJsonStringify(header.dshBuild ?? null) !==
      canonicalJsonStringify(expectedHeader.dshBuild ?? null) ||
    canonicalJsonStringify(header.dshRuntimeArtifacts ?? null) !==
      canonicalJsonStringify(expectedHeader.dshRuntimeArtifacts ?? null)
  ) {
    invalidResponse('SSE update changed the Pair session identity');
  }
  return projection;
}

function sharedProjectionFingerprint(projection: PairProjection): string {
  return canonicalJsonStringify({
    goal: projection.goal ?? null,
    task: projection.task ?? null,
    executionPlan: projection.executionPlan ?? null,
    attention: projection.attention,
    pause: projection.pause,
  });
}

function invalidTransition(detail: string): never {
  throw new TypeError(`Invalid Pair projection transition: ${detail}`);
}

function assertStableVersionedValue(
  previous: { readonly id: string; readonly version: number } | undefined,
  next: { readonly id: string; readonly version: number } | undefined,
  label: string,
): void {
  if (previous === undefined) return;
  if (next === undefined) invalidTransition(`${label} cannot be removed`);
  if (next.id !== previous.id) invalidTransition(`${label} ID changed`);
  if (next.version < previous.version) invalidTransition(`${label} version decreased`);
  if (
    next.version === previous.version &&
    canonicalJsonStringify(next) !== canonicalJsonStringify(previous)
  ) {
    invalidTransition(`${label} changed without a version increment`);
  }
}

function assertStableRevisionedValue(
  previous: { readonly id: string; readonly revision: number } | undefined,
  next: { readonly id: string; readonly revision: number } | undefined,
  label: string,
): void {
  if (previous === undefined) return;
  if (next === undefined) invalidTransition(`${label} cannot be removed`);
  if (next.id !== previous.id) invalidTransition(`${label} ID changed`);
  if (next.revision < previous.revision) {
    invalidTransition(`${label} revision decreased`);
  }
  if (
    next.revision === previous.revision &&
    canonicalJsonStringify(next) !== canonicalJsonStringify(previous)
  ) {
    invalidTransition(`${label} changed without a revision increment`);
  }
}

export function validateProjectionTransition(
  previous: PairProjection,
  next: PairProjection,
): boolean {
  if (
    next.header.pairId !== previous.header.pairId ||
    next.header.schemaVersion !== previous.header.schemaVersion ||
    next.header.navigatorSessionId !== previous.header.navigatorSessionId ||
    next.header.pilotSessionId !== previous.header.pilotSessionId
  ) {
    invalidTransition('Pair or session identity changed');
  }

  if (next.header.ledgerHead < previous.header.ledgerHead) {
    if (next.header.sharedHead > previous.header.sharedHead) {
      invalidTransition('a stale ledgerHead carried a newer sharedHead');
    }
    return false;
  }
  if (next.header.ledgerHead === previous.header.ledgerHead) {
    if (canonicalJsonStringify(next) !== canonicalJsonStringify(previous)) {
      invalidTransition('projection changed without a ledgerHead increment');
    }
    return false;
  }
  if (next.header.sharedHead < previous.header.sharedHead) {
    invalidTransition('sharedHead decreased');
  }
  if (next.header.sharedHead === previous.header.sharedHead) {
    if (sharedProjectionFingerprint(next) !== sharedProjectionFingerprint(previous)) {
      invalidTransition('shared fields changed without a sharedHead increment');
    }
    return true;
  }

  assertStableVersionedValue(previous.goal, next.goal, 'goal');

  if (previous.task !== undefined) {
    if (next.task === undefined) invalidTransition('task cannot be removed');
    if (next.task.id !== previous.task.id) invalidTransition('task ID changed');
    if (next.task.revision < previous.task.revision) {
      invalidTransition('task revision decreased');
    }
    if (
      next.task.revision === previous.task.revision &&
      next.task.summary !== previous.task.summary
    ) {
      invalidTransition('task summary changed without a revision increment');
    }
    // Task lifecycle transitions intentionally retain the same revision.
  }

  assertStableRevisionedValue(
    previous.executionPlan,
    next.executionPlan,
    'execution plan',
  );

  const previousAttentionSeq = previous.attention.requestedAtSeq;
  const nextAttentionSeq = next.attention.requestedAtSeq;
  if (
    previousAttentionSeq !== undefined &&
    nextAttentionSeq !== undefined &&
    nextAttentionSeq < previousAttentionSeq
  ) {
    invalidTransition('attention requestedAtSeq decreased');
  }
  if (next.attention.requested) {
    const attentionPersistedUnchanged =
      previous.attention.requested &&
      canonicalJsonStringify(next.attention) ===
        canonicalJsonStringify(previous.attention);
    if (
      !attentionPersistedUnchanged &&
      (nextAttentionSeq === undefined ||
        nextAttentionSeq <= previous.header.sharedHead)
    ) {
      invalidTransition(
        'new attention requestedAtSeq must be newer than the previous sharedHead',
      );
    }
    if (
      previous.attention.requested &&
      nextAttentionSeq === previousAttentionSeq &&
      canonicalJsonStringify(next.attention) !==
        canonicalJsonStringify(previous.attention)
    ) {
      invalidTransition('attention changed without a newer requestedAtSeq');
    }
  }

  if (next.pause.changedAtSeq < previous.pause.changedAtSeq) {
    invalidTransition('pause changedAtSeq decreased');
  }
  if (
    next.pause.changedAtSeq === previous.pause.changedAtSeq &&
    canonicalJsonStringify(next.pause) !== canonicalJsonStringify(previous.pause)
  ) {
    invalidTransition('pause changed without a newer changedAtSeq');
  }

  return true;
}

export async function loadPair(
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal,
  expectedPairId: string,
): Promise<ValidatedPairResponse> {
  const response = await fetcher(url, { signal });
  const body = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) {
    const message =
      isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === 'string'
        ? body.error.message
        : `Pair Host request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return validateGetPairResponse(body, expectedPairId);
}
