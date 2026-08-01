import { describe, expect, test } from "bun:test";

import {
  ProtocolError,
  validateInput,
  validateJsonValue,
  validateResumeAction,
  validateToolBatchDecision,
  validateTurnOutcome,
} from "../src/protocol";

const continuation = { kind: "inline", value: {} } as const;

describe("protocol boundary", () => {
  test("rejects duplicate provider call_id values within a tool batch", () => {
    expect(() =>
      validateTurnOutcome({
        kind: "tool_calls",
        continuation,
        calls: [
          { call_id: "same", name: "first", arguments: null },
          { call_id: "same", name: "second", arguments: null },
        ],
      }),
    ).toThrow(new ProtocolError("invalid_turn_outcome", "tool call_id values must be unique within the batch"));
  });

  test("rejects empty and blank-id tool batches", () => {
    for (const calls of [[], [{ call_id: "", name: "x", arguments: null }]]) {
      expect(() => validateTurnOutcome({ kind: "tool_calls", continuation, calls })).toThrow(ProtocolError);
    }
  });

  test("rejects an unknown input discriminant", () => {
    expect(() =>
      validateInput({ kind: "mystery", input_id: "i", run_id: "r", expected_revision: 0 }),
    ).toThrow(new ProtocolError("unsupported_variant", "unsupported input kind: mystery"));
  });

  test("rejects malformed turn variants and nested unknown discriminants", () => {
    expect(() => validateTurnOutcome({ kind: "finished", output: null })).toThrow(ProtocolError);
    expect(() => validateInput({
      kind: "tool_decision_completed",
      input_id: "i",
      run_id: "r",
      expected_revision: 0,
      effect_id: "e",
      decision: { kind: "mystery" },
    })).toThrow(new ProtocolError("unsupported_variant", "unsupported tool decision kind: mystery"));
    expect(() => validateInput({
      kind: "resume",
      input_id: "i",
      run_id: "r",
      expected_revision: 0,
      pause_id: "p",
      action: { kind: "mystery" },
    })).toThrow(new ProtocolError("unsupported_variant", "unsupported resume action kind: mystery"));
  });

  test("rejects values that are not JSON", () => {
    expect(() => validateJsonValue({ value: undefined })).toThrow(ProtocolError);
    expect(() => validateJsonValue(Number.NaN)).toThrow(ProtocolError);
  });

  test("validates required payloads for every input family", () => {
    const envelope = { input_id: "i", run_id: "r", expected_revision: 0 };
    const invalidInputs = [
      { kind: "start", input_id: "i", run_id: "r", expected_revision: null },
      { kind: "turn_completed", ...envelope, outcome: { kind: "finished", continuation, output: null } },
      { kind: "turn_failed", ...envelope, effect_id: "e", error: { code: "x" } },
      { kind: "tool_decision_completed", ...envelope, effect_id: "e", decision: { kind: "execute", mode: "parallel", max_concurrency: 1 } },
      { kind: "tool_decision_failed", ...envelope, effect_id: "e" },
      { kind: "tool_batch_completed", ...envelope, effect_id: "e", outcomes: [{ call_key: "k", outcome: { kind: "mystery" } }] },
      { kind: "tool_batch_failed", ...envelope, effect_id: "e", outcomes: [{ call_key: "k", outcome: { kind: "result", result: { call_key: "k", call_id: "c", status: "success" } } }] },
      { kind: "resume", ...envelope, action: { kind: "continue", input: null } },
      { kind: "recover", ...envelope },
      { kind: "cancel", ...envelope },
    ];
    for (const input of invalidInputs) expect(() => validateInput(input)).toThrow(ProtocolError);
  });

  test("rejects unknown nested tool execution outcomes", () => {
    expect(() => validateInput({
      kind: "tool_batch_failed",
      input_id: "i",
      run_id: "r",
      expected_revision: 0,
      effect_id: "e",
      outcomes: [{ call_key: "k", outcome: { kind: "mystery" } }],
    })).toThrow(new ProtocolError("unsupported_variant", "unsupported tool execution outcome kind: mystery"));
  });

  test("accepts only truthful ownership modes", () => {
    const base = {
      kind: "start",
      input_id: "i",
      run_id: "r",
      expected_revision: null,
      continuation,
      limits: { max_turns: 1, input_receipt_window: 1 },
      agent_core_capabilities: {},
      tool_executor_capabilities: {},
    };
    expect(() => validateInput({ ...base, runner_capabilities: { ownership_mode: "shared", atomic_fence_enforcement: false } })).toThrow(ProtocolError);
    expect(() => validateInput({ ...base, runner_capabilities: { ownership_mode: "fenced", atomic_fence_enforcement: false } })).toThrow(ProtocolError);
    expect(() => validateInput({ ...base, runner_capabilities: { ownership_mode: "fenced", atomic_fence_enforcement: true } })).not.toThrow();
  });

  test("rejects fields belonging to a different union variant", () => {
    expect(() => validateInput({
      kind: "cancel",
      input_id: "i",
      run_id: "r",
      expected_revision: 0,
      reason: "stop",
      effect_id: "not-valid-on-cancel",
    })).toThrow(ProtocolError);
    expect(() => validateTurnOutcome({
      kind: "finished",
      continuation,
      output: null,
      calls: [],
    })).toThrow(ProtocolError);
  });

  test("validates nested action enums and sequential concurrency", () => {
    expect(() => validateTurnOutcome({
      kind: "paused",
      continuation,
      reason: "wait",
      resume_schema: {},
      allowed_actions: ["continue", "mystery"],
    })).toThrow(ProtocolError);
    expect(() => validateInput({
      kind: "resume",
      input_id: "i",
      run_id: "r",
      expected_revision: 0,
      pause_id: "p",
      action: { kind: "execute_tools", mode: "sequential", max_concurrency: 2, retry_safe_call_keys: [] },
    })).toThrow(ProtocolError);
  });

  test("closes continuation and resume key variants", () => {
    expect(() => validateTurnOutcome({
      kind: "finished",
      continuation: { kind: "inline", value: {}, reference: "forbidden" },
      output: null,
    })).toThrow(ProtocolError);
    expect(() => validateInput({
      kind: "resume",
      input_id: "i",
      run_id: "r",
      expected_revision: 0,
      pause_id: "p",
      action: { kind: "execute_tools", mode: "parallel", max_concurrency: 1, retry_safe_call_keys: [1] },
    })).toThrow(ProtocolError);
    expect(() => validateInput({
      kind: "resume",
      input_id: "i",
      run_id: "r",
      expected_revision: 0,
      pause_id: "p",
      action: { kind: "retry_tool_batch", call_keys: [] },
    })).toThrow(ProtocolError);
  });

  test("public nested validators reject non-JSON values directly", () => {
    expect(() => validateToolBatchDecision({ kind: "stop", reason: "stop", successful: false, output: undefined })).toThrow(ProtocolError);
    expect(() => validateResumeAction({ kind: "continue", input: undefined })).toThrow(ProtocolError);
  });
});
