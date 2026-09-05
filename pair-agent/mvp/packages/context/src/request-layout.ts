import { createHash } from 'node:crypto';

import {
  canonicalJsonStringify,
  type JsonObject,
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
  type RequestLocalSessionLink,
  type SessionEventPairSpanLink,
} from './local-history.js';
import {
  buildSharedContext,
  canonicalJsonClone,
  deepFreezeJson,
  normalizeMessage,
  type CommonSystemDefinition,
  type NormalizedMessage,
  type SharedEventContextFormat,
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
  sharedEventContextFormat: SharedEventContextFormat;
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
  requestLocalLinks?: readonly RequestLocalSessionLink[];
  roleToolGuidance: string;
  currentTrigger?: PairCurrentTrigger;
  tools: JsonValue;
  config: JsonValue;
}

export interface PairCurrentTrigger {
  kind: string;
  pairEventId: string;
  deliveryId?: string;
  causalRootId?: string;
  hop?: number;
  senderRole?: PairRole;
  senderTurn?: number;
  failedRole?: PairRole;
  failedTurn?: number;
  code?: string;
  expectsReply?: true;
  replyTo?: string;
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
  sharedEventContextFormat: SharedEventContextFormat;
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
  sharedEventContextFormat: SharedEventContextFormat;
  toolSetVersion: string;
  requestConfigVersion: string;
  commonSystemDigest: string;
  messagesDigest: string;
  toolsDigest: string;
  configDigest: string;
  manifestDigest: string;
  fullRequestDigest: string;
  segmentMeasurements: PairRequestSegmentMeasurements;
}

export type PairRequestSegmentName =
  | 'common-system'
  | 'shared-events'
  | 'shared-projection'
  | 'local-history'
  | 'active-role'
  | 'current-trigger'
  | 'tool-schemas'
  | 'request-config';

export interface PairRequestSegmentMeasurement extends JsonObject {
  name: PairRequestSegmentName;
  utf8Bytes: number;
  estimatedTokens: number;
  itemCount: number;
  digest: string;
}

