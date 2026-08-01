# ReAct Loop TypeScript Reference

This directory contains an executable, learning-oriented TypeScript companion to
[`react-loop-protocol-design.md`](./react-loop-protocol-design.md). It focuses on
the protocol's P0 invariants and main in-memory path, rather than pretending to be
a production workflow engine.

## What is included

- JSON-shaped, discriminated protocol unions and small runtime boundary validators.
- A pure `transition(state, input)` state machine with deterministic effect, batch,
  call, pause, and event identities.
- Stable internal `call_key` values, batch-local provider `call_id` validation,
  receipt-window deduplication, revision CAS, and effect-result correlation.
- Ordered tool-progress merging, including `unknown` outcomes, retry-safe retries,
  and manual result supply.
- An authoritative in-memory Store that atomically records each State transition.
- An in-memory Runner with injected AgentCore, Policy, and Tool Executor adapters.
- Scripted fakes and conformance-style tests.

## Run it

```bash
bun install
bun test
bun run typecheck
```

Minimal example:

```ts
import {
  InMemoryLoopStore,
  InMemoryReactLoopRunner,
  inMemoryRunnerCapabilities,
  ScriptedAgentCore,
  ScriptedPolicy,
  ScriptedToolExecutor,
} from "./src";

const continuation = { kind: "inline", value: {} } as const;
const runner = new InMemoryReactLoopRunner({
  store: new InMemoryLoopStore(),
  agent_core: new ScriptedAgentCore([
    {
      kind: "tool_calls",
      continuation,
      calls: [{ call_id: "provider-call-1", name: "echo", arguments: "hello" }],
    },
    { kind: "finished", continuation, output: "done" },
  ]),
  policy: new ScriptedPolicy([
    { kind: "execute", mode: "sequential", max_concurrency: 1 },
  ]),
  tool_executor: new ScriptedToolExecutor(async (call) => ({
    call_key: call.call_key,
    call_id: call.call_id,
    status: "success",
    output: call.arguments,
  })),
});

const state = await runner.start({
  kind: "start",
  input_id: "example:start",
  run_id: "example",
  expected_revision: null,
  continuation,
  limits: { max_turns: 4, input_receipt_window: 32 },
  agent_core_capabilities: {},
  tool_executor_capabilities: {},
  runner_capabilities: inMemoryRunnerCapabilities,
});

console.log(state.status); // completed
```

`start.input_id` and the final `inputId` argument of `runner.resume(...)` and
`runner.cancel(...)` are caller-owned command IDs. Reuse an ID only when retrying
the same logical command; distinct concurrent commands must use distinct IDs.

## Deliberate research gaps

This package does **not** provide durable crash recovery, checkpoint import,
execution claims or fencing, durable/replayable event streaming, cancellation
propagation into already-running effects, generated JSON Schemas, cross-language
fixtures, or production storage adapters. The exported runner capabilities report
these durability features as `false`.

The protocol retains a `recover` Input for research completeness, but this reference
state machine rejects it explicitly and the in-memory Runner does not expose a
recovery API.

The in-memory Store makes the transition boundary observable and testable, but a
process crash loses all state. The article keeps the harder distributed-runtime
questions visible for further study instead of hiding them behind misleading APIs.
