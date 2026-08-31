declare const pairIdBrand: unique symbol;

export type PairId = string & { readonly [pairIdBrand]: 'PairId' };

function describeInvalidPairId(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return serialized;
  } catch {
    // Error construction must remain total for BigInt and circular inputs.
  }
  try {
    return Object.prototype.toString.call(value);
  } catch {
    return '<unprintable>';
  }
}

export class InvalidPairIdError extends Error {
  constructor(value: unknown) {
    super(
      `Invalid PairId ${describeInvalidPairId(value)}: expected 1-128 characters matching [A-Za-z0-9_-]`,
    );
    this.name = 'InvalidPairIdError';
  }
}

const PAIR_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function parsePairId(value: unknown): PairId {
  if (typeof value !== 'string' || !PAIR_ID_PATTERN.test(value)) {
    throw new InvalidPairIdError(value);
  }
  return value as PairId;
}

export interface PairSessionIds {
  navigatorSessionId: string;
  pilotSessionId: string;
}

export function createPairSessionIds(pairId: string): PairSessionIds {
  const validatedPairId = parsePairId(pairId);
  return {
    navigatorSessionId: `pair:${validatedPairId}:navigator`,
    pilotSessionId: `pair:${validatedPairId}:pilot`,
  };
}

export type PairRole = 'navigator' | 'pilot';
export type PairChannel = PairRole | 'shared-control';
export type PairEventSource =
  | 'pair'
  | 'navigator-session'
  | 'pilot-session';
export type Visibility = 'shared' | 'local' | 'infrastructure';
export type Authority =
  | 'user'
  | 'user-derived'
  | 'navigator'
  | 'pilot'
  | 'host';

export type Actor =
  | { kind: 'user' }
  | { kind: 'agent'; role: PairRole }
  | { kind: 'host' }
  | { kind: 'pair' };

export const PAIR_EVENT_TYPES = [
  'pair.created',
  'pair.agent_ready',
  'pair.agent_failed',
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
  'session_event.linked',
  'pair.request_built',
  'delivery.queued',
  'delivery.durable',
  'delivery.claimed',
  'delivery.completed',
  'delivery.failed',
  'delivery.cancelled',
  'delivery.superseded',
] as const;

export type PairEventType = (typeof PAIR_EVENT_TYPES)[number];

const PAIR_EVENT_TYPE_SET: ReadonlySet<string> = new Set(PAIR_EVENT_TYPES);

export function isPairEventType(value: unknown): value is PairEventType {
  return typeof value === 'string' && PAIR_EVENT_TYPE_SET.has(value);
}

export interface GoalRef {
  id: string;
  version: number;
}

export interface TaskRef {
  id: string;
  revision: number;
}

export interface ExecutionPlanRef {
  id: string;
  revision: number;
}

export interface PairEventRefs {
  goal?: GoalRef;
  task?: TaskRef;
  executionPlan?: ExecutionPlanRef;
  sourceEventIds?: string[];
}

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export interface JsonArray extends ReadonlyArray<JsonValue> {}

export interface PairEvent<TPayload extends JsonValue = JsonObject> {
  pairId: PairId;
  seq: number;
  type: PairEventType;
  actor: Actor;
  source: PairEventSource;
  channel: PairChannel;
  visibility: Visibility;
  authority: Authority;
  refs: PairEventRefs;
  payload: TPayload;
  occurredAt: string;
}

export type PairEventDraft<TPayload extends JsonValue = JsonObject> = Omit<
  PairEvent<TPayload>,
  'pairId' | 'seq' | 'occurredAt'
>;

export interface DshBuildRef {
  upstreamRepository: string;
  upstreamCommit: string;
  sourceRepository: string;
  sourceCommit: string;
  requestLayoutSeamVersion: 1;
}

export interface DshRuntimeArtifactRef {
  schemaVersion: 1;
  buildProfile: 'official';
  roots: readonly ['apps', 'native', 'packages', 'vendor'];
  fileCount: number;
  digest: string;
}

export interface PairCreatedPayload extends PairSessionIds {
  schemaVersion: 1;
  dshBuild?: DshBuildRef;
  dshRuntimeArtifacts?: DshRuntimeArtifactRef;
}

export interface PairCreated extends PairCreatedPayload {
  pairId: PairId;
}

