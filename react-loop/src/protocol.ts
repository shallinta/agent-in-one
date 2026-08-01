export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ProtocolErrorCode =
  | "unsupported_variant"
  | "invalid_json"
  | "invalid_input"
  | "invalid_turn_outcome"
  | "invalid_retry_safe_set"
  | "revision_conflict"
  | "effect_mismatch"
  | "invalid_state"
  | "invalid_resume_action"
  | "tool_result_mismatch"
  | "incomplete_tool_results"
  | "terminal_state"
  | "concurrent_update"
  | "run_id_conflict";

export class ProtocolError extends Error {
  constructor(
    public readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export type Continuation =
  | { readonly kind: "inline"; readonly value: JsonValue }
  | { readonly kind: "reference"; readonly reference: string; readonly revision: string };

export interface ProtocolFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: JsonValue;
}

export interface ToolCall {
  readonly call_id: string;
  readonly name: string;
  readonly arguments: JsonValue;
  readonly metadata?: JsonValue;
  readonly extensions?: Readonly<Record<string, JsonValue>>;
}

export interface NormalizedToolCall extends ToolCall {
  readonly call_key: string;
}

export type ToolResult =
  | { readonly call_key: string; readonly call_id: string; readonly status: "success"; readonly output: JsonValue }
  | { readonly call_key: string; readonly call_id: string; readonly status: "error"; readonly error: ProtocolFailure }
  | { readonly call_key: string; readonly call_id: string; readonly status: "denied"; readonly error: ProtocolFailure };

export type ToolProgressOutcome =
  | { readonly kind: "pending" }
  | { readonly kind: "result"; readonly result: ToolResult }
  | { readonly kind: "unknown" };

export interface ToolBatchProgressEntry {
  readonly call: NormalizedToolCall;
  readonly retry_safe: boolean;
  readonly outcome: ToolProgressOutcome;
}

export type TurnOutcome =
  | { readonly kind: "finished"; readonly continuation: Continuation; readonly output: JsonValue }
  | { readonly kind: "tool_calls"; readonly continuation: Continuation; readonly calls: readonly ToolCall[] }
  | {
      readonly kind: "paused";
      readonly continuation: Continuation;
      readonly reason: string;
      readonly resume_schema: JsonValue;
      readonly allowed_actions: readonly ("continue" | "stop")[];
    };

export type ToolBatchDecision =
  | { readonly kind: "execute"; readonly mode: "parallel" | "sequential"; readonly max_concurrency: number }
  | { readonly kind: "supply"; readonly results: readonly ToolResult[] }
  | { readonly kind: "pause"; readonly reason: string }
  | { readonly kind: "stop"; readonly reason: string; readonly successful: boolean; readonly output: JsonValue };

export type ResumeAction =
  | { readonly kind: "continue"; readonly input: JsonValue }
  | {
      readonly kind: "execute_tools";
      readonly mode: "parallel" | "sequential";
      readonly max_concurrency: number;
      readonly retry_safe_call_keys: readonly string[];
    }
  | { readonly kind: "provide_tool_results"; readonly results: readonly ToolResult[] }
  | { readonly kind: "retry_tool_batch"; readonly call_keys: readonly string[] }
  | { readonly kind: "provide_turn_outcome"; readonly outcome: TurnOutcome }
  | { readonly kind: "retry_turn"; readonly accept_duplicate_risk: true }
  | { readonly kind: "stop"; readonly reason: string; readonly successful: boolean; readonly output: JsonValue };

export interface InputEnvelope {
  readonly kind: string;
  readonly input_id: string;
  readonly run_id: string;
  readonly expected_revision: number | null;
}

export interface CapabilitySnapshot {
  readonly idempotent_turns?: boolean;
  readonly ownership_mode?: "exclusive" | "fenced";
  readonly atomic_fence_enforcement?: boolean;
  readonly [key: string]: JsonValue | undefined;
}

export type ToolExecutionOutcome =
  | { readonly call_key: string; readonly outcome: { readonly kind: "result"; readonly result: ToolResult } }
  | { readonly call_key: string; readonly outcome: { readonly kind: "unknown" } };

export type Input =
  | (InputEnvelope & {
      readonly kind: "start";
      readonly expected_revision: null;
      readonly continuation: Continuation;
      readonly limits: { readonly max_turns: number; readonly input_receipt_window: number };
      readonly agent_core_capabilities: CapabilitySnapshot;
      readonly tool_executor_capabilities: CapabilitySnapshot;
      readonly runner_capabilities: CapabilitySnapshot;
    })
  | (InputEnvelope & { readonly kind: "turn_completed"; readonly expected_revision: number; readonly effect_id: string; readonly outcome: TurnOutcome })
  | (InputEnvelope & { readonly kind: "turn_failed"; readonly expected_revision: number; readonly effect_id: string; readonly error: ProtocolFailure })
  | (InputEnvelope & {
      readonly kind: "tool_decision_completed";
      readonly expected_revision: number;
      readonly effect_id: string;
      readonly decision: ToolBatchDecision;
      readonly retry_safe_call_keys?: readonly string[];
    })
  | (InputEnvelope & { readonly kind: "tool_decision_failed"; readonly expected_revision: number; readonly effect_id: string; readonly error: ProtocolFailure })
  | (InputEnvelope & {
      readonly kind: "tool_batch_completed" | "tool_batch_failed";
      readonly expected_revision: number;
      readonly effect_id: string;
      readonly outcomes: readonly ToolExecutionOutcome[];
    })
  | (InputEnvelope & { readonly kind: "resume"; readonly expected_revision: number; readonly pause_id: string; readonly action: ResumeAction })
  | (InputEnvelope & { readonly kind: "recover"; readonly expected_revision: number; readonly effect_id: string })
  | (InputEnvelope & { readonly kind: "cancel"; readonly expected_revision: number; readonly reason: string });

interface EffectEnvelope {
  readonly effect_id: string;
  readonly run_id: string;
}

export type Effect =
  | (EffectEnvelope & {
      readonly kind: "run_turn";
      readonly turn_index: number;
      readonly continuation: Continuation;
      readonly tool_results: readonly ToolResult[];
      readonly resume_input: JsonValue;
      readonly retry_safe: boolean;
      readonly idempotency_key: string;
    })
  | (EffectEnvelope & {
      readonly kind: "decide_tool_batch";
      readonly batch_id: string;
      readonly calls: readonly NormalizedToolCall[];
      readonly loop_summary: JsonValue;
    })
  | (EffectEnvelope & {
      readonly kind: "execute_tool_batch";
      readonly batch_id: string;
      readonly progress: readonly ToolBatchProgressEntry[];
      readonly execute_call_keys: readonly string[];
      readonly mode: "parallel" | "sequential";
      readonly max_concurrency: number;
      readonly idempotency_key: string;
    });

export type Pause =
  | {
      readonly kind: "agent_core";
      readonly pause_id: string;
      readonly reason: string;
      readonly resume_schema: JsonValue;
      readonly allowed_actions: readonly ("continue" | "stop")[];
      readonly continuation: Continuation;
    }
  | {
      readonly kind: "tool_approval";
      readonly pause_id: string;
      readonly reason: string;
      readonly batch_id: string;
      readonly tool_calls: readonly NormalizedToolCall[];
      readonly allowed_actions: readonly ("execute_tools" | "provide_tool_results" | "stop")[];
    }
  | {
      readonly kind: "uncertain_tools";
      readonly pause_id: string;
      readonly reason: string;
      readonly batch_id: string;
      readonly progress: readonly ToolBatchProgressEntry[];
      readonly allowed_actions: readonly ("provide_tool_results" | "retry_tool_batch" | "stop")[];
    }
  | {
      readonly kind: "uncertain_turn";
      readonly pause_id: string;
      readonly reason: string;
      readonly effect: Extract<Effect, { kind: "run_turn" }>;
      readonly allowed_actions: readonly ("provide_turn_outcome" | "retry_turn" | "stop")[];
    };

export type Completion =
  | { readonly reason: "finished"; readonly successful: true; readonly output: JsonValue }
  | { readonly reason: "stopped"; readonly source: "policy" | "resume"; readonly successful: boolean; readonly output: JsonValue }
  | { readonly reason: "max_turns_reached"; readonly successful: false };

export interface InputReceipt {
  readonly input_id: string;
  readonly applied_revision: number;
}

interface StateCommon {
  readonly protocol_version: "1.0.0-draft.2";
  readonly run_id: string;
  readonly revision: number;
  readonly last_input_id: string;
  readonly turn_index: number;
  readonly event_sequence: number;
  readonly continuation: Continuation;
  readonly limits: { readonly max_turns: number; readonly input_receipt_window: number };
  readonly execution_contract: {
    readonly turn_retry_safe: boolean;
    readonly ownership_mode: "exclusive" | "fenced";
    readonly atomic_fence_enforcement: boolean;
  };
  readonly input_receipts: readonly InputReceipt[];
  readonly extensions: Readonly<Record<string, JsonValue>>;
}

export type LoopState =
  | (StateCommon & { readonly status: "awaiting_turn"; readonly pending: Extract<Effect, { kind: "run_turn" }> })
  | (StateCommon & { readonly status: "awaiting_tool_decision"; readonly pending: Extract<Effect, { kind: "decide_tool_batch" }> })
  | (StateCommon & { readonly status: "awaiting_tools"; readonly pending: Extract<Effect, { kind: "execute_tool_batch" }> })
  | (StateCommon & { readonly status: "paused"; readonly pending: null; readonly pause: Pause })
  | (StateCommon & { readonly status: "completed"; readonly pending: null; readonly completion: Completion })
  | (StateCommon & { readonly status: "failed"; readonly pending: null; readonly error: ProtocolFailure })
  | (StateCommon & { readonly status: "cancelled"; readonly pending: null; readonly cancellation: { readonly reason: string } });

export type LoopEventKind =
  | "run.started"
  | "turn.requested"
  | "turn.completed"
  | "tool_batch.requested"
  | "tool_batch.decided"
  | "tool_batch.completed"
  | "run.paused"
  | "run.resumed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";

interface LoopEventEnvelope<T extends LoopEventKind, P> {
  readonly protocol_version: "1.0.0-draft.2";
  readonly event_id: string;
  readonly run_id: string;
  readonly sequence: number;
  readonly type: T;
  readonly revision: number;
  readonly payload: P;
  readonly extensions: Readonly<Record<string, JsonValue>>;
}

export type LoopEvent =
  | LoopEventEnvelope<"run.started", Readonly<Record<string, never>>>
  | LoopEventEnvelope<"turn.requested", { readonly effect_id: string; readonly turn_index: number }>
  | LoopEventEnvelope<"turn.completed", { readonly effect_id: string; readonly turn_index: number; readonly outcome_kind: TurnOutcome["kind"] }>
  | LoopEventEnvelope<"tool_batch.requested", { readonly effect_id: string; readonly batch_id: string; readonly call_keys: readonly string[] }>
  | LoopEventEnvelope<"tool_batch.decided", { readonly effect_id: string; readonly batch_id: string; readonly decision_kind: ToolBatchDecision["kind"] }>
  | LoopEventEnvelope<"tool_batch.completed", { readonly effect_id: string; readonly batch_id: string; readonly results: readonly ToolResult[] }>
  | LoopEventEnvelope<"run.paused", Pause>
  | LoopEventEnvelope<"run.resumed", { readonly pause_id: string; readonly action_kind: ResumeAction["kind"] }>
  | LoopEventEnvelope<"run.completed", Completion>
  | LoopEventEnvelope<"run.failed", ProtocolFailure>
  | LoopEventEnvelope<"run.cancelled", { readonly reason: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, code: ProtocolErrorCode): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new ProtocolError(code, `${label} must be a non-empty string`);
}

