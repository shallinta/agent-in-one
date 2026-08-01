import { describe, expect, test } from "bun:test";

import type { Input, ToolBatchDecision, ToolResult, TurnOutcome } from "../src/protocol";
import { ProtocolError } from "../src/protocol";
import { InMemoryReactLoopRunner, inMemoryRunnerCapabilities } from "../src/runner";
import { InMemoryLoopStore, type CommittedTransitionRecord, type LoopStore, type StoreCommitResult } from "../src/store";
import type { TransitionResult } from "../src/machine";
import { transition } from "../src/machine";
import { ScriptedAgentCore, ScriptedPolicy, ScriptedToolExecutor } from "../src/testing";

const continuation = { kind: "inline", value: {} } as const;

function start(run_id: string): Extract<Input, { kind: "start" }> {
  return {
    kind: "start",
    input_id: `${run_id}:start`,
    run_id,
    expected_revision: null,
    continuation,
    limits: { max_turns: 4, input_receipt_window: 32 },
    agent_core_capabilities: {},
    tool_executor_capabilities: {},
    runner_capabilities: inMemoryRunnerCapabilities,
  };
}

function success(call_key: string, call_id: string, output: string): ToolResult {
  return { call_key, call_id, status: "success", output };
}

describe("InMemoryReactLoopRunner", () => {
  test("commits before effects and restores parallel tool results to source order", async () => {
    const store = new InMemoryLoopStore();
    const agent = new ScriptedAgentCore([
      { kind: "tool_calls", continuation, calls: [
        { call_id: "slow", name: "slow", arguments: null },
        { call_id: "fast", name: "fast", arguments: null },
      ] },
      { kind: "finished", continuation, output: "done" },
    ]);
    const policy = new ScriptedPolicy([{ kind: "execute", mode: "parallel", max_concurrency: 2 }]);
    const tools = new ScriptedToolExecutor(async (call) => {
      await Bun.sleep(call.name === "slow" ? 15 : 1);
      return success(call.call_key, call.call_id, call.name.toUpperCase());
    });
    const runner = new InMemoryReactLoopRunner({ store, agent_core: agent, policy, tool_executor: tools });

    const final = await runner.start(start("ordered"));

    expect(final).toMatchObject({ status: "completed", completion: { reason: "finished" } });
    expect(agent.requests[1]?.tool_results.map((result) => result.status === "success" ? result.output : result.error.code)).toEqual(["SLOW", "FAST"]);
    const records = [];
    for await (const record of store.readRecords("ordered")) records.push(record);
    expect(records.map((record) => record.record_sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(agent.observed_revisions).toEqual([0, 3]);
  });

  test("unknown execution pauses and retrying a safe call resumes", async () => {
    const agent = new ScriptedAgentCore([
      { kind: "tool_calls", continuation, calls: [{ call_id: "x", name: "flaky", arguments: null }] },
      { kind: "finished", continuation, output: "recovered" },
    ]);
    let attempt = 0;
    const tools = new ScriptedToolExecutor(async (call) => {
      attempt += 1;
      if (attempt === 1) throw new Error("connection lost after dispatch");
      return success(call.call_key, call.call_id, "ok");
    }, new Set(["flaky"]));
    const runner = new InMemoryReactLoopRunner({ store: new InMemoryLoopStore(), agent_core: agent, policy: new ScriptedPolicy([{ kind: "execute", mode: "parallel", max_concurrency: 1 }]), tool_executor: tools });

    const paused = await runner.start(start("retry"));
    expect(paused).toMatchObject({ status: "paused", pause: { kind: "uncertain_tools" } });
    if (paused.status !== "paused" || paused.pause.kind !== "uncertain_tools") throw new Error("expected uncertain pause");
    const final = await runner.resume("retry", { kind: "retry_tool_batch", call_keys: [paused.pause.progress[0]!.call.call_key] }, "retry-command");
    expect(final).toMatchObject({ status: "completed", completion: { reason: "finished" } });
  });

  test("uses call_key as the stable per-tool idempotency key across retry", async () => {
    const contexts: { effect_id: string; idempotency_key: string }[] = [];
    let attempt = 0;
    const runner = new InMemoryReactLoopRunner({
      store: new InMemoryLoopStore(),
      agent_core: new ScriptedAgentCore([
        { kind: "tool_calls", continuation, calls: [{ call_id: "x", name: "safe", arguments: null }] },
        { kind: "finished", continuation, output: "done" },
      ]),
      policy: new ScriptedPolicy([{ kind: "execute", mode: "parallel", max_concurrency: 1 }]),
      tool_executor: {
        isRetrySafe: () => true,
        execute: async (call, context) => {
          contexts.push(context);
          attempt += 1;
          if (attempt === 1) throw new Error("unknown");
          return success(call.call_key, call.call_id, "ok");
        },
      },
    });
    const paused = await runner.start(start("stable-key"));
    if (paused.status !== "paused" || paused.pause.kind !== "uncertain_tools") throw new Error("expected uncertain pause");
    await runner.resume("stable-key", { kind: "retry_tool_batch", call_keys: [paused.pause.progress[0]!.call.call_key] }, "stable-retry-command");
    expect(contexts.map((context) => context.idempotency_key)).toEqual(["stable-key:tool-batch:1:0", "stable-key:tool-batch:1:0"]);
    expect(contexts[0]?.effect_id).not.toBe(contexts[1]?.effect_id);
  });

  test("agent pause can resume with input and cancel is terminal", async () => {
    const agent = new ScriptedAgentCore([
      { kind: "paused", continuation, reason: "question", resume_schema: {}, allowed_actions: ["continue", "stop"] },
      { kind: "finished", continuation, output: "answered" },
    ]);
    const runner = new InMemoryReactLoopRunner({ store: new InMemoryLoopStore(), agent_core: agent, policy: new ScriptedPolicy([]), tool_executor: new ScriptedToolExecutor(async () => { throw new Error("unused"); }) });
    const paused = await runner.start(start("human"));
    expect(paused.status).toBe("paused");
    const final = await runner.resume("human", { kind: "continue", input: { answer: "yes" } }, "human-continue");
    expect(final.status).toBe("completed");
    expect(agent.requests[1]?.resume_input).toEqual({ answer: "yes" });

    const cancelRunner = new InMemoryReactLoopRunner({ store: new InMemoryLoopStore(), agent_core: new ScriptedAgentCore([{ kind: "paused", continuation, reason: "wait", resume_schema: {}, allowed_actions: ["continue", "stop"] }]), policy: new ScriptedPolicy([]), tool_executor: new ScriptedToolExecutor(async () => { throw new Error("unused"); }) });
    await cancelRunner.start(start("cancel-me"));
    const cancelled = await cancelRunner.cancel("cancel-me", "user requested", "cancel-command");
    expect(cancelled).toMatchObject({ status: "cancelled", cancellation: { reason: "user requested" } });
    expect(await cancelRunner.cancel("cancel-me", "duplicate request", "cancel-command")).toEqual(cancelled);
  });

  test("policy stop completes without executing tools", async () => {
    const tools = new ScriptedToolExecutor(async () => { throw new Error("must not execute"); });
    const runner = new InMemoryReactLoopRunner({
      store: new InMemoryLoopStore(),
      agent_core: new ScriptedAgentCore([{ kind: "tool_calls", continuation, calls: [{ call_id: "x", name: "danger", arguments: null }] }]),
      policy: new ScriptedPolicy([{ kind: "stop", reason: "policy", successful: false, output: null }]),
      tool_executor: tools,
    });
    expect(await runner.start(start("stopped"))).toMatchObject({ status: "completed", completion: { reason: "stopped", source: "policy" } });
    expect(tools.requests).toEqual([]);
  });

  test("rejects caller claims that exceed in-memory runner capabilities", async () => {
    const runner = new InMemoryReactLoopRunner({
      store: new InMemoryLoopStore(),
      agent_core: new ScriptedAgentCore([{ kind: "finished", continuation, output: null }]),
      policy: new ScriptedPolicy([]),
      tool_executor: new ScriptedToolExecutor(async () => { throw new Error("unused"); }),
    });
    await expect(runner.start({
      ...start("lying"),
      runner_capabilities: { ...inMemoryRunnerCapabilities, crash_recovery: true, ownership_mode: "fenced", atomic_fence_enforcement: true },
    } as Extract<Input, { kind: "start" }>)).rejects.toMatchObject({ code: "invalid_input" });
  });

  test("CAS conflict reloads an idempotently committed receipt", async () => {
    const store = new ConflictOnceStore("same_input");
    const runner = new InMemoryReactLoopRunner({
      store,
      agent_core: new ScriptedAgentCore([{ kind: "finished", continuation, output: "done" }]),
      policy: new ScriptedPolicy([]),
      tool_executor: new ScriptedToolExecutor(async () => { throw new Error("unused"); }),
    });
    expect(await runner.start(start("same-writer"))).toMatchObject({ status: "completed", completion: { reason: "finished" } });
  });

  test("CAS conflict without the receipt reports concurrent_update", async () => {
    const runner = new InMemoryReactLoopRunner({
      store: new ConflictOnceStore("different_input"),
      agent_core: new ScriptedAgentCore([{ kind: "finished", continuation, output: "done" }]),
      policy: new ScriptedPolicy([]),
      tool_executor: new ScriptedToolExecutor(async () => { throw new Error("unused"); }),
    });
    await expect(runner.start(start("other-writer"))).rejects.toEqual(new ProtocolError("concurrent_update", "authoritative state advanced without this input receipt"));
  });

  test("start create-if-absent conflict distinguishes retry from run id collision", async () => {
    const runner = new InMemoryReactLoopRunner({
      store: new InMemoryLoopStore(),
      agent_core: new ScriptedAgentCore([{ kind: "finished", continuation, output: "done" }]),
      policy: new ScriptedPolicy([]),
      tool_executor: new ScriptedToolExecutor(async () => { throw new Error("unused"); }),
    });
    const input = start("start-retry");
    const completed = await runner.start(input);
    expect(await runner.start(input)).toEqual(completed);
    await expect(runner.start({ ...input, input_id: "different-start" })).rejects.toMatchObject({ code: "run_id_conflict" });
  });

  test("README echo example completes", async () => {
    const runner = new InMemoryReactLoopRunner({
      store: new InMemoryLoopStore(),
      agent_core: new ScriptedAgentCore([
        { kind: "tool_calls", continuation, calls: [{ call_id: "provider-call-1", name: "echo", arguments: "hello" }] },
        { kind: "finished", continuation, output: "done" },
      ]),
      policy: new ScriptedPolicy([{ kind: "execute", mode: "sequential", max_concurrency: 1 }]),
      tool_executor: new ScriptedToolExecutor(async (call) => ({ call_key: call.call_key, call_id: call.call_id, status: "success", output: call.arguments })),
    });
    const final = await runner.start({
      ...start("readme-example"),
      input_id: "readme-example:start",
      runner_capabilities: inMemoryRunnerCapabilities,
    });
    expect(final.status).toBe("completed");
  });

  test("distinct concurrent resume commands cannot share an input receipt", async () => {
    const runner = new InMemoryReactLoopRunner({
      store: new InMemoryLoopStore(),
      agent_core: new ScriptedAgentCore([
        { kind: "paused", continuation, reason: "choose", resume_schema: {}, allowed_actions: ["continue", "stop"] },
        { kind: "finished", continuation, output: "continued" },
      ]),
      policy: new ScriptedPolicy([]),
      tool_executor: new ScriptedToolExecutor(async () => { throw new Error("unused"); }),
    });
    await runner.start(start("concurrent-resume"));
    const settled = await Promise.allSettled([
      runner.resume("concurrent-resume", { kind: "continue", input: null }, "continue-command"),
      runner.resume("concurrent-resume", { kind: "stop", reason: "stop", successful: false, output: null }, "stop-command"),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected").map((result) => result.reason.code)).toEqual(["concurrent_update"]);
  });

  test("normalizes resolved malformed AgentCore output into a failed state", async () => {
    const runner = new InMemoryReactLoopRunner({
      store: new InMemoryLoopStore(),
      agent_core: { run: async () => ({ kind: "finished", continuation, output: undefined }) as unknown as TurnOutcome },
      policy: new ScriptedPolicy([]),
      tool_executor: new ScriptedToolExecutor(async () => { throw new Error("unused"); }),
    });
    expect(await runner.start(start("bad-agent"))).toMatchObject({ status: "failed", error: { code: "agent_core_failed" } });
  });

  test("normalizes resolved malformed Policy output into a failed state", async () => {
    const runner = new InMemoryReactLoopRunner({
      store: new InMemoryLoopStore(),
      agent_core: new ScriptedAgentCore([{ kind: "tool_calls", continuation, calls: [{ call_id: "x", name: "x", arguments: null }] }]),
      policy: { decide: async () => ({ kind: "execute", mode: "invalid", max_concurrency: 1 }) as unknown as ToolBatchDecision },
      tool_executor: new ScriptedToolExecutor(async () => { throw new Error("unused"); }),
    });
    expect(await runner.start(start("bad-policy"))).toMatchObject({ status: "failed", error: { code: "tool_policy_failed" } });
  });

  test("normalizes fulfilled malformed ToolExecutor output into unknown pause", async () => {
    const runner = new InMemoryReactLoopRunner({
      store: new InMemoryLoopStore(),
      agent_core: new ScriptedAgentCore([{ kind: "tool_calls", continuation, calls: [{ call_id: "x", name: "x", arguments: null }] }]),
      policy: new ScriptedPolicy([{ kind: "execute", mode: "sequential", max_concurrency: 1 }]),
      tool_executor: {
        isRetrySafe: () => false,
        execute: async (call) => ({ call_key: call.call_key, call_id: call.call_id, status: "success" }) as unknown as ToolResult,
      },
    });
    expect(await runner.start(start("bad-tool"))).toMatchObject({ status: "paused", pause: { kind: "uncertain_tools", progress: [{ outcome: { kind: "unknown" } }] } });
  });
});

class ConflictOnceStore implements LoopStore {
  readonly #delegate = new InMemoryLoopStore();
  #didConflict = false;

  constructor(private readonly mode: "same_input" | "different_input") {}

  loadState(runId: string) {
    return this.#delegate.loadState(runId);
  }

  createRun(result: TransitionResult) {
    return this.#delegate.createRun(result);
  }

  async commitTransition(result: TransitionResult, expectedRevision: number): Promise<StoreCommitResult> {
    if (this.#didConflict) return this.#delegate.commitTransition(result, expectedRevision);
    this.#didConflict = true;
    if (this.mode === "same_input") {
      await this.#delegate.commitTransition(result, expectedRevision);
    } else {
      const current = await this.#delegate.loadState(result.state.run_id);
      if (!current) throw new Error("missing current state");
      const competing = transition(current, {
        kind: "cancel",
        input_id: "competing-input",
        run_id: current.run_id,
        expected_revision: current.revision,
        reason: "other writer",
      });
      await this.#delegate.commitTransition(competing, expectedRevision);
    }
    return { kind: "conflict", current_revision: expectedRevision + 1 };
  }

  readRecords(runId: string, afterSequenceExclusive?: number | null): AsyncIterable<CommittedTransitionRecord> {
    return this.#delegate.readRecords(runId, afterSequenceExclusive);
  }
}
