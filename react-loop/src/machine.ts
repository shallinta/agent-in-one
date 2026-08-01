import {
  ProtocolError,
  validateTurnOutcome,
  type Effect,
  type Completion,
  type Continuation,
  type Input,
  type LoopEvent,
  type LoopState,
  type NormalizedToolCall,
  type Pause,
  type ProtocolFailure,
  type ToolBatchProgressEntry,
  type ToolExecutionOutcome,
  type ToolResult,
} from "./protocol";

export interface TransitionResult {
  readonly state: LoopState;
  readonly effects: readonly Effect[];
  readonly events: readonly LoopEvent[];
}

interface StatePatch {
  readonly status: LoopState["status"];
  readonly pending: Effect | null;
  readonly turn_index?: number;
  readonly continuation?: Continuation;
  readonly pause?: Pause;
  readonly completion?: Completion;
  readonly error?: ProtocolFailure;
  readonly cancellation?: { readonly reason: string };
}

const PROTOCOL_VERSION = "1.0.0-draft.2" as const;

type EventSpec = LoopEvent extends infer E
  ? E extends LoopEvent
    ? readonly [E["type"], E["payload"]]
    : never
  : never;

function effectId(runId: string, revision: number, kind: Effect["kind"]): string {
  return `${runId}:${revision}:${kind}:0`;
}

function batchId(runId: string, turnIndex: number): string {
  return `${runId}:tool-batch:${turnIndex}`;
}

function normalizeCalls(runId: string, turnIndex: number, calls: readonly Omit<NormalizedToolCall, "call_key">[]): readonly NormalizedToolCall[] {
  const batch = batchId(runId, turnIndex);
  return calls.map((call, ordinal) => ({ ...call, call_key: `${batch}:${ordinal}` }));
}

function resultInputMatchesCall(result: ToolResult, call: NormalizedToolCall): void {
  if (result.call_key !== call.call_key || result.call_id !== call.call_id) {
    throw new ProtocolError("tool_result_mismatch", "tool result call_key and call_id must match the target call");
  }
}

function resultsForCalls(results: readonly ToolResult[], calls: readonly NormalizedToolCall[]): readonly ToolResult[] {
  if (results.length !== calls.length) throw new ProtocolError("incomplete_tool_results", "tool results must cover the complete call set");
  return calls.map((call, index) => {
    const result = results[index];
    if (!result) throw new ProtocolError("incomplete_tool_results", "tool results must preserve call order");
    resultInputMatchesCall(result, call);
    return result;
  });
}

function makeRunTurn(state: LoopState, revision: number, toolResults: readonly ToolResult[], resumeInput: import("./protocol").JsonValue): Extract<Effect, { kind: "run_turn" }> {
  const id = effectId(state.run_id, revision, "run_turn");
  return {
    kind: "run_turn",
    effect_id: id,
    run_id: state.run_id,
    turn_index: state.turn_index,
    continuation: state.continuation,
    tool_results: toolResults,
    resume_input: resumeInput,
    retry_safe: state.execution_contract.turn_retry_safe,
    idempotency_key: id,
  };
}

function makeExecute(
  state: LoopState,
  revision: number,
  batch: string,
  progress: readonly ToolBatchProgressEntry[],
  executeKeys: readonly string[],
  mode: "parallel" | "sequential",
  maxConcurrency: number,
): Extract<Effect, { kind: "execute_tool_batch" }> {
  const id = effectId(state.run_id, revision, "execute_tool_batch");
  return {
    kind: "execute_tool_batch",
    effect_id: id,
    run_id: state.run_id,
    batch_id: batch,
    progress,
    execute_call_keys: executeKeys,
    mode,
    max_concurrency: maxConcurrency,
    idempotency_key: id,
  };
}

function applyReceipt(state: LoopState, input: Input, revision: number) {
  return [...state.input_receipts, { input_id: input.input_id, applied_revision: revision }].slice(-state.limits.input_receipt_window);
}