function has(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function rejectVariantFields(
  value: Record<string, unknown>,
  knownFields: readonly string[],
  allowedFields: readonly string[],
  label: string,
  code: ProtocolErrorCode = "invalid_input",
): void {
  const allowed = new Set(allowedFields);
  const invalid = knownFields.find((field) => has(value, field) && !allowed.has(field));
  if (invalid) throw new ProtocolError(code, `${label} does not allow field: ${invalid}`);
}

function validateContinuation(value: unknown, code: ProtocolErrorCode): asserts value is Continuation {
  if (!isRecord(value)) throw new ProtocolError(code, "continuation must be an object");
  if (value.kind === "inline") {
    rejectVariantFields(value, ["value", "reference", "revision"], ["value"], "inline continuation", code);
    if (!has(value, "value")) throw new ProtocolError(code, "inline continuation requires value");
    return;
  }
  if (value.kind === "reference") {
    rejectVariantFields(value, ["value", "reference", "revision"], ["reference", "revision"], "reference continuation", code);
    requiredString(value.reference, "continuation.reference", code);
    requiredString(value.revision, "continuation.revision", code);
    return;
  }
  throw new ProtocolError("unsupported_variant", `unsupported continuation kind: ${String(value.kind)}`);
}

export function validateToolResult(value: unknown): asserts value is ToolResult {
  if (!isRecord(value)) throw new ProtocolError("invalid_input", "tool result must be an object");
  validateJsonValue(value);
  requiredString(value.call_key, "tool result call_key", "invalid_input");
  requiredString(value.call_id, "tool result call_id", "invalid_input");
  if (value.status === "success") {
    rejectVariantFields(value, ["output", "error"], ["output"], "successful tool result");
    if (!has(value, "output")) throw new ProtocolError("invalid_input", "successful tool result requires output");
    return;
  }
  if (value.status === "error" || value.status === "denied") {
    rejectVariantFields(value, ["output", "error"], ["error"], "failed tool result");
    validateProtocolFailure(value.error);
    return;
  }
  throw new ProtocolError("unsupported_variant", `unsupported tool result status: ${String(value.status)}`);
}

function validateProtocolFailure(value: unknown): asserts value is ProtocolFailure {
  if (!isRecord(value)) throw new ProtocolError("invalid_input", "failure must be an object");
  requiredString(value.code, "failure code", "invalid_input");
  requiredString(value.message, "failure message", "invalid_input");
  if (typeof value.retryable !== "boolean" || !has(value, "details")) throw new ProtocolError("invalid_input", "failure requires retryable and details");
}

function validateSafeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || Object.is(value, -0)) {
    throw new ProtocolError("invalid_input", `${label} must be a safe integer >= ${minimum}`);
  }
}

function validateStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new ProtocolError("invalid_input", `${label} must be an array of non-empty strings`);
  }
}

function validateToolExecutionOutcome(value: unknown): asserts value is ToolExecutionOutcome {
  if (!isRecord(value)) throw new ProtocolError("invalid_input", "tool execution outcome must be an object");
  requiredString(value.call_key, "tool execution call_key", "invalid_input");
  if (!isRecord(value.outcome)) throw new ProtocolError("invalid_input", "tool execution outcome payload must be an object");
  if (value.outcome.kind === "unknown") {
    rejectVariantFields(value.outcome, ["result"], [], "unknown tool outcome");
    return;
  }
  if (value.outcome.kind === "result") {
    if (!has(value.outcome, "result")) throw new ProtocolError("invalid_input", "result tool outcome requires result");
    validateToolResult(value.outcome.result);
    return;
  }
  throw new ProtocolError("unsupported_variant", `unsupported tool execution outcome kind: ${String(value.outcome.kind)}`);
}

export function validateToolBatchDecision(value: unknown): asserts value is ToolBatchDecision {
  if (!isRecord(value)) throw new ProtocolError("invalid_input", "tool decision must be an object");
  validateJsonValue(value);
  if (value.kind !== "execute" && value.kind !== "supply" && value.kind !== "pause" && value.kind !== "stop") {
    throw new ProtocolError("unsupported_variant", `unsupported tool decision kind: ${String(value.kind)}`);
  }
  const decisionFields = ["mode", "max_concurrency", "results", "reason", "successful", "output"];
  if (value.kind === "execute") {
    rejectVariantFields(value, decisionFields, ["mode", "max_concurrency"], "execute decision");
    if (value.mode !== "parallel" && value.mode !== "sequential") throw new ProtocolError("invalid_input", "tool execution mode is invalid");
    if (!Number.isSafeInteger(value.max_concurrency) || (value.max_concurrency as number) < 1) throw new ProtocolError("invalid_input", "max_concurrency must be a positive safe integer");
    if (value.mode === "sequential" && value.max_concurrency !== 1) throw new ProtocolError("invalid_input", "sequential execution requires max_concurrency 1");
  } else if (value.kind === "supply") {
    rejectVariantFields(value, decisionFields, ["results"], "supply decision");
    if (!Array.isArray(value.results)) throw new ProtocolError("invalid_input", "supply decision requires results");
    for (const result of value.results) validateToolResult(result);
  } else if (value.kind === "pause") {
    rejectVariantFields(value, decisionFields, ["reason"], "pause decision");
    requiredString(value.reason, "pause reason", "invalid_input");
  } else {
    rejectVariantFields(value, decisionFields, ["reason", "successful", "output"], "stop decision");
    requiredString(value.reason, "stop reason", "invalid_input");
    if (typeof value.successful !== "boolean" || !has(value, "output")) throw new ProtocolError("invalid_input", "stop decision requires successful and output");
  }
}

