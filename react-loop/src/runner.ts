import { transition } from "./machine";
import {
  ProtocolError,
  validateInput,
  validateToolBatchDecision,
  validateToolResult,
  validateTurnOutcome,
  type Effect,
  type Input,
  type JsonValue,
  type LoopState,
  type NormalizedToolCall,
  type ProtocolFailure,
  type ResumeAction,
  type ToolBatchDecision,
  type ToolExecutionOutcome,
  type ToolResult,
  type TurnOutcome,
} from "./protocol";
import type { LoopStore } from "./store";

export interface AgentCoreAdapter {
  run(effect: Extract<Effect, { kind: "run_turn" }>, committedState: LoopState): Promise<TurnOutcome>;
}

export interface LoopPolicy {
  decide(effect: Extract<Effect, { kind: "decide_tool_batch" }>, committedState: LoopState): Promise<ToolBatchDecision>;
}

export interface ToolExecutor {
  execute(call: NormalizedToolCall, context: { readonly effect_id: string; readonly idempotency_key: string }): Promise<ToolResult>;
  isRetrySafe(call: NormalizedToolCall): boolean | Promise<boolean>;
}

export interface RunnerDependencies {
  readonly store: LoopStore;
  readonly agent_core: AgentCoreAdapter;
  readonly policy: LoopPolicy;
  readonly tool_executor: ToolExecutor;
}

export const inMemoryRunnerCapabilities = {
  durable_state: false,
  crash_recovery: false,
  store_compare_and_swap: true,
  atomic_transition_records: true,
  replayable_events: false,
  effect_ownership: false,
  ownership_mode: "exclusive",
  atomic_fence_enforcement: false,
} as const;

function validateInMemoryCapabilities(input: Extract<Input, { kind: "start" }>): void {
  for (const [key, expected] of Object.entries(inMemoryRunnerCapabilities)) {
    if (input.runner_capabilities[key] !== expected) {
      throw new ProtocolError("invalid_input", `runner_capabilities.${key} must be ${String(expected)} for the in-memory runner`);
    }
  }
}

function failure(code: string, error: unknown): ProtocolFailure {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    details: {},
  };
}