function makeEvent(state: LoopState | null, revision: number, sequence: number, spec: EventSpec): LoopEvent {
  const common = {
    protocol_version: PROTOCOL_VERSION,
    event_id: `${state?.run_id ?? ""}:event:${sequence}`,
    run_id: state?.run_id ?? "",
    sequence,
    revision,
    extensions: {},
  } as const;
  switch (spec[0]) {
    case "run.started": return { ...common, type: spec[0], payload: spec[1] };
    case "turn.requested": return { ...common, type: spec[0], payload: spec[1] };
    case "turn.completed": return { ...common, type: spec[0], payload: spec[1] };
    case "tool_batch.requested": return { ...common, type: spec[0], payload: spec[1] };
    case "tool_batch.decided": return { ...common, type: spec[0], payload: spec[1] };
    case "tool_batch.completed": return { ...common, type: spec[0], payload: spec[1] };
    case "run.paused": return { ...common, type: spec[0], payload: spec[1] };
    case "run.resumed": return { ...common, type: spec[0], payload: spec[1] };
    case "run.completed": return { ...common, type: spec[0], payload: spec[1] };
    case "run.failed": return { ...common, type: spec[0], payload: spec[1] };
    case "run.cancelled": return { ...common, type: spec[0], payload: spec[1] };
  }
}

function transitionEvents(state: LoopState | null, revision: number, kinds: readonly EventSpec[]): readonly LoopEvent[] {
  let sequence = state ? state.event_sequence + 1 : 0;
  return kinds.map((spec) => {
    const event = makeEvent(state, revision, sequence, spec);
    sequence += 1;
    return event;
  });
}

function finish(
  previous: LoopState,
  input: Input,
  partial: StatePatch,
  eventSpecs: readonly EventSpec[],
  effects: readonly Effect[],
): TransitionResult {
  const revision = previous.revision + 1;
  const events = transitionEvents(previous, revision, eventSpecs);
  const eventSequence = events.at(-1)?.sequence ?? previous.event_sequence;
  const common = {
    protocol_version: PROTOCOL_VERSION,
    run_id: previous.run_id,
    revision,
    last_input_id: input.input_id,
    turn_index: partial.turn_index ?? previous.turn_index,
    event_sequence: eventSequence,
    continuation: partial.continuation ?? previous.continuation,
    limits: previous.limits,
    execution_contract: previous.execution_contract,
    input_receipts: applyReceipt(previous, input, revision),
    extensions: previous.extensions,
  } as const;
  let state: LoopState;
  switch (partial.status) {
    case "awaiting_turn":
      if (partial.pending?.kind !== "run_turn") throw new ProtocolError("invalid_state", "awaiting_turn requires run_turn");
      state = { ...common, status: "awaiting_turn", pending: partial.pending };
      break;
    case "awaiting_tool_decision":
      if (partial.pending?.kind !== "decide_tool_batch") throw new ProtocolError("invalid_state", "awaiting_tool_decision requires decide_tool_batch");
      state = { ...common, status: "awaiting_tool_decision", pending: partial.pending };
      break;
    case "awaiting_tools":
      if (partial.pending?.kind !== "execute_tool_batch") throw new ProtocolError("invalid_state", "awaiting_tools requires execute_tool_batch");
      state = { ...common, status: "awaiting_tools", pending: partial.pending };
      break;
    case "paused":
      if (!partial.pause) throw new ProtocolError("invalid_state", "paused requires pause");
      state = { ...common, status: "paused", pending: null, pause: partial.pause };
      break;
    case "completed":
      if (!partial.completion) throw new ProtocolError("invalid_state", "completed requires completion");
      state = { ...common, status: "completed", pending: null, completion: partial.completion };
      break;
    case "failed":
      if (!partial.error) throw new ProtocolError("invalid_state", "failed requires error");
      state = { ...common, status: "failed", pending: null, error: partial.error };
      break;
    case "cancelled":
      if (!partial.cancellation) throw new ProtocolError("invalid_state", "cancelled requires cancellation");
      state = { ...common, status: "cancelled", pending: null, cancellation: partial.cancellation };
      break;
  }
  return { state, effects, events };
}

function ensureEffect(state: LoopState, effectIdValue: string): void {
  if (!state.pending || state.pending.effect_id !== effectIdValue) {
    throw new ProtocolError("effect_mismatch", "effect_id does not match pending effect");
  }
}

function progressResults(progress: readonly ToolBatchProgressEntry[]): readonly ToolResult[] {
  return progress.map((entry) => {
    if (entry.outcome.kind !== "result") throw new ProtocolError("invalid_state", "tool progress is not complete");
    return entry.outcome.result;
  });
}

