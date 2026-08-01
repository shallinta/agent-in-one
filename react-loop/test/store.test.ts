import { describe, expect, test } from "bun:test";

import { transition } from "../src/machine";
import type { Input } from "../src/protocol";
import { InMemoryLoopStore } from "../src/store";

const start: Input = {
  kind: "start",
  input_id: "start",
  run_id: "stored-run",
  expected_revision: null,
  continuation: { kind: "inline", value: {} },
  limits: { max_turns: 2, input_receipt_window: 8 },
  agent_core_capabilities: {},
  tool_executor_capabilities: {},
  runner_capabilities: {},
};

describe("InMemoryLoopStore", () => {
  test("atomically creates authoritative state and one canonical record", async () => {
    const store = new InMemoryLoopStore();
    const initial = transition(null, start);
    const committed = await store.createRun(initial);

    expect(committed).toMatchObject({ kind: "applied", record: { record_type: "transition", record_sequence: 0, previous_revision: null, next_revision: 0 } });
    expect(await store.loadState("stored-run")).toEqual(initial.state);
    const records = [];
    for await (const record of store.readRecords("stored-run")) records.push(record);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ state: initial.state, effects: initial.effects, events: initial.events });
  });

  test("CAS conflicts append nothing and successful sequences have no gaps", async () => {
    const store = new InMemoryLoopStore();
    const initial = transition(null, start);
    await store.createRun(initial);
    if (initial.state.pending?.kind !== "run_turn") throw new Error("expected turn");
    const next = transition(initial.state, {
      kind: "turn_completed",
      input_id: "finished",
      run_id: "stored-run",
      expected_revision: 0,
      effect_id: initial.state.pending.effect_id,
      outcome: { kind: "finished", continuation: { kind: "inline", value: {} }, output: "done" },
    });

    expect(await store.commitTransition(next, 99)).toEqual({ kind: "conflict", current_revision: 0 });
    expect(await store.commitTransition(next, 0)).toMatchObject({ kind: "applied", record: { record_sequence: 1 } });
    const records = [];
    for await (const record of store.readRecords("stored-run")) records.push(record.record_sequence);
    expect(records).toEqual([0, 1]);
  });

  test("returns defensive clones", async () => {
    const store = new InMemoryLoopStore();
    const initial = transition(null, start);
    await store.createRun(initial);
    const loaded = await store.loadState("stored-run");
    if (!loaded) throw new Error("missing state");
    (loaded as { revision: number }).revision = 123;
    expect((await store.loadState("stored-run"))?.revision).toBe(0);
  });
});
