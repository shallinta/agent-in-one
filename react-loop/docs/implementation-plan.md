# ReAct Loop TypeScript Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` while implementing each task. This plan is executed in the current checkout because the user explicitly asked that all code related to the local design document remain under `react-loop/`.

**Goal:** Build a small, executable TypeScript reference implementation of the protocol article: closed protocol unions, a pure state machine, an authoritative in-memory store, an effect-driving Runner, fakes, and focused conformance tests.

**Architecture:** `protocol.ts` owns JSON-shaped types and boundary validation; `machine.ts` is the deterministic `transition(state, input)` core; `store.ts` atomically commits the latest state with one canonical transition record; `runner.ts` interprets one pending effect at a time through injected adapters. The package deliberately does not claim durable crash recovery, distributed ownership, atomic fencing, or complete generated JSON Schema support.

**Tech Stack:** TypeScript 5, Bun test runner, zero runtime dependencies.

---

## File map

- `react-loop/package.json` — one-command test/typecheck scripts and package metadata.
- `react-loop/tsconfig.json` — strict, no-emit TypeScript configuration.
- `react-loop/src/protocol.ts` — JSON values, closed unions, protocol errors, and runtime validators.
- `react-loop/src/machine.ts` — pure transition function and deterministic ID/event helpers.
- `react-loop/src/store.ts` — authoritative in-memory State + Transition Record commit boundary.
- `react-loop/src/runner.ts` — asynchronous effect interpreter and public in-memory Runner API.
- `react-loop/src/testing.ts` — scripted fake AgentCore, Tool Executor, and Policy.
- `react-loop/src/index.ts` — public exports.
- `react-loop/test/protocol.test.ts` — boundary validation and P0 identity tests.
- `react-loop/test/machine.test.ts` — state-machine path, pause/resume, idempotency, and max-turn tests.
- `react-loop/test/store.test.ts` — atomic snapshot/record and CAS tests.
- `react-loop/test/runner.test.ts` — end-to-end Runner, ordering, and canonical record tests.
- `react-loop/README.md` — learning scope, run commands, example, and intentionally unresolved production concerns.

No commit is part of this plan: the existing `react-loop/` tree is untracked and the user did not request Git history changes.

### Task 1: Package shell and protocol boundary

**Files:**
- Create: `react-loop/package.json`
- Create: `react-loop/tsconfig.json`
- Create: `react-loop/src/protocol.ts`
- Create: `react-loop/test/protocol.test.ts`

- [ ] Write a failing Bun test that imports `validateTurnOutcome` and proves a `tool_calls` outcome with duplicate `call_id` values throws `ProtocolError` with code `invalid_turn_outcome`.
- [ ] Run `cd react-loop && bun test test/protocol.test.ts`; confirm RED because the module/API does not exist.
- [ ] Define JSON-safe primitives plus closed discriminated unions for `Continuation`, `ToolCall`, `NormalizedToolCall`, `ToolResult`, `ToolBatchProgressEntry`, `TurnOutcome`, `ToolBatchDecision`, `ResumeAction`, `Input`, `Effect`, `Pause`, `Completion`, `LoopState`, and `LoopEvent`.
- [ ] Implement boundary validators that reject unknown discriminants, malformed required fields, non-JSON values, empty/duplicate batch `call_id`, and invalid `retry_safe_call_keys`; validators throw `new ProtocolError(code, message)`.
- [ ] Re-run the focused test and confirm GREEN; add tests for empty calls, unknown variants, and non-JSON values, then keep the file green.

The intended validator API is:

```ts
export class ProtocolError extends Error {
  constructor(readonly code: ProtocolErrorCode, message: string) { super(message); }
}

export function validateTurnOutcome(value: unknown): asserts value is TurnOutcome;
export function validateInput(value: unknown): asserts value is Input;
export function validateJsonValue(value: unknown): asserts value is JsonValue;
```

### Task 2: Pure transition state machine

**Files:**
- Create: `react-loop/src/machine.ts`
- Create: `react-loop/test/machine.test.ts`
- Modify: `react-loop/src/protocol.ts`