export interface PairRequestSegmentMeasurements extends JsonObject {
  schema: 'pair-request-segments/v1';
  tokenEstimateMethod: 'utf8-bytes-div-4/v1';
  segments: readonly PairRequestSegmentMeasurement[];
  categorizedUtf8Bytes: number;
  estimatedTokens: number;
  sharedEventCount: number;
  localMessageCount: number;
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

function segmentMeasurement(
  name: PairRequestSegmentName,
  material: unknown,
  itemCount: number,
  included = true,
): PairRequestSegmentMeasurement {
  const canonical = canonicalJsonStringify(material);
  const utf8Bytes = included ? Buffer.byteLength(canonical, 'utf8') : 0;
  return {
    name,
    utf8Bytes,
    estimatedTokens: Math.ceil(utf8Bytes / 4),
    itemCount: included ? itemCount : 0,
    digest: sha256Canonical(material),
  };
}

function collectionItemCount(value: JsonValue): number {
  return Array.isArray(value) ? value.length : 1;
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

function buildCurrentTrigger(trigger: PairCurrentTrigger): NormalizedMessage {
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
  nonEmptyString(
    input.sharedEventContextFormat,
    'sharedEventContextFormat',
  );
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
    const allowed = new Set([
      'kind',
      'pairEventId',
      'deliveryId',
      'causalRootId',
      'hop',
      'senderRole',
      'senderTurn',
      'failedRole',
      'failedTurn',
      'code',
      'expectsReply',
      'replyTo',
    ]);
    invariant(
      Object.keys(input.currentTrigger).every((key) => allowed.has(key)),
      'currentTrigger contains unsupported payload fields',
    );
    nonEmptyString(input.currentTrigger.kind, 'currentTrigger.kind');
    nonEmptyString(
      input.currentTrigger.pairEventId,
      'currentTrigger.pairEventId',
    );
    if (input.currentTrigger.deliveryId !== undefined) {
      nonEmptyString(
        input.currentTrigger.deliveryId,
        'currentTrigger.deliveryId',
      );
    }
    if (input.currentTrigger.failedRole !== undefined) {
      invariant(
        input.currentTrigger.failedRole === 'navigator' ||
          input.currentTrigger.failedRole === 'pilot',
        'currentTrigger.failedRole is invalid',
      );
    }
    if (input.currentTrigger.failedTurn !== undefined) {
      positiveSafeInteger(
        input.currentTrigger.failedTurn,
        'currentTrigger.failedTurn',
      );
    }
    if (input.currentTrigger.code !== undefined) {
      nonEmptyString(input.currentTrigger.code, 'currentTrigger.code');
    }
    if (input.currentTrigger.expectsReply !== undefined) {
      invariant(
        input.currentTrigger.expectsReply === true,
        'currentTrigger.expectsReply must be true when present',
      );
    }
    if (input.currentTrigger.replyTo !== undefined) {
      nonEmptyString(input.currentTrigger.replyTo, 'currentTrigger.replyTo');
    }
    if (input.currentTrigger.causalRootId !== undefined) {
      nonEmptyString(
        input.currentTrigger.causalRootId,
        'currentTrigger.causalRootId',
      );
    }
    if (input.currentTrigger.hop !== undefined) {
      nonNegativeSafeInteger(input.currentTrigger.hop, 'currentTrigger.hop');
    }
    if (input.currentTrigger.senderRole !== undefined) {
      invariant(
        input.currentTrigger.senderRole === 'navigator' ||
          input.currentTrigger.senderRole === 'pilot',
        'currentTrigger.senderRole must be navigator or pilot',
      );
    }
    if (input.currentTrigger.senderTurn !== undefined) {
      positiveSafeInteger(
        input.currentTrigger.senderTurn,
        'currentTrigger.senderTurn',
      );
    }
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
    {
      commonSystem: input.commonSystem,
      sharedEventContextFormat: input.sharedEventContextFormat,
    },
  );
  const local = projectLocalHistory(input.boundaryMessages, input.links, {
    expectedSessionId: input.sessionId,
    ...(input.requestLocalLinks === undefined
      ? {}
      : { requestLocalLinks: input.requestLocalLinks }),
  });
  if (local.status === 'degraded') {
    throw new UnsafeLocalHistoryError(local);
  }
  const commonSystemPlacement = input.commonSystemPlacement ?? 'message';
  const system =
    commonSystemPlacement === 'request-system'
      ? input.commonSystem.content
      : undefined;
  const activeRoleReminder = buildActiveRoleReminder(
    input.role,
    input.roleToolGuidance,
  );
  const currentTrigger =
    input.currentTrigger === undefined
      ? undefined
      : buildCurrentTrigger(input.currentTrigger);
  const messages: readonly NormalizedMessage[] = [
    ...(commonSystemPlacement === 'request-system'
      ? sharedPrefix.slice(1)
      : sharedPrefix),
    ...local.messages,
    activeRoleReminder,
    ...(currentTrigger === undefined ? [] : [currentTrigger]),
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
    sharedEventContextFormat: input.sharedEventContextFormat,
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
  const segments: readonly PairRequestSegmentMeasurement[] = [
    segmentMeasurement(
      'common-system',
      system ?? sharedPrefix[0],
      1,
    ),
    segmentMeasurement('shared-events', sharedPrefix[1], 1),
    segmentMeasurement('shared-projection', sharedPrefix[2], 1),
    segmentMeasurement(
      'local-history',
      local.messages as unknown as JsonValue,
      local.messages.length,
    ),
    segmentMeasurement('active-role', activeRoleReminder, 1),
    segmentMeasurement(
      'current-trigger',
      currentTrigger ?? null,
      1,
      currentTrigger !== undefined,
    ),
    segmentMeasurement(
      'tool-schemas',
      tools,
      collectionItemCount(tools),
    ),
    segmentMeasurement(
      'request-config',
      config,
      collectionItemCount(config),
    ),
  ];
  const segmentMeasurements: PairRequestSegmentMeasurements = {
    schema: 'pair-request-segments/v1',
    tokenEstimateMethod: 'utf8-bytes-div-4/v1',
    segments,
    categorizedUtf8Bytes: segments.reduce(
      (total, segment) => total + segment.utf8Bytes,
      0,
    ),
    estimatedTokens: segments.reduce(
      (total, segment) => total + segment.estimatedTokens,
      0,
    ),
    sharedEventCount: input.sharedEvents.length,
    localMessageCount: local.messages.length,
  };
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
    sharedEventContextFormat: input.sharedEventContextFormat,
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
    segmentMeasurements,
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