export function validateResumeAction(value: unknown): asserts value is ResumeAction {
  if (!isRecord(value)) throw new ProtocolError("invalid_input", "resume action must be an object");
  validateJsonValue(value);
  const kinds = new Set(["continue", "execute_tools", "provide_tool_results", "retry_tool_batch", "provide_turn_outcome", "retry_turn", "stop"]);
  if (typeof value.kind !== "string" || !kinds.has(value.kind)) throw new ProtocolError("unsupported_variant", `unsupported resume action kind: ${String(value.kind)}`);
  const actionFields = ["input", "mode", "max_concurrency", "retry_safe_call_keys", "results", "call_keys", "outcome", "accept_duplicate_risk", "reason", "successful", "output"];
  if (value.kind === "continue") {
    rejectVariantFields(value, actionFields, ["input"], "continue action");
    if (!has(value, "input")) throw new ProtocolError("invalid_input", "continue requires input");
  } else if (value.kind === "execute_tools") {
    rejectVariantFields(value, actionFields, ["mode", "max_concurrency", "retry_safe_call_keys"], "execute_tools action");
    if (value.mode !== "parallel" && value.mode !== "sequential") throw new ProtocolError("invalid_input", "tool execution mode is invalid");
    if (!Number.isSafeInteger(value.max_concurrency) || (value.max_concurrency as number) < 1) throw new ProtocolError("invalid_input", "execute_tools requires positive concurrency");
    validateStringArray(value.retry_safe_call_keys, "retry_safe_call_keys");
    if (new Set(value.retry_safe_call_keys).size !== value.retry_safe_call_keys.length) throw new ProtocolError("invalid_retry_safe_set", "retry_safe_call_keys must be unique");
    if (value.mode === "sequential" && value.max_concurrency !== 1) throw new ProtocolError("invalid_input", "sequential execution requires max_concurrency 1");
  } else if (value.kind === "provide_tool_results") {
    rejectVariantFields(value, actionFields, ["results"], "provide_tool_results action");
    if (!Array.isArray(value.results)) throw new ProtocolError("invalid_input", "provide_tool_results requires results");
    for (const result of value.results) validateToolResult(result);
  } else if (value.kind === "retry_tool_batch") {
    rejectVariantFields(value, actionFields, ["call_keys"], "retry_tool_batch action");
    validateStringArray(value.call_keys, "retry_tool_batch.call_keys");
    if (value.call_keys.length === 0 || new Set(value.call_keys).size !== value.call_keys.length) throw new ProtocolError("invalid_input", "retry_tool_batch requires non-empty unique call_keys");
  } else if (value.kind === "provide_turn_outcome") {
    rejectVariantFields(value, actionFields, ["outcome"], "provide_turn_outcome action");
    validateTurnOutcome(value.outcome);
  } else if (value.kind === "retry_turn") {
    rejectVariantFields(value, actionFields, ["accept_duplicate_risk"], "retry_turn action");
    if (value.accept_duplicate_risk !== true) throw new ProtocolError("invalid_input", "retry_turn requires explicit duplicate-risk acceptance");
  } else if (value.kind === "stop") {
    rejectVariantFields(value, actionFields, ["reason", "successful", "output"], "stop action");
    requiredString(value.reason, "stop reason", "invalid_input");
    if (typeof value.successful !== "boolean" || !has(value, "output")) throw new ProtocolError("invalid_input", "stop requires successful and output");
  }
}