function continueAfterTools(state: LoopState, input: Input, progress: readonly ToolBatchProgressEntry[], extraEvents: readonly EventSpec[]): TransitionResult {
  const revision = state.revision + 1;
  if (state.turn_index >= state.limits.max_turns) {
    const completion = { reason: "max_turns_reached", successful: false } as const;
    return finish(state, input, {
      status: "completed",
      pending: null,
      completion,
    }, [...extraEvents, ["run.completed", completion]], []);
  }
  const effect = makeRunTurn(state, revision, progressResults(progress), null);
  return finish(state, input, { status: "awaiting_turn", pending: effect }, [...extraEvents, ["turn.requested", { effect_id: effect.effect_id, turn_index: state.turn_index }]], [effect]);
}

function pauseForUnknown(state: LoopState, input: Input, batch: string, progress: readonly ToolBatchProgressEntry[]): TransitionResult {
  const revision = state.revision + 1;
  const pauseId = `${state.run_id}:pause:${revision}`;
  const pause: Extract<Pause, { kind: "uncertain_tools" }> = {
    kind: "uncertain_tools",
    pause_id: pauseId,
    reason: "tool execution outcome is unknown",
    batch_id: batch,
    progress,
    allowed_actions: ["provide_tool_results", "retry_tool_batch", "stop"],
  };
  return finish(state, input, {
    status: "paused",
    pending: null,
    pause,
  }, [["run.paused", pause]], []);
}

function mergeToolOutcomes(
  progress: readonly ToolBatchProgressEntry[],
  executeKeys: readonly string[],
  outcomes: readonly ToolExecutionOutcome[],
): readonly ToolBatchProgressEntry[] {
  if (outcomes.length !== executeKeys.length) throw new ProtocolError("incomplete_tool_results", "outcomes must cover execute_call_keys");
  const expected = new Set(executeKeys);
  const byKey = new Map<string, ToolExecutionOutcome>();
  for (const outcome of outcomes) {
    if (!expected.has(outcome.call_key) || byKey.has(outcome.call_key)) throw new ProtocolError("incomplete_tool_results", "outcomes must uniquely cover execute_call_keys");
    byKey.set(outcome.call_key, outcome);
  }
  if (byKey.size !== expected.size) throw new ProtocolError("incomplete_tool_results", "outcomes must cover execute_call_keys");
  return progress.map((entry) => {
    const replacement = byKey.get(entry.call.call_key);
    if (!replacement) return entry;
    if (replacement.outcome.kind === "result") resultInputMatchesCall(replacement.outcome.result, entry.call);
    return { ...entry, outcome: replacement.outcome };
  });
}

function pauseAllowsAction(pause: Pause, action: Input & { kind: "resume" }): boolean {
  const actionKind: string = action.action.kind;
  return pause.allowed_actions.some((allowed) => allowed === actionKind);
}