async function mapWithConcurrency<T, R>(values: readonly T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<readonly PromiseSettledResult<R>[]> {
  const output: PromiseSettledResult<R>[] = new Array(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      const value = values[index]!;
      try {
        output[index] = { status: "fulfilled", value: await mapper(value) };
      } catch (reason) {
        output[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()));
  return output;
}

export class InMemoryReactLoopRunner {
  readonly #store: LoopStore;
  readonly #agentCore: AgentCoreAdapter;
  readonly #policy: LoopPolicy;
  readonly #tools: ToolExecutor;

  constructor(dependencies: RunnerDependencies) {
    this.#store = dependencies.store;
    this.#agentCore = dependencies.agent_core;
    this.#policy = dependencies.policy;
    this.#tools = dependencies.tool_executor;
  }

  async start(input: Extract<Input, { kind: "start" }>): Promise<LoopState> {
    validateInput(input);
    validateInMemoryCapabilities(input);
    const initial = transition(null, input);
    const commit = await this.#store.createRun(initial);
    if (commit.kind === "conflict") {
      const authoritative = await this.#store.loadState(input.run_id);
      if (authoritative?.input_receipts.some((receipt) => receipt.input_id === input.input_id)) return authoritative;
      throw new ProtocolError("run_id_conflict", "run_id already exists with a different start input");
    }
    return this.#drive(initial.state);
  }

  async getState(runId: string): Promise<LoopState | null> {
    return this.#store.loadState(runId);
  }

  async resume(runId: string, action: ResumeAction, inputId: string): Promise<LoopState> {
    const state = await this.#requireState(runId);
    if (state.status !== "paused") throw new ProtocolError("invalid_state", "run is not paused");
    let effectiveAction = action;
    if (state.pause.kind === "tool_approval" && action.kind === "execute_tools") {
      const safe: string[] = [];
      for (const call of state.pause.tool_calls) if (await this.#tools.isRetrySafe(call)) safe.push(call.call_key);
      effectiveAction = { ...action, retry_safe_call_keys: safe };
    }
    const input: Input = {
      kind: "resume",
      input_id: inputId,
      run_id: runId,
      expected_revision: state.revision,
      pause_id: state.pause.pause_id,
      action: effectiveAction,
    };
    return this.#commitAndDrive(state, input);
  }

  async cancel(runId: string, reason: string, inputId: string): Promise<LoopState> {
    const state = await this.#requireState(runId);
    const input: Input = {
      kind: "cancel",
      input_id: inputId,
      run_id: runId,
      expected_revision: state.revision,
      reason,
    };
    return this.#commitAndDrive(state, input);
  }

  async #requireState(runId: string): Promise<LoopState> {
    const state = await this.#store.loadState(runId);
    if (!state) throw new ProtocolError("invalid_state", `run does not exist: ${runId}`);
    return state;
  }

  async #commitAndDrive(state: LoopState, input: Input): Promise<LoopState> {
    validateInput(input);
    const result = transition(state, input);
    if (result.state === state && result.effects.length === 0 && result.events.length === 0) return state;
    const commit = await this.#store.commitTransition(result, state.revision);
    if (commit.kind === "conflict") return this.#resolveConflict(state.run_id, input.input_id);
    return this.#drive(result.state);
  }

  async #drive(initial: LoopState): Promise<LoopState> {
    let state = initial;
    while (state.pending) {
      const input = await this.#interpret(state.pending, state);
      validateInput(input);
      const result = transition(state, input);
      const commit = await this.#store.commitTransition(result, state.revision);
      if (commit.kind === "conflict") return this.#resolveConflict(state.run_id, input.input_id);
      state = result.state;
    }
    return state;
  }

  async #resolveConflict(runId: string, inputId: string): Promise<LoopState> {
    const authoritative = await this.#store.loadState(runId);
    if (authoritative?.input_receipts.some((receipt) => receipt.input_id === inputId)) return authoritative;
    throw new ProtocolError("concurrent_update", "authoritative state advanced without this input receipt");
  }

  async #interpret(effect: Effect, committedState: LoopState): Promise<Input> {
    if (effect.kind === "run_turn") {
      try {
        const outcome = await this.#agentCore.run(effect, committedState);
        validateTurnOutcome(outcome);
        return {
          kind: "turn_completed",
          input_id: `${effect.effect_id}:result`,
          run_id: effect.run_id,
          expected_revision: committedState.revision,
          effect_id: effect.effect_id,
          outcome,
        };
      } catch (error) {
        return {
          kind: "turn_failed",
          input_id: `${effect.effect_id}:result`,
          run_id: effect.run_id,
          expected_revision: committedState.revision,
          effect_id: effect.effect_id,
          error: failure("agent_core_failed", error),
        };
      }
    }
    if (effect.kind === "decide_tool_batch") {
      try {
        const decision = await this.#policy.decide(effect, committedState);
        validateToolBatchDecision(decision);
        let retrySafe: readonly string[] | undefined;
        if (decision.kind === "execute") {
          const safe: string[] = [];
          for (const call of effect.calls) if (await this.#tools.isRetrySafe(call)) safe.push(call.call_key);
          retrySafe = safe;
        }
        const base = {
          kind: "tool_decision_completed" as const,
          input_id: `${effect.effect_id}:result`,
          run_id: effect.run_id,
          expected_revision: committedState.revision,
          effect_id: effect.effect_id,
          decision,
        };
        return retrySafe === undefined ? base : { ...base, retry_safe_call_keys: retrySafe };
      } catch (error) {
        return {
          kind: "tool_decision_failed",
          input_id: `${effect.effect_id}:result`,
          run_id: effect.run_id,
          expected_revision: committedState.revision,
          effect_id: effect.effect_id,
          error: failure("tool_policy_failed", error),
        };
      }
    }

    const entries = effect.execute_call_keys.map((key) => {
      const entry = effect.progress.find((candidate) => candidate.call.call_key === key);
      if (!entry) throw new ProtocolError("invalid_state", `missing progress entry for ${key}`);
      return entry;
    });
    const settled = effect.mode === "sequential"
      ? await mapWithConcurrency(entries, 1, (entry) => this.#tools.execute(entry.call, { effect_id: effect.effect_id, idempotency_key: entry.call.call_key }))
      : await mapWithConcurrency(entries, effect.max_concurrency, (entry) => this.#tools.execute(entry.call, { effect_id: effect.effect_id, idempotency_key: entry.call.call_key }));
    const outcomes: ToolExecutionOutcome[] = settled.map((item, index) => {
      const call = entries[index]!.call;
      if (item.status === "fulfilled") {
        try {
          validateToolResult(item.value);
          if (item.value.call_key !== call.call_key || item.value.call_id !== call.call_id) throw new ProtocolError("tool_result_mismatch", "tool result does not match executed call");
          return { call_key: call.call_key, outcome: { kind: "result", result: item.value } };
        } catch {
          return { call_key: call.call_key, outcome: { kind: "unknown" } };
        }
      }
      return { call_key: call.call_key, outcome: { kind: "unknown" } };
    });
    const hasUnknown = outcomes.some((outcome) => outcome.outcome.kind === "unknown");
    return {
      kind: hasUnknown ? "tool_batch_failed" : "tool_batch_completed",
      input_id: `${effect.effect_id}:result`,
      run_id: effect.run_id,
      expected_revision: committedState.revision,
      effect_id: effect.effect_id,
      outcomes,
    };
  }
}
