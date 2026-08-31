import {
  canonicalJsonStringify,
  createPairSessionIds,
  isPairTaskState,
  parsePairId,
  type GetPairResponse,
  type PairHeader,
  type PairPaneDescriptor,
  type PairProjection,
  type PairRole,
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

function invalidResponse(detail: string): never {
  throw new TypeError(`Invalid Pair Host response: ${detail}`);
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

  return {
    projection,
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