export interface PairGoal {
  id: string;
  version: number;
  summary: string;
  successCriteria?: string[];
  constraints?: string[];
}

export const PAIR_TASK_STATES = [
  'queued',
  'active',
  'paused',
  'completed',
  'blocked',
  'cancelled',
] as const;

export type PairTaskState = (typeof PAIR_TASK_STATES)[number];

const PAIR_TASK_STATE_SET: ReadonlySet<string> = new Set(PAIR_TASK_STATES);

export function isPairTaskState(value: unknown): value is PairTaskState {
  return typeof value === 'string' && PAIR_TASK_STATE_SET.has(value);
}

export interface PairTask {
  id: string;
  revision: number;
  summary: string;
  state: PairTaskState;
}

export interface TaskStateChangedPayload {
  from: PairTaskState;
  to: PairTaskState;
}

export interface PairExecutionPlan {
  id: string;
  revision: number;
  summary?: string;
  steps: readonly string[];
}

export interface PairAttention {
  requested: boolean;
  reason?: string;
  requestedBy?: PairRole;
  requestedAtSeq?: number;
}

export interface PairPause {
  paused: boolean;
  reason?: string;
  changedAtSeq: number;
}

export interface PairHeader extends PairCreated {
  ledgerHead: number;
  sharedHead: number;
}

export interface PairProjection {
  header: PairHeader;
  goal?: PairGoal;
  task?: PairTask;
  executionPlan?: PairExecutionPlan;
  attention: PairAttention;
  pause: PairPause;
}

export interface PairPaneDescriptor {
  role: PairRole;
  source: Extract<PairEventSource, 'navigator-session' | 'pilot-session'>;
  sessionId: string;
}

export interface CreatePairRequest {
  pairId: string;
}

export interface CreatePairResponse {
  header: PairHeader;
  panes: readonly PairPaneDescriptor[];
}

export interface GetPairResponse {
  projection: PairProjection;
  panes: readonly PairPaneDescriptor[];
}

export interface SendPairMessageRequest {
  text: string;
  expectedLedgerHead: number;
}

export type PairDeliveryStatus = 'delivered' | 'pending';

export interface SendPairMessageResponse {
  acceptedAtLedgerHead: number;
  deliveryId: string;
  delivery: PairDeliveryStatus;
}

export interface AssignPairTaskRequest {
  expectedLedgerHead: number;
  task: PairTask;
  goalRef?: GoalRef;
}

export type AssignPairTaskResponse = SendPairMessageResponse;

export class InvalidJsonValueError extends TypeError {
  constructor(detail: string) {
    super(`Invalid JSON value: ${detail}`);
    this.name = 'InvalidJsonValueError';
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(
  value: unknown,
  ancestors: Set<object>,
  path: string,
): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidJsonValueError(`${path} must be a finite number`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new InvalidJsonValueError(`${path} cannot be ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new InvalidJsonValueError(`${path} contains a circular reference`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const propertyNames = Object.getOwnPropertyNames(value);
      const elementNames = propertyNames.filter((key) => key !== 'length');
      if (
        Object.getOwnPropertySymbols(value).length > 0 ||
        propertyNames.length !== value.length + 1 ||
        elementNames.length !== value.length ||
        elementNames.some((key, index) => key !== String(index))
      ) {
        throw new InvalidJsonValueError(
          `${path} array contains a non-index property`,
        );
      }
      return elementNames.map((key, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        ) {
          throw new InvalidJsonValueError(
            `${path}[${index}] must be an enumerable data property`,
          );
        }
        return canonicalize(descriptor.value, ancestors, `${path}[${index}]`);
      });
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidJsonValueError(`${path} must be a plain object`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new InvalidJsonValueError(`${path} contains a symbol-keyed property`);
    }

    const result = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.getOwnPropertyNames(value).sort(compareCodePoints)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        throw new InvalidJsonValueError(
          `${path}.${key} must be an enumerable data property`,
        );
      }
      result[key] = canonicalize(
        descriptor.value,
        ancestors,
        `${path}.${key}`,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
  canonicalize(value, new Set(), '$');
}

export function assertJsonObject(value: unknown): asserts value is JsonObject {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new InvalidJsonValueError('$ must be a plain object');
  }
  canonicalize(value, new Set(), '$');
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set(), '$'));
}

export * from './pair-events.js';
