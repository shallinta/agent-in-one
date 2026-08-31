import { createHash } from 'node:crypto';

import {
  canonicalJsonStringify,
  type JsonValue,
  type PairEvent,
  type PairProjection,
  type PairRole,
} from '@pair-agent/contracts';

import {
  projectLocalHistory,
  type DegradedLocalHistoryProjection,
  type LocalBoundaryMessage,
  type LocalHistorySpanManifest,
  type SessionEventPairSpanLink,
} from './local-history.js';
import {
  buildSharedContext,
  canonicalJsonClone,
  deepFreezeJson,
  normalizeMessage,
  type CommonSystemDefinition,
  type NormalizedMessage,
} from './serialize.js';

export interface PairRequestLayoutInput {
  role: PairRole;
  sessionId: string;
  turn: number;
  step: number;
  attempt: number;
  sourceLedgerHead: number;
  sharedHead: number;
  localSurfaceThroughSeq: number;
  promptVersion: string;
  toolSetVersion: string;
  requestConfigVersion: string;
  commonSystem: CommonSystemDefinition;
  /**
   * DSH exposes the rendered system prompt as a dedicated request field. Pair
   * integrations use that slot so the common prompt is not duplicated in the
   * message array. The default keeps the standalone Chat Completions layout.
   */
  commonSystemPlacement?: 'message' | 'request-system';
  sharedEvents: readonly PairEvent[];
  projection: PairProjection;
  boundaryMessages: readonly LocalBoundaryMessage[];
  links: readonly SessionEventPairSpanLink[];
  roleToolGuidance: string;
  currentTrigger?: JsonValue;
  tools: JsonValue;
  config: JsonValue;
}

export interface LayoutManifest {
  role: PairRole;
  sessionId: string;
  turn: number;
  step: number;
  attempt: number;
  sourceLedgerHead: number;
  sharedHead: number;
  localSurfaceThroughSeq: number;
  promptVersion: string;
  toolSetVersion: string;
  requestConfigVersion: string;
  commonSystemPlacement: 'message' | 'request-system';
  spans: readonly LocalHistorySpanManifest[];
}

export interface PairRequestSnapshot {
  role: PairRole;
  sessionId: string;
  turn: number;
  step: number;
  attempt: number;
  sourceLedgerHead: number;
  sharedHead: number;
  localSurfaceThroughSeq: number;
  promptVersion: string;
  toolSetVersion: string;
  requestConfigVersion: string;
  commonSystemDigest: string;
  messagesDigest: string;
  toolsDigest: string;
  configDigest: string;
  manifestDigest: string;
  fullRequestDigest: string;
}

export interface PairRequestLayout {
  system?: string;
  messages: readonly NormalizedMessage[];
  tools: JsonValue;
  config: JsonValue;
  manifest: LayoutManifest;
  snapshot: PairRequestSnapshot;
}

export class RequestLayoutInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestLayoutInvariantError';
  }
}

export class UnsafeLocalHistoryError extends Error {
  readonly projection: DegradedLocalHistoryProjection;

