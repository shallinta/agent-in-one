import { describe, expect, test } from "bun:test";

import { transition } from "../src/machine";
import type { Input, LoopState, ToolResult } from "../src/protocol";
import { ProtocolError } from "../src/protocol";

const continuation = { kind: "inline", value: { messages: [] } } as const;

function startInput(run_id = "run-a", max_turns = 3): Input {
  return {
    kind: "start",
    input_id: `${run_id}:start`,
    run_id,
    expected_revision: null,
    continuation,
    limits: { max_turns, input_receipt_window: 8 },
    agent_core_capabilities: { idempotent_turns: false },
    tool_executor_capabilities: {},
    runner_capabilities: { ownership_mode: "exclusive", atomic_fence_enforcement: false },
  };
}

function apply(state: LoopState | null, input: Input): LoopState {
  return transition(state, input).state;
}

function completeTurn(state: LoopState, input_id: string, outcome: Extract<Input, { kind: "turn_completed" }>["outcome"]) {
  if (state.pending?.kind !== "run_turn") throw new Error("expected run_turn");
  return transition(state, {
    kind: "turn_completed",
    input_id,
    run_id: state.run_id,
    expected_revision: state.revision,
    effect_id: state.pending.effect_id,
    outcome,
  });
}

describe("pure transition", () => {
  test("start creates deterministic state, effect and ordered events", () => {
    const result = transition(null, startInput());

    expect(result.state).toMatchObject({ run_id: "run-a", revision: 0, status: "awaiting_turn", turn_index: 0 });
    expect(result.effects[0]).toMatchObject({ kind: "run_turn", effect_id: "run-a:0:run_turn:0" });
    expect(result.events).toMatchObject([
      { protocol_version: "1.0.0-draft.2", type: "run.started", sequence: 0, event_id: "run-a:event:0", payload: {}, extensions: {} },
      { protocol_version: "1.0.0-draft.2", type: "turn.requested", sequence: 1, event_id: "run-a:event:1", payload: { effect_id: "run-a:0:run_turn:0", turn_index: 0 }, extensions: {} },
    ]);
    expect(result.events[0]).not.toHaveProperty("kind");
  });

  test("finished outcome completes the run", () => {
    const started = apply(null, startInput());
    const result = completeTurn(started, "turn-1", { kind: "finished", continuation, output: { answer: 42 } });

    expect(result.effects).toEqual([]);
    expect(result.state).toMatchObject({ status: "completed", revision: 1, turn_index: 1, completion: { reason: "finished", output: { answer: 42 } } });
  });

  test("provider call_id may repeat across batches while call_key stays unique", () => {
    let state = completeTurn(apply(null, startInput()), "t1", {
      kind: "tool_calls",
      continuation,
      calls: [{ call_id: "provider-1", name: "first", arguments: null }],
    }).state;
    expect(state.pending).toMatchObject({ kind: "decide_tool_batch", calls: [{ call_key: "run-a:tool-batch:1:0" }] });
    if (state.pending?.kind !== "decide_tool_batch") throw new Error("expected decision");
    state = apply(state, {
      kind: "tool_decision_completed",
      input_id: "d1",
      run_id: state.run_id,
      expected_revision: state.revision,
      effect_id: state.pending.effect_id,
      decision: { kind: "supply", results: [{ call_key: "run-a:tool-batch:1:0", call_id: "provider-1", status: "success", output: 1 }] },
    });
    state = completeTurn(state, "t2", {
      kind: "tool_calls",
      continuation,
      calls: [{ call_id: "provider-1", name: "second", arguments: null }],
    }).state;
    expect(state.pending).toMatchObject({ kind: "decide_tool_batch", calls: [{ call_key: "run-a:tool-batch:2:0", call_id: "provider-1" }] });
  });

  test("unknown outcomes pause, safe retry preserves order, and manual results cover every unknown", () => {
    let state = completeTurn(apply(null, startInput()), "turn", {
      kind: "tool_calls",
      continuation,
      calls: [
        { call_id: "a", name: "a", arguments: null },
        { call_id: "b", name: "b", arguments: null },
        { call_id: "c", name: "c", arguments: null },
      ],
    }).state;
    if (state.pending?.kind !== "decide_tool_batch") throw new Error("expected decision");
    state = apply(state, {
      kind: "tool_decision_completed",
      input_id: "decision",
      run_id: state.run_id,
      expected_revision: state.revision,
      effect_id: state.pending.effect_id,
      decision: { kind: "execute", mode: "parallel", max_concurrency: 3 },
      retry_safe_call_keys: ["run-a:tool-batch:1:1"],
    });
    if (state.pending?.kind !== "execute_tool_batch") throw new Error("expected tools");
    const first: ToolResult = { call_key: "run-a:tool-batch:1:0", call_id: "a", status: "success", output: "A" };
    state = apply(state, {
      kind: "tool_batch_failed",
      input_id: "tools",
      run_id: state.run_id,
      expected_revision: state.revision,
      effect_id: state.pending.effect_id,
      outcomes: [
        { call_key: "run-a:tool-batch:1:0", outcome: { kind: "result", result: first } },
        { call_key: "run-a:tool-batch:1:1", outcome: { kind: "unknown" } },
        { call_key: "run-a:tool-batch:1:2", outcome: { kind: "unknown" } },
      ],
    });
    expect(state).toMatchObject({ status: "paused", pause: { kind: "uncertain_tools" } });

    expect(() => apply(state, {
      kind: "resume",
      input_id: "bad-retry",
      run_id: state.run_id,
      expected_revision: state.revision,
      pause_id: state.status === "paused" ? state.pause.pause_id : "",
      action: { kind: "retry_tool_batch", call_keys: ["run-a:tool-batch:1:2"] },
    })).toThrow(new ProtocolError("invalid_resume_action", "only retry-safe unknown calls may be retried"));

    state = apply(state, {
      kind: "resume",
      input_id: "retry",
      run_id: state.run_id,
      expected_revision: state.revision,
      pause_id: state.status === "paused" ? state.pause.pause_id : "",
      action: { kind: "retry_tool_batch", call_keys: ["run-a:tool-batch:1:1"] },
    });
    expect(state.pending).toMatchObject({ execute_call_keys: ["run-a:tool-batch:1:1"] });
    expect(state).not.toHaveProperty("pause");
    if (state.pending?.kind !== "execute_tool_batch") throw new Error("expected retry");
    state = apply(state, {
      kind: "tool_batch_completed",
      input_id: "retry-result",
      run_id: state.run_id,
      expected_revision: state.revision,
      effect_id: state.pending.effect_id,
      outcomes: [{ call_key: "run-a:tool-batch:1:1", outcome: { kind: "result", result: { call_key: "run-a:tool-batch:1:1", call_id: "b", status: "success", output: "B" } } }],
    });
    expect(state).toMatchObject({ status: "paused", pause: { kind: "uncertain_tools" } });

    state = apply(state, {
      kind: "resume",
      input_id: "manual",
      run_id: state.run_id,
      expected_revision: state.revision,
      pause_id: state.status === "paused" ? state.pause.pause_id : "",
      action: { kind: "provide_tool_results", results: [{ call_key: "run-a:tool-batch:1:2", call_id: "c", status: "success", output: "C" }] },
    });
    expect(state.pending).toMatchObject({ kind: "run_turn", tool_results: [first, { output: "B" }, { output: "C" }] });
    expect(state).not.toHaveProperty("pause");
  });

  test("duplicate receipts are no-ops before revision checks", () => {
    const state = apply(null, startInput());
    if (state.pending?.kind !== "run_turn") throw new Error("expected turn");
    const input: Input = { kind: "turn_completed", input_id: "same", run_id: state.run_id, expected_revision: state.revision, effect_id: state.pending.effect_id, outcome: { kind: "finished", continuation, output: null } };
    const once = transition(state, input).state;
    const duplicate = transition(once, input);
    expect(duplicate).toEqual({ state: once, effects: [], events: [] });
  });

  test("rejects stale revisions and mismatched effect ids", () => {
    const state = apply(null, startInput());
    if (state.pending?.kind !== "run_turn") throw new Error("expected turn");
    expect(() => transition(state, { kind: "cancel", input_id: "cancel", run_id: state.run_id, expected_revision: 99, reason: "no" })).toThrow(ProtocolError);
    expect(() => transition(state, { kind: "turn_completed", input_id: "wrong", run_id: state.run_id, expected_revision: state.revision, effect_id: "wrong", outcome: { kind: "finished", continuation, output: null } })).toThrow(new ProtocolError("effect_mismatch", "effect_id does not match pending effect"));
  });

  test("last allowed turn may execute tools but does not request another turn", () => {
    let state = completeTurn(apply(null, startInput("run-last", 1)), "turn", {
      kind: "tool_calls",
      continuation,
      calls: [{ call_id: "x", name: "write", arguments: null }],
    }).state;
    if (state.pending?.kind !== "decide_tool_batch") throw new Error("expected decision");
    state = apply(state, { kind: "tool_decision_completed", input_id: "decision", run_id: state.run_id, expected_revision: state.revision, effect_id: state.pending.effect_id, decision: { kind: "execute", mode: "sequential", max_concurrency: 1 }, retry_safe_call_keys: [] });
    if (state.pending?.kind !== "execute_tool_batch") throw new Error("expected tools");
    state = apply(state, { kind: "tool_batch_completed", input_id: "tools", run_id: state.run_id, expected_revision: state.revision, effect_id: state.pending.effect_id, outcomes: [{ call_key: "run-last:tool-batch:1:0", outcome: { kind: "result", result: { call_key: "run-last:tool-batch:1:0", call_id: "x", status: "success", output: true } } }] });
    expect(state).toMatchObject({ status: "completed", completion: { reason: "max_turns_reached" } });
  });

  test("cancel transitions to a terminal state", () => {
    const state = apply(null, startInput());
    const cancelled = transition(state, { kind: "cancel", input_id: "cancel", run_id: state.run_id, expected_revision: state.revision, reason: "user" });
    expect(cancelled.state).toMatchObject({ status: "cancelled", cancellation: { reason: "user" } });
    expect(cancelled.effects).toEqual([]);
  });

  test("learning implementation rejects recover rather than replaying an unsafe effect", () => {
    const state = apply(null, startInput());
    if (state.pending?.kind !== "run_turn") throw new Error("expected turn");
    const effectId = state.pending.effect_id;
    expect(() => transition(state, {
      kind: "recover",
      input_id: "recover",
      run_id: state.run_id,
      expected_revision: state.revision,
      effect_id: effectId,
    })).toThrow(new ProtocolError("unsupported_variant", "recover is not supported by the in-memory reference"));
  });

  test("late cancel cannot replace completed or failed terminal states", () => {
    const started = apply(null, startInput());
    const completed = completeTurn(started, "finish", { kind: "finished", continuation, output: null }).state;
    expect(() => transition(completed, { kind: "cancel", input_id: "late", run_id: completed.run_id, expected_revision: completed.revision, reason: "late" })).toThrow(ProtocolError);

    if (started.pending?.kind !== "run_turn") throw new Error("expected turn");
    const failed = apply(started, { kind: "turn_failed", input_id: "fail", run_id: started.run_id, expected_revision: started.revision, effect_id: started.pending.effect_id, error: { code: "failed", message: "failed", retryable: false, details: {} } });
    expect(() => transition(failed, { kind: "cancel", input_id: "late-2", run_id: failed.run_id, expected_revision: failed.revision, reason: "late" })).toThrow(ProtocolError);
  });

  test("resume action must be authorized by the current pause", () => {
    const started = apply(null, startInput());
    const paused = completeTurn(started, "pause", {
      kind: "paused",
      continuation,
      reason: "manual stop only",
      resume_schema: {},
      allowed_actions: ["stop"],
    }).state;
    if (paused.status !== "paused") throw new Error("expected pause");
    expect(() => transition(paused, {
      kind: "resume",
      input_id: "unauthorized",
      run_id: paused.run_id,
      expected_revision: paused.revision,
      pause_id: paused.pause.pause_id,
      action: { kind: "continue", input: null },
    })).toThrow(new ProtocolError("invalid_resume_action", "resume action is not allowed by the current pause"));
  });

  test("resuming an agent pause removes pause-only fields", () => {
    const started = apply(null, startInput());
    const paused = completeTurn(started, "pause", {
      kind: "paused",
      continuation,
      reason: "choose",
      resume_schema: {},
      allowed_actions: ["continue", "stop"],
    }).state;
    if (paused.status !== "paused") throw new Error("expected pause");
    const continued = apply(paused, { kind: "resume", input_id: "continue", run_id: paused.run_id, expected_revision: paused.revision, pause_id: paused.pause.pause_id, action: { kind: "continue", input: null } });
    expect(continued).toMatchObject({ status: "awaiting_turn" });
    expect(continued).not.toHaveProperty("pause");

    const stopped = apply(paused, { kind: "resume", input_id: "stop", run_id: paused.run_id, expected_revision: paused.revision, pause_id: paused.pause.pause_id, action: { kind: "stop", reason: "done", successful: false, output: null } });
    expect(stopped).toMatchObject({ status: "completed", completion: { reason: "stopped" } });
    expect(stopped).not.toHaveProperty("pause");
  });

  test("resuming tool approval removes pause-only fields", () => {
    let state = completeTurn(apply(null, startInput()), "calls", {
      kind: "tool_calls",
      continuation,
      calls: [{ call_id: "x", name: "x", arguments: null }],
    }).state;
    if (state.pending?.kind !== "decide_tool_batch") throw new Error("expected decision");
    state = apply(state, { kind: "tool_decision_completed", input_id: "policy-pause", run_id: state.run_id, expected_revision: state.revision, effect_id: state.pending.effect_id, decision: { kind: "pause", reason: "approve" } });
    if (state.status !== "paused" || state.pause.kind !== "tool_approval") throw new Error("expected tool approval");
    const execute = apply(state, { kind: "resume", input_id: "execute", run_id: state.run_id, expected_revision: state.revision, pause_id: state.pause.pause_id, action: { kind: "execute_tools", mode: "sequential", max_concurrency: 1, retry_safe_call_keys: [] } });
    expect(execute.status).toBe("awaiting_tools");
    expect(execute).not.toHaveProperty("pause");

    const supplied = apply(state, { kind: "resume", input_id: "supply", run_id: state.run_id, expected_revision: state.revision, pause_id: state.pause.pause_id, action: { kind: "provide_tool_results", results: [{ call_key: "run-a:tool-batch:1:0", call_id: "x", status: "success", output: "ok" }] } });
    expect(supplied.status).toBe("awaiting_turn");
    expect(supplied).not.toHaveProperty("pause");
  });

  test("continuing an agent pause at max turns completes without another turn", () => {
    const started = apply(null, startInput("max-pause", 1));
    const paused = completeTurn(started, "pause-at-limit", {
      kind: "paused",
      continuation,
      reason: "human input",
      resume_schema: {},
      allowed_actions: ["continue", "stop"],
    }).state;
    if (paused.status !== "paused") throw new Error("expected pause");
    const resumed = transition(paused, {
      kind: "resume",
      input_id: "continue-at-limit",
      run_id: paused.run_id,
      expected_revision: paused.revision,
      pause_id: paused.pause.pause_id,
      action: { kind: "continue", input: "ignored-at-limit" },
    });
    expect(resumed.state).toMatchObject({ status: "completed", turn_index: 1, completion: { reason: "max_turns_reached" } });
    expect(resumed.effects).toEqual([]);
  });
});