- [ ] Write a failing test for `start(null, input)` producing revision `0`, status `awaiting_turn`, effect ID `run_id:0:run_turn:0`, and ordered `run.started` / `turn.requested` events.
- [ ] Run `cd react-loop && bun test test/machine.test.ts`; confirm RED because `transition` does not exist.
- [ ] Implement `transition(state: LoopState | null, input: Input): TransitionResult` with deterministic `effect_id`, `batch_id`, `call_key`, event IDs, revision increments, and receipt-window maintenance.
- [ ] Add RED/GREEN cases for `finished`, tool calls → policy decision, `execute`, `supply`, policy pause/stop, AgentCore pause/continue, cancel, and normalized failure inputs.
- [ ] Add RED/GREEN cases proving two different batches may reuse the same provider `call_id` while their internal `call_key` values differ.
- [ ] Add RED/GREEN cases for partial tool failure merging by `call_key`, `uncertain_tools`, retrying only retry-safe unknown calls, preserving known results in source order, and requiring `provide_tool_results` to cover every unknown entry.
- [ ] Add RED/GREEN cases for duplicate input receipts returning an idempotent no-op, stale revisions throwing `revision_conflict`, mismatched effect IDs throwing `effect_mismatch`, and terminal states rejecting further progress.
- [ ] Add RED/GREEN cases for max-turn priority: `finished` still succeeds on the last allowed turn; final-turn tool calls still reach policy/tools; after results no new model turn is emitted and completion is `max_turns_reached`.

The state-machine surface is:

```ts
export interface TransitionResult {
  readonly state: LoopState;
  readonly effects: readonly Effect[];
  readonly events: readonly LoopEvent[];
}

export function transition(state: LoopState | null, input: Input): TransitionResult;
```

### Task 3: Canonical in-memory Store

**Files:**
- Create: `react-loop/src/store.ts`
- Create: `react-loop/test/store.test.ts`

- [ ] Write a failing test that creates a run and observes one atomic committed record containing `previous_revision`, `next_revision`, the authoritative state, effects, and events.
- [ ] Run `cd react-loop && bun test test/store.test.ts`; confirm RED because `InMemoryLoopStore` does not exist.
- [ ] Implement `InMemoryLoopStore.createRun`, `commitTransition`, `loadState`, and `readRecords` with defensive cloning, create-if-absent/CAS conflicts, and run-local gapless `record_sequence`.
- [ ] Add tests proving rejected/conflicting commits do not change state or append records, and that record types are only `transition` in this learning implementation.

The Store surface is:

```ts
export type StoreCommitResult =
  | { kind: "applied"; record: CommittedTransitionRecord }
  | { kind: "conflict"; current_revision: number | null };

export interface LoopStore {
  loadState(runId: string): Promise<LoopState | null>;
  createRun(result: TransitionResult): Promise<StoreCommitResult>;
  commitTransition(result: TransitionResult, expectedRevision: number): Promise<StoreCommitResult>;
  readRecords(runId: string, afterSequenceExclusive?: number | null): AsyncIterable<CommittedTransitionRecord>;
}
```

### Task 4: Effect-driving in-memory Runner and fakes

**Files:**
- Create: `react-loop/src/runner.ts`
- Create: `react-loop/src/testing.ts`
- Create: `react-loop/test/runner.test.ts`

- [ ] Write a failing end-to-end test whose scripted AgentCore first requests two tools and then finishes; assert the Runner returns a completed state and the second turn receives results in original call order even when tool promises finish out of order.
- [ ] Run `cd react-loop && bun test test/runner.test.ts`; confirm RED because the Runner/fakes do not exist.
- [ ] Implement injected interfaces `AgentCoreAdapter`, `ToolExecutor`, and `LoopPolicy`, plus scripted fakes that record requests and consume predefined outcomes.
- [ ] Implement `InMemoryReactLoopRunner.start`, `resume`, `cancel`, and `getState`; after each pure transition, commit State + Record before interpreting the pending Effect.
- [ ] Interpret `run_turn`, `decide_tool_batch`, and `execute_tool_batch`; convert adapter/policy failures into failure Inputs, use `Promise.allSettled` for parallel tools, preserve source order, and turn executor uncertainty into `unknown` outcomes.
- [ ] Add tests for normal completion, policy stop, AgentCore pause/resume, unknown tool pause, safe retry, cancel, and transition-record replay.
- [ ] Expose runner capabilities with `durable_state: false`, `crash_recovery: false`, `replayable_events: false`, and `effect_ownership: false`; do not implement `recover` or checkpoint import as if they were production-safe.

### Task 5: Public API, learning guide, and full verification

**Files:**
- Create: `react-loop/src/index.ts`
- Create: `react-loop/README.md`

- [ ] Export the protocol, state machine, Store, Runner, and fakes from `src/index.ts`.
- [ ] Document `bun install`, `bun test`, and `bun run typecheck`, then show a minimal scripted tool-call example.
- [ ] Explicitly list research-only gaps: generated JSON Schemas, durable Store/checkpoint import, crash recovery, execution claims/fencing, cancellation propagation, extension-event streaming, and cross-language fixtures.
- [ ] Run `cd react-loop && bun test` and require zero failures.
- [ ] Run `cd react-loop && bun run typecheck` and require exit code `0`.
- [ ] Run `git diff --check` and inspect `git status --short` to confirm all created code stays under `react-loop/` and the design document is preserved.