  constructor(projection: DegradedLocalHistoryProjection) {
    super('Unsafe local history projection is degraded; provider request refused');
    this.name = 'UnsafeLocalHistoryError';
    this.projection = deepFreezeJson(projection);
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RequestLayoutInvariantError(message);
}

function positiveSafeInteger(value: number, label: string): void {
  invariant(
    Number.isSafeInteger(value) && value > 0,
    `${label} must be a positive safe integer`,
  );
}

function nonNegativeSafeInteger(value: number, label: string): void {
  invariant(
    Number.isSafeInteger(value) && value >= 0,
    `${label} must be a non-negative safe integer`,
  );
}

function nonEmptyString(value: string, label: string): void {
  invariant(typeof value === 'string' && value.length > 0, `${label} is required`);
}

function sha256Canonical(value: unknown): string {
  const bytes = canonicalJsonStringify(value);
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

function buildActiveRoleReminder(
  role: PairRole,
  roleToolGuidance: string,
): NormalizedMessage {
  nonEmptyString(roleToolGuidance, 'roleToolGuidance');
  const guidance = canonicalJsonStringify({ text: roleToolGuidance });
  return normalizeMessage({
    role: 'user',
    content:
      `<system-reminder><active-role>${role}</active-role>` +
      `<role-tool-guidance>${guidance}</role-tool-guidance></system-reminder>`,
  });
}

function buildCurrentTrigger(trigger: JsonValue): NormalizedMessage {
  return normalizeMessage({
    role: 'user',
    content: [
      '<pair-trigger schema="pair-trigger/v1">',
      canonicalJsonStringify(trigger),
      '</pair-trigger>',
    ].join('\n'),
  });
}

function validateInput(input: PairRequestLayoutInput): void {
  invariant(
    input.role === 'navigator' || input.role === 'pilot',
    'role must be navigator or pilot',
  );
  invariant(
    input.commonSystemPlacement === undefined ||
      input.commonSystemPlacement === 'message' ||
      input.commonSystemPlacement === 'request-system',
    'commonSystemPlacement must be message or request-system',
  );
  positiveSafeInteger(input.turn, 'turn');
  positiveSafeInteger(input.step, 'step');
  positiveSafeInteger(input.attempt, 'attempt');
  positiveSafeInteger(input.sourceLedgerHead, 'sourceLedgerHead');
  positiveSafeInteger(input.sharedHead, 'sharedHead');
  nonNegativeSafeInteger(
    input.localSurfaceThroughSeq,
    'localSurfaceThroughSeq',
  );
  nonEmptyString(input.sessionId, 'sessionId');
  nonEmptyString(input.promptVersion, 'promptVersion');
  nonEmptyString(input.toolSetVersion, 'toolSetVersion');
  nonEmptyString(input.requestConfigVersion, 'requestConfigVersion');
  invariant(
    input.commonSystem.version === input.promptVersion,
    'commonSystem.version must equal promptVersion',
  );
  invariant(
    input.projection.header.sharedHead === input.sharedHead,
    'projection sharedHead must equal input sharedHead',
  );
  invariant(
    input.projection.header.ledgerHead === input.sourceLedgerHead,
    'projection ledgerHead must equal sourceLedgerHead',
  );
  invariant(
    input.sourceLedgerHead >= input.sharedHead,
    'sourceLedgerHead must not precede sharedHead',
  );
  const expectedSessionId =
    input.role === 'navigator'
      ? input.projection.header.navigatorSessionId
      : input.projection.header.pilotSessionId;
  invariant(
    input.sessionId === expectedSessionId,
    `sessionId must match the ${input.role} session`,
  );
  invariant(
    input.boundaryMessages.every(
      ({ sessionId, sessionSeq }) =>
        sessionId === input.sessionId &&
        sessionSeq <= input.localSurfaceThroughSeq,
    ),
    'boundary messages must belong to the selected session and local surface',
  );

  if (input.currentTrigger !== undefined) {
    canonicalJsonStringify(input.currentTrigger);
  }
  canonicalJsonStringify(input.tools);
  canonicalJsonStringify(input.config);
}

export function buildPairRequestLayout(
  input: PairRequestLayoutInput,
): PairRequestLayout {
  validateInput(input);
  const tools = canonicalJsonClone(input.tools);
  const config = canonicalJsonClone(input.config);
  const sharedPrefix = buildSharedContext(
    input.sharedEvents,
    input.projection,
    { commonSystem: input.commonSystem },
  );
  const local = projectLocalHistory(input.boundaryMessages, input.links, {
    expectedSessionId: input.sessionId,
  });
  if (local.status === 'degraded') {
    throw new UnsafeLocalHistoryError(local);
  }
  const commonSystemPlacement = input.commonSystemPlacement ?? 'message';
  const system =
    commonSystemPlacement === 'request-system'
      ? input.commonSystem.content
      : undefined;
  const messages: readonly NormalizedMessage[] = [
    ...(commonSystemPlacement === 'request-system'
      ? sharedPrefix.slice(1)
      : sharedPrefix),
    buildActiveRoleReminder(input.role, input.roleToolGuidance),
    ...local.messages,
    ...(input.currentTrigger === undefined
      ? []
      : [buildCurrentTrigger(input.currentTrigger)]),
  ];
  const manifest: LayoutManifest = {
    role: input.role,
    sessionId: input.sessionId,
    turn: input.turn,
    step: input.step,
    attempt: input.attempt,
    sourceLedgerHead: input.sourceLedgerHead,
    sharedHead: input.sharedHead,
    localSurfaceThroughSeq: input.localSurfaceThroughSeq,
    promptVersion: input.promptVersion,
    toolSetVersion: input.toolSetVersion,
    requestConfigVersion: input.requestConfigVersion,
    commonSystemPlacement,
    spans: local.spans,
  };

  const messagesDigest = sha256Canonical(messages);
  const commonSystemDigest = sha256Canonical(input.commonSystem);
  const toolsDigest = sha256Canonical(tools);
  const configDigest = sha256Canonical(config);
  const manifestDigest = sha256Canonical(manifest);
  const snapshot: PairRequestSnapshot = {
    role: input.role,
    sessionId: input.sessionId,
    turn: input.turn,
    step: input.step,
    attempt: input.attempt,
    sourceLedgerHead: input.sourceLedgerHead,
    sharedHead: input.sharedHead,
    localSurfaceThroughSeq: input.localSurfaceThroughSeq,
    promptVersion: input.promptVersion,
    toolSetVersion: input.toolSetVersion,
    requestConfigVersion: input.requestConfigVersion,
    commonSystemDigest,
    messagesDigest,
    toolsDigest,
    configDigest,
    manifestDigest,
    fullRequestDigest: sha256Canonical({
      ...(system === undefined ? {} : { system }),
      messages,
      tools,
      config,
    }),
  };
  return deepFreezeJson({
    ...(system === undefined ? {} : { system }),
    messages,
    tools,
    config,
    manifest,
    snapshot,
  });
}