export function transition(state: LoopState | null, input: Input): TransitionResult {
  if (state === null) {
    if (input.kind !== "start") throw new ProtocolError("invalid_state", "only start is valid for an absent run");
    if (input.expected_revision !== null || input.limits.max_turns < 1 || input.limits.input_receipt_window < 1 || !Number.isSafeInteger(input.limits.max_turns) || !Number.isSafeInteger(input.limits.input_receipt_window)) {
      throw new ProtocolError("invalid_input", "start limits must be positive safe integers");
    }
    const id = effectId(input.run_id, 0, "run_turn");
    const effect: Extract<Effect, { kind: "run_turn" }> = {
      kind: "run_turn",
      effect_id: id,
      run_id: input.run_id,
      turn_index: 0,
      continuation: input.continuation,
      tool_results: [],
      resume_input: null,
      retry_safe: input.agent_core_capabilities.idempotent_turns === true,
      idempotency_key: id,
    };
    const skeleton = {
      protocol_version: PROTOCOL_VERSION,
      run_id: input.run_id,
      revision: 0,
      last_input_id: input.input_id,
      status: "awaiting_turn",
      turn_index: 0,
      event_sequence: -1,
      continuation: input.continuation,
      limits: input.limits,
      execution_contract: {
        turn_retry_safe: input.agent_core_capabilities.idempotent_turns === true,
        ownership_mode: input.runner_capabilities.ownership_mode === "fenced" ? "fenced" : "exclusive",
        atomic_fence_enforcement: input.runner_capabilities.atomic_fence_enforcement === true,
      },
      pending: effect,
      input_receipts: [{ input_id: input.input_id, applied_revision: 0 }],
      extensions: {},
    } as const;
    const events = transitionEvents(skeleton as LoopState, 0, [
      ["run.started", {}],
      ["turn.requested", { effect_id: id, turn_index: 0 }],
    ]);
    const next = { ...skeleton, event_sequence: events.at(-1)?.sequence ?? -1 } as LoopState;
    return { state: next, effects: [effect], events };
  }

  if (input.run_id !== state.run_id) throw new ProtocolError("invalid_input", "input run_id does not match state");
  if (state.input_receipts.some((receipt) => receipt.input_id === input.input_id)) return { state, effects: [], events: [] };
  if (state.status === "cancelled" && input.kind === "cancel") return { state, effects: [], events: [] };
  if (input.expected_revision !== state.revision) throw new ProtocolError("revision_conflict", "expected_revision does not match current revision");

  if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") throw new ProtocolError("terminal_state", "terminal states cannot make progress");
  if (input.kind === "recover") throw new ProtocolError("unsupported_variant", "recover is not supported by the in-memory reference");
  if (input.kind === "cancel") {
    return finish(state, input, { status: "cancelled", pending: null, cancellation: { reason: input.reason } }, [["run.cancelled", { reason: input.reason }]], []);
  }

  if (state.status === "awaiting_turn") {
    if (input.kind === "turn_failed") {
      ensureEffect(state, input.effect_id);
      return finish(state, input, { status: "failed", pending: null, error: input.error }, [["run.failed", input.error]], []);
    }
    if (input.kind !== "turn_completed") throw new ProtocolError("invalid_state", "awaiting_turn requires a turn result");
    ensureEffect(state, input.effect_id);
    validateTurnOutcome(input.outcome);
    const revision = state.revision + 1;
    const turnIndex = state.turn_index + 1;
    const baseEvent: EventSpec = ["turn.completed", { effect_id: input.effect_id, turn_index: turnIndex, outcome_kind: input.outcome.kind }];
    if (input.outcome.kind === "finished") {
      const completion = { reason: "finished", successful: true, output: input.outcome.output } as const;
      return finish(state, input, {
        status: "completed",
        pending: null,
        turn_index: turnIndex,
        continuation: input.outcome.continuation,
        completion,
      }, [baseEvent, ["run.completed", completion]], []);
    }
    if (input.outcome.kind === "paused") {
      const pauseId = `${state.run_id}:pause:${revision}`;
      const pause: Extract<Pause, { kind: "agent_core" }> = { kind: "agent_core", pause_id: pauseId, reason: input.outcome.reason, resume_schema: input.outcome.resume_schema, allowed_actions: input.outcome.allowed_actions, continuation: input.outcome.continuation };
      return finish(state, input, {
        status: "paused",
        pending: null,
        turn_index: turnIndex,
        continuation: input.outcome.continuation,
        pause,
      }, [baseEvent, ["run.paused", pause]], []);
    }
    const calls = normalizeCalls(state.run_id, turnIndex, input.outcome.calls);
    const batch = batchId(state.run_id, turnIndex);
    const id = effectId(state.run_id, revision, "decide_tool_batch");
    const effect: Extract<Effect, { kind: "decide_tool_batch" }> = { kind: "decide_tool_batch", effect_id: id, run_id: state.run_id, batch_id: batch, calls, loop_summary: { turn_index: turnIndex, max_turns: state.limits.max_turns } };
    return finish(state, input, { status: "awaiting_tool_decision", pending: effect, turn_index: turnIndex, continuation: input.outcome.continuation }, [baseEvent, ["tool_batch.requested", { effect_id: id, batch_id: batch, call_keys: calls.map((call) => call.call_key) }]], [effect]);
  }

  if (state.status === "awaiting_tool_decision") {
    if (input.kind === "tool_decision_failed") {
      ensureEffect(state, input.effect_id);
      return finish(state, input, { status: "failed", pending: null, error: input.error }, [["run.failed", input.error]], []);
    }
    if (input.kind !== "tool_decision_completed") throw new ProtocolError("invalid_state", "awaiting_tool_decision requires a policy result");
    ensureEffect(state, input.effect_id);
    const { calls, batch_id: batch } = state.pending;
    const decisionEvent: EventSpec = ["tool_batch.decided", { effect_id: input.effect_id, batch_id: batch, decision_kind: input.decision.kind }];
    if (input.decision.kind === "stop") {
      const completion = { reason: "stopped", source: "policy", successful: input.decision.successful, output: input.decision.output } as const;
      return finish(state, input, { status: "completed", pending: null, completion }, [decisionEvent, ["run.completed", completion]], []);
    }
    if (input.decision.kind === "pause") {
      const pauseId = `${state.run_id}:pause:${state.revision + 1}`;
      const pause: Extract<Pause, { kind: "tool_approval" }> = { kind: "tool_approval", pause_id: pauseId, reason: input.decision.reason, batch_id: batch, tool_calls: calls, allowed_actions: ["execute_tools", "provide_tool_results", "stop"] };
      return finish(state, input, { status: "paused", pending: null, pause }, [decisionEvent, ["run.paused", pause]], []);
    }
    if (input.decision.kind === "supply") {
      const results = resultsForCalls(input.decision.results, calls);
      const progress = calls.map((call, index) => ({ call, retry_safe: false, outcome: { kind: "result", result: results[index]! } as const }));
      return continueAfterTools(state, input, progress, [decisionEvent, ["tool_batch.completed", { effect_id: input.effect_id, batch_id: batch, results }]]);
    }
    const retrySafe = input.retry_safe_call_keys ?? [];
    const callKeys = new Set(calls.map((call) => call.call_key));
    if (new Set(retrySafe).size !== retrySafe.length || retrySafe.some((key) => !callKeys.has(key))) throw new ProtocolError("invalid_retry_safe_set", "retry_safe_call_keys must be a unique subset of current calls");
    const progress: readonly ToolBatchProgressEntry[] = calls.map((call) => ({ call, retry_safe: retrySafe.includes(call.call_key), outcome: { kind: "pending" } }));
    const effect = makeExecute(state, state.revision + 1, batch, progress, calls.map((call) => call.call_key), input.decision.mode, input.decision.max_concurrency);
    return finish(state, input, { status: "awaiting_tools", pending: effect }, [decisionEvent], [effect]);
  }

  if (state.status === "awaiting_tools") {
    if (input.kind !== "tool_batch_completed" && input.kind !== "tool_batch_failed") throw new ProtocolError("invalid_state", "awaiting_tools requires tool outcomes");
    ensureEffect(state, input.effect_id);
    const progress = mergeToolOutcomes(state.pending.progress, state.pending.execute_call_keys, input.outcomes);
    if (progress.some((entry) => entry.outcome.kind === "unknown")) return pauseForUnknown(state, input, state.pending.batch_id, progress);
    if (progress.some((entry) => entry.outcome.kind !== "result")) throw new ProtocolError("incomplete_tool_results", "tool outcomes left pending entries");
    return continueAfterTools(state, input, progress, [["tool_batch.completed", { effect_id: input.effect_id, batch_id: state.pending.batch_id, results: progressResults(progress) }]]);
  }

  if (state.status === "paused") {
    if (input.kind !== "resume") throw new ProtocolError("invalid_state", "paused state requires resume");
    if (input.pause_id !== state.pause.pause_id) throw new ProtocolError("invalid_resume_action", "pause_id does not match current pause");
    if (!pauseAllowsAction(state.pause, input)) throw new ProtocolError("invalid_resume_action", "resume action is not allowed by the current pause");
    if (input.action.kind === "stop") {
      const completion = { reason: "stopped", source: "resume", successful: input.action.successful, output: input.action.output } as const;
      return finish(state, input, { status: "completed", pending: null, completion }, [["run.resumed", { pause_id: input.pause_id, action_kind: "stop" }], ["run.completed", completion]], []);
    }
    if (state.pause.kind === "agent_core") {
      if (input.action.kind !== "continue") throw new ProtocolError("invalid_resume_action", "agent_core pause only accepts continue or stop");
      if (state.turn_index >= state.limits.max_turns) {
        const completion = { reason: "max_turns_reached", successful: false } as const;
        return finish(state, input, { status: "completed", pending: null, completion }, [["run.resumed", { pause_id: input.pause_id, action_kind: "continue" }], ["run.completed", completion]], []);
      }
      const effect = makeRunTurn(state, state.revision + 1, [], input.action.input);
      return finish(state, input, { status: "awaiting_turn", pending: effect }, [["run.resumed", { pause_id: input.pause_id, action_kind: "continue" }], ["turn.requested", { effect_id: effect.effect_id, turn_index: state.turn_index }]], [effect]);
    }
    if (state.pause.kind === "tool_approval") {
      if (input.action.kind === "provide_tool_results") {
        const results = resultsForCalls(input.action.results, state.pause.tool_calls);
        const progress = state.pause.tool_calls.map((call, index) => ({ call, retry_safe: false, outcome: { kind: "result", result: results[index]! } as const }));
        return continueAfterTools(state, input, progress, [["run.resumed", { pause_id: input.pause_id, action_kind: "provide_tool_results" }], ["tool_batch.completed", { effect_id: input.input_id, batch_id: state.pause.batch_id, results }]]);
      }
      if (input.action.kind !== "execute_tools") throw new ProtocolError("invalid_resume_action", "tool_approval pause requires execute_tools, provide_tool_results or stop");
      const action = input.action;
      const keys = state.pause.tool_calls.map((call) => call.call_key);
      if (new Set(action.retry_safe_call_keys).size !== action.retry_safe_call_keys.length || action.retry_safe_call_keys.some((key) => !keys.includes(key))) throw new ProtocolError("invalid_retry_safe_set", "retry_safe_call_keys must be a unique subset of current calls");
      const progress: readonly ToolBatchProgressEntry[] = state.pause.tool_calls.map((call) => ({ call, retry_safe: action.retry_safe_call_keys.includes(call.call_key), outcome: { kind: "pending" } }));
      const effect = makeExecute(state, state.revision + 1, state.pause.batch_id, progress, keys, action.mode, action.max_concurrency);
      return finish(state, input, { status: "awaiting_tools", pending: effect }, [["run.resumed", { pause_id: input.pause_id, action_kind: "execute_tools" }]], [effect]);
    }
    if (state.pause.kind === "uncertain_tools") {
      const pause = state.pause;
      if (input.action.kind === "retry_tool_batch") {
        if (input.action.call_keys.length === 0 || new Set(input.action.call_keys).size !== input.action.call_keys.length) throw new ProtocolError("invalid_resume_action", "retry_tool_batch requires unique call keys");
        const allowed = new Set(pause.progress.filter((entry) => entry.outcome.kind === "unknown" && entry.retry_safe).map((entry) => entry.call.call_key));
        if (input.action.call_keys.some((key) => !allowed.has(key))) throw new ProtocolError("invalid_resume_action", "only retry-safe unknown calls may be retried");
        const selected = new Set(input.action.call_keys);
        const progress = pause.progress.map((entry) => selected.has(entry.call.call_key) ? { ...entry, outcome: { kind: "pending" } as const } : entry);
        const effect = makeExecute(state, state.revision + 1, pause.batch_id, progress, input.action.call_keys, "parallel", Math.max(1, input.action.call_keys.length));
        return finish(state, input, { status: "awaiting_tools", pending: effect }, [["run.resumed", { pause_id: input.pause_id, action_kind: "retry_tool_batch" }]], [effect]);
      }
      if (input.action.kind !== "provide_tool_results") throw new ProtocolError("invalid_resume_action", "uncertain_tools pause requires retry_tool_batch, provide_tool_results or stop");
      const unknown = pause.progress.filter((entry) => entry.outcome.kind === "unknown");
      if (input.action.results.length !== unknown.length) throw new ProtocolError("incomplete_tool_results", "manual results must cover every unknown call");
      const byKey = new Map(input.action.results.map((result) => [result.call_key, result]));
      if (byKey.size !== unknown.length) throw new ProtocolError("incomplete_tool_results", "manual results must uniquely cover every unknown call");
      const progress = pause.progress.map((entry) => {
        if (entry.outcome.kind !== "unknown") return entry;
        const result = byKey.get(entry.call.call_key);
        if (!result) throw new ProtocolError("incomplete_tool_results", "manual results must cover every unknown call");
        resultInputMatchesCall(result, entry.call);
        return { ...entry, outcome: { kind: "result", result } as const };
      });
      return continueAfterTools(state, input, progress, [["run.resumed", { pause_id: input.pause_id, action_kind: "provide_tool_results" }], ["tool_batch.completed", { effect_id: input.input_id, batch_id: pause.batch_id, results: progressResults(progress) }]]);
    }
    throw new ProtocolError("invalid_resume_action", "uncertain_turn is intentionally unsupported by the in-memory runner");
  }

  throw new ProtocolError("invalid_state", "unsupported state transition");
}