export function validateJsonValue(value: unknown): asserts value is JsonValue {
  const seen = new Set<object>();
  const visit = (entry: unknown): void => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry) || Object.is(entry, -0)) throw new ProtocolError("invalid_json", "numbers must be finite JSON numbers and cannot be negative zero");
      return;
    }
    if (typeof entry !== "object") throw new ProtocolError("invalid_json", "value is not JSON-safe");
    if (seen.has(entry)) throw new ProtocolError("invalid_json", "cyclic values are not JSON-safe");
    seen.add(entry);
    if (Array.isArray(entry)) for (const item of entry) visit(item);
    else {
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) throw new ProtocolError("invalid_json", "objects must be plain JSON objects");
      for (const item of Object.values(entry)) visit(item);
    }
    seen.delete(entry);
  };
  visit(value);
}

export function validateTurnOutcome(value: unknown): asserts value is TurnOutcome {
  if (!isRecord(value)) throw new ProtocolError("invalid_turn_outcome", "turn outcome must be an object");
  if (value.kind !== "finished" && value.kind !== "tool_calls" && value.kind !== "paused") {
    throw new ProtocolError("unsupported_variant", `unsupported turn outcome kind: ${String(value.kind)}`);
  }
  validateJsonValue(value);
  validateContinuation(value.continuation, "invalid_turn_outcome");
  const outcomeFields = ["output", "calls", "reason", "resume_schema", "allowed_actions"];
  if (value.kind === "finished") {
    rejectVariantFields(value, outcomeFields, ["output"], "finished outcome", "invalid_turn_outcome");
    if (!has(value, "output")) throw new ProtocolError("invalid_turn_outcome", "finished outcome requires output");
  }
  if (value.kind === "tool_calls") {
    rejectVariantFields(value, outcomeFields, ["calls"], "tool_calls outcome", "invalid_turn_outcome");
    if (!Array.isArray(value.calls) || value.calls.length === 0) throw new ProtocolError("invalid_turn_outcome", "tool_calls must contain at least one call");
    const ids = new Set<string>();
    for (const rawCall of value.calls) {
      if (!isRecord(rawCall)) throw new ProtocolError("invalid_turn_outcome", "each tool call must be an object");
      requiredString(rawCall.call_id, "call_id", "invalid_turn_outcome");
      requiredString(rawCall.name, "name", "invalid_turn_outcome");
      if (!has(rawCall, "arguments")) throw new ProtocolError("invalid_turn_outcome", "tool call requires arguments");
      if (ids.has(rawCall.call_id)) throw new ProtocolError("invalid_turn_outcome", "tool call_id values must be unique within the batch");
      ids.add(rawCall.call_id);
    }
  } else if (value.kind === "paused") {
    rejectVariantFields(value, outcomeFields, ["reason", "resume_schema", "allowed_actions"], "paused outcome", "invalid_turn_outcome");
    requiredString(value.reason, "pause reason", "invalid_turn_outcome");
    if (!has(value, "resume_schema") || !Array.isArray(value.allowed_actions)) throw new ProtocolError("invalid_turn_outcome", "paused outcome requires resume_schema and allowed_actions");
    if (value.allowed_actions.length === 0 || value.allowed_actions.some((action) => action !== "continue" && action !== "stop") || new Set(value.allowed_actions).size !== value.allowed_actions.length) {
      throw new ProtocolError("invalid_turn_outcome", "paused allowed_actions must be unique continue/stop values");
    }
  }
}

export function validateInput(value: unknown): asserts value is Input {
  if (!isRecord(value)) throw new ProtocolError("invalid_input", "input must be an object");
  const kinds = new Set(["start", "turn_completed", "turn_failed", "tool_decision_completed", "tool_decision_failed", "tool_batch_completed", "tool_batch_failed", "resume", "recover", "cancel"]);
  if (typeof value.kind !== "string" || !kinds.has(value.kind)) throw new ProtocolError("unsupported_variant", `unsupported input kind: ${String(value.kind)}`);
  validateJsonValue(value);
  requiredString(value.input_id, "input_id", "invalid_input");
  requiredString(value.run_id, "run_id", "invalid_input");
  const inputFields = ["continuation", "limits", "agent_core_capabilities", "tool_executor_capabilities", "runner_capabilities", "effect_id", "outcome", "error", "decision", "retry_safe_call_keys", "outcomes", "pause_id", "action", "reason"];
  const allowedByKind: Readonly<Record<string, readonly string[]>> = {
    start: ["continuation", "limits", "agent_core_capabilities", "tool_executor_capabilities", "runner_capabilities"],
    turn_completed: ["effect_id", "outcome"],
    turn_failed: ["effect_id", "error"],
    tool_decision_completed: ["effect_id", "decision", "retry_safe_call_keys"],
    tool_decision_failed: ["effect_id", "error"],
    tool_batch_completed: ["effect_id", "outcomes"],
    tool_batch_failed: ["effect_id", "outcomes"],
    resume: ["pause_id", "action"],
    recover: ["effect_id"],
    cancel: ["reason"],
  };
  rejectVariantFields(value, inputFields, allowedByKind[value.kind] ?? [], `${value.kind} input`);
  if (value.kind === "start") {
    if (value.expected_revision !== null) throw new ProtocolError("invalid_input", "start expected_revision must be null");
    validateContinuation(value.continuation, "invalid_input");
    if (!isRecord(value.limits)) throw new ProtocolError("invalid_input", "start requires limits");
    validateSafeInteger(value.limits.max_turns, "max_turns", 1);
    validateSafeInteger(value.limits.input_receipt_window, "input_receipt_window", 1);
    for (const [label, capability] of [
      ["agent_core_capabilities", value.agent_core_capabilities],
      ["tool_executor_capabilities", value.tool_executor_capabilities],
      ["runner_capabilities", value.runner_capabilities],
    ] as const) {
      if (!isRecord(capability)) throw new ProtocolError("invalid_input", `start requires ${label}`);
    }
    const runnerCapabilities = value.runner_capabilities as Record<string, unknown>;
    if (runnerCapabilities.ownership_mode !== "exclusive" && runnerCapabilities.ownership_mode !== "fenced") {
      throw new ProtocolError("invalid_input", "ownership_mode must be exclusive or fenced");
    }
    if (typeof runnerCapabilities.atomic_fence_enforcement !== "boolean") {
      throw new ProtocolError("invalid_input", "atomic_fence_enforcement must be boolean");
    }
    if (runnerCapabilities.ownership_mode === "fenced" && runnerCapabilities.atomic_fence_enforcement !== true) {
      throw new ProtocolError("invalid_input", "fenced ownership requires atomic fence enforcement");
    }
  } else if (!Number.isSafeInteger(value.expected_revision) || (value.expected_revision as number) < 0 || Object.is(value.expected_revision, -0)) {
    throw new ProtocolError("invalid_input", "expected_revision must be a non-negative safe integer");
  }
  if (value.kind === "start") return;

  if (value.kind === "turn_completed") {
    requiredString(value.effect_id, "effect_id", "invalid_input");
    validateTurnOutcome(value.outcome);
  } else if (value.kind === "turn_failed" || value.kind === "tool_decision_failed") {
    requiredString(value.effect_id, "effect_id", "invalid_input");
    validateProtocolFailure(value.error);
  } else if (value.kind === "tool_decision_completed") {
    requiredString(value.effect_id, "effect_id", "invalid_input");
    validateToolBatchDecision(value.decision);
    if (isRecord(value.decision) && value.decision.kind === "execute") {
      validateStringArray(value.retry_safe_call_keys, "retry_safe_call_keys");
      if (new Set(value.retry_safe_call_keys).size !== value.retry_safe_call_keys.length) throw new ProtocolError("invalid_retry_safe_set", "retry_safe_call_keys must be unique");
    }
  } else if (value.kind === "tool_batch_completed" || value.kind === "tool_batch_failed") {
    requiredString(value.effect_id, "effect_id", "invalid_input");
    if (!Array.isArray(value.outcomes) || value.outcomes.length === 0) throw new ProtocolError("invalid_input", "tool batch input requires outcomes");
    for (const outcome of value.outcomes) validateToolExecutionOutcome(outcome);
    const unknownCount = value.outcomes.filter((outcome) => isRecord(outcome) && isRecord(outcome.outcome) && outcome.outcome.kind === "unknown").length;
    if (value.kind === "tool_batch_completed" && unknownCount !== 0) throw new ProtocolError("invalid_input", "tool_batch_completed cannot contain unknown outcomes");
    if (value.kind === "tool_batch_failed" && unknownCount === 0) throw new ProtocolError("invalid_input", "tool_batch_failed requires an unknown outcome");
  } else if (value.kind === "resume") {
    requiredString(value.pause_id, "pause_id", "invalid_input");
    validateResumeAction(value.action);
  } else if (value.kind === "recover") {
    requiredString(value.effect_id, "effect_id", "invalid_input");
  } else if (value.kind === "cancel") {
    requiredString(value.reason, "cancel reason", "invalid_input");
  }
}
