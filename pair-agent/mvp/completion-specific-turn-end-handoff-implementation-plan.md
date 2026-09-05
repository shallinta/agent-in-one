# Completion-specific Turn-end Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Pilot-only completion registration tool whose final report becomes one durable Shared Event before Navigator receives a reference-only wake trigger.

**Architecture:** DSH Session events remain the durable local registration source. The Session-to-Pair Bridge recognizes a successful `pair_report_completion` call at completed `turn/end`, projects the final Pilot answer as one directed `completion-handoff`, then invokes an injected delivery port only after Pair persistence. Adapter recovery rebuilds accepted delivery IDs from durable Navigator Session messages.

**Tech Stack:** TypeScript 5.9, Vitest 2, pnpm workspace, DSH JSONL Session events, Pair JSONL Ledger, OpenAI-compatible Chat Completions capture provider.

---

## Task 1: Extend the Pair message contract and pure Turn derivation

**Files:**

- Modify: `packages/contracts/src/pair-events.ts`
- Modify: `packages/contracts/tests/contracts.test.ts`
- Modify: `packages/runtime/src/session-event-derive.ts`
- Modify: `packages/runtime/tests/session-event-derive.test.ts`

- [x] **Step 1: Write failing contract tests**

Add tests accepting Pilot `agent.message` payloads with `kind: "completion-handoff"`, `completion: "complete"`, `causalRootId`, `hop`, and `origin`; reject the kind for `user.message`, reject partial completion, and reject missing causality.

- [x] **Step 2: Run contract RED**

```bash
corepack pnpm@11.7.0 --dir pair-agent/mvp/packages/contracts exec vitest run tests/contracts.test.ts
```

Expected: FAIL because `completion-handoff` is not an allowed agent message kind.

- [x] **Step 3: Add the minimal contract**

Extend `PairMessagePayload.kind` and `assertMessagePayload` with `completion-handoff`. Require `completion === "complete"`, a non-empty causal root and hop `1..MAX_PEER_HOPS`. Add `isCompletionHandoffAgentMessage(event)` without changing `isPeerAgentMessage` semantics, plus a strict directed-message predicate that recognizes exactly these two canonical kinds.

- [x] **Step 4: Run contract GREEN**

Run the same command and expect zero failures.

- [x] **Step 5: Write failing derivation tests**

Construct durable Turn fixtures containing a `tool/call` for `pair_report_completion`, its matching append-origin successful `tool/result`, a later final public `assistant/message`, and completed `turn/end`. Assert Pilot output is `completion-handoff` directed to Navigator, while ordinary output remains `turn-output`. Cover Navigator role, failed result, final text before result, duplicate successful registrations, max-tokens, interrupted Turn, missing final text, an ignorable unrelated event and a `surfaceOp.replace` copy that must not count as another registration.

- [x] **Step 6: Run derivation RED**

```bash
corepack pnpm@11.7.0 --dir pair-agent/mvp/packages/runtime exec vitest run tests/session-event-derive.test.ts
```

Expected: FAIL because the derivation does not recognize completion registration.

- [x] **Step 7: Implement minimal pure derivation**

Parse `tool/call` and append-origin `tool/result` by Turn and call ID. Select completion mode only for one successful Pilot registration followed by the final public assistant message and completed Turn. Extract one shared causality function for both Peer and Completion: one user/task root starts hop 1; directed inputs must all share a root and produce max hop plus one; mixed input, multiple roots and overflow fail closed.

- [x] **Step 8: Run derivation GREEN**

Run the focused runtime test and contracts test; expect zero failures.

## Task 2: Add the Pilot-only completion registration tool

**Files:**

- Create: `packages/runtime/src/completion-handoff.ts`
- Modify: `packages/runtime/src/index.ts`
- Create: `packages/runtime/tests/completion-handoff.test.ts`

- [x] **Step 1: Write failing tool tests**

Specify `CompletionHandoffRouter` and `CompletionHandoffService` with exact empty arguments, active Session/Turn validation, Pilot-only role enforcement, durable provenance barrier, one successful registration per Turn, two concurrent calls with exactly one success, post-await open-Turn revalidation, and no coordinator append/followup during execution.

- [x] **Step 2: Run tool RED**

```bash
corepack pnpm@11.7.0 --dir pair-agent/mvp/packages/runtime exec vitest run tests/completion-handoff.test.ts
```

Expected: FAIL because the module and exported types do not exist.

- [x] **Step 3: Implement the minimal router and service**

Expose this schema and return only the deterministic registration acknowledgement:

```ts
{
  name: 'pair_report_completion',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {},
  },
}
```

Reuse the active execution context and Turn provenance port. Validate `senderRole === "pilot"`; retain only an in-process per-Turn success guard. Perform no Pair mutation or wake.

- [x] **Step 4: Run tool GREEN**

Run the focused test and expect zero failures.

## Task 3: Deliver only after durable Bridge projection

**Files:**

- Modify: `packages/runtime/src/session-to-pair-bridge.ts`
- Modify: `packages/runtime/src/pair-derived-event-writer.ts`
- Modify: `packages/runtime/src/peer-message.ts`
- Modify: `packages/runtime/tests/session-to-pair-bridge.test.ts`
- Modify: `packages/runtime/tests/peer-message.test.ts`

- [x] **Step 1: Write failing ordering and idempotency tests**

Inject a completion delivery spy into `SessionToPairBridge`. Assert no delivery at tool/call or tool/result; append returns the durable completion event before delivery; delivery receives only `pairEventId`, Pilot Turn and sender role; repeated drain reuses one event; ordinary output remains passive; and a delivery failure leaves the event durable for retry without duplication. Add Peer tests for completion input preserving root/incrementing hop, mixed inputs failing closed and hop overflow.

- [x] **Step 2: Run Bridge RED**

```bash
corepack pnpm@11.7.0 --dir pair-agent/mvp/packages/runtime exec vitest run tests/session-to-pair-bridge.test.ts
```

Expected: FAIL because Bridge has no completion delivery port.

- [x] **Step 3: Implement the delivery boundary**

Add derived-group metadata identifying completion without placing host delivery state in Pair payload. After `appendGroup` returns, verify the expected durable completion event and invoke the delivery port with only:

```ts
{
  pairId,
  pairEventId,
  senderRole: 'pilot',
  senderTurn,
}
```

Update Peer Message causality classification so canonical `peer-message` and `completion-handoff` inputs form the same bounded directed chain; ordinary `agent.message` remains rejected. Locate the returned completion event by canonical source identity rather than relying on record array position, and assert the message is durable before its link and before delivery.

- [x] **Step 4: Run Bridge GREEN**

Run the focused test and expect zero failures.

## Task 4: Make delivery restart-safe in the DSH adapter

**Files:**

- Modify: `packages/runtime/src/dsh-adapter.ts`
- Modify: `packages/runtime/src/pair-request-plugin.ts`
- Modify: `packages/runtime/tests/dsh-adapter.contract.test.ts`
- Modify: `packages/runtime/tests/pair-request-plugin.test.ts`
- Modify: `packages/runtime/tests/peer-message.test.ts`

- [x] **Step 1: Write failing adapter tests**

On resume, expect accepted delivery IDs to be reconstructed from durable `user/message` events with source `pair-agent:delivery`. Repeating one completion delivery ID must not inject another message or start another Turn; a different ID remains admissible.

- [x] **Step 2: Run adapter RED**

```bash
corepack pnpm@11.7.0 --dir pair-agent/mvp/packages/runtime exec vitest run tests/dsh-adapter.contract.test.ts
```

Expected: FAIL because accepted deliveries currently start from an empty Set.

- [x] **Step 3: Implement durable delivery-index reconstruction**

Add a pure scanner over live/resumed Session events. Accept only canonical plugin delivery sources with equal non-empty `pairEventId` and `deliveryId`; fail closed on malformed Pair delivery records. Initialize `#deliveries` before recovery Bridge catch-up.

- [x] **Step 4: Wire reference-only completion delivery**

When attaching Pair Registry, construct Bridge with a callback that invokes Navigator `followup` using `deliveryId === pairEventId` and this trigger only:

```ts
{
  kind: 'completion-handoff',
  pairEventId,
  senderRole: 'pilot',
  senderTurn,
}
```

Teach Pair Request delivery-proof validation to derive exactly that reference-only trigger from the durable completion event. Validate target role, sender role/Turn and event identity without copying `payload.text` into the delivery message.

- [x] **Step 5: Run adapter GREEN and Peer regression**

Run the adapter and peer-message focused tests. Existing immediate Peer Message behavior must remain unchanged.

## Task 5: Compose the tool and update immutable prompts

**Files:**

- Modify: `scripts/dev-entry.ts`
- Modify: `scripts/pair-prompt.ts`
- Modify: `scripts/tests/pair-prompt.test.ts`
- Modify: `README.md`

- [x] **Step 1: Write failing prompt and composition tests**

Assert prompt text says Navigator delegation requires `pair_report_completion`; Pilot calls it before the complete final report; registration is not delivery; and `pair_message_peer` is not used for completion. The runtime/E2E tool-catalog test in Task 6 proves both exact schemas participate in immutable tool-set identity.

- [x] **Step 2: Run prompt RED**

```bash
corepack pnpm@11.7.0 --dir pair-agent/mvp test:source
```

Expected: FAIL because prompt and composition still describe Peer Message completion.

- [x] **Step 3: Wire and document the protocol**

Create and bind the completion router alongside Peer Message. Update Common System, role guidance, README capability description, known limitations and verification claims. Record that old local test Pair material is incompatible and must be recreated.

- [x] **Step 4: Run prompt GREEN**

Run source tests and expect zero failures.

## Task 6: Prove the end-to-end race is closed

**Files:**

- Modify: `tests/e2e/p0.5-shared-conversation.test.ts`
- Create or modify a focused crash helper beside the existing E2E helpers only if fault injection needs a child process

- [x] **Step 1: Write failing capture-provider E2E**

Drive Navigator delegation, Pilot registration, Pilot final report and Navigator integration. Assert Navigator has no new Turn at tool success; exactly one completion semantic Shared Event exists after Pilot `turn/end`; no duplicate `turn-output` carries the report; Trigger references the event and omits report text; Navigator Shared Context contains that semantic event exactly once with a covering ledger head; and a Navigator Peer response preserves the same root while incrementing hop.

- [x] **Step 2: Run E2E RED**

Run the single E2E test by name and observe the expected failure before final integration.

- [x] **Step 3: Add recovery coverage**

Inject a crash window after completion Pair append and before Navigator followup. Recover twice; assert one completion event, one durable Navigator delivery and no extra Navigator Turn on the second recovery. Separately record the admitted-delivery → interrupted Navigator processing window as a P2 limitation rather than claiming processing exactly-once.

- [x] **Step 4: Run focused E2E GREEN**

Run the focused E2E and expect zero failures.

- [x] **Step 5: Run full verification**

```bash
corepack pnpm@11.7.0 --dir pair-agent/mvp verify
```

Expected: source lock verification, all Pair tests, typecheck, build, DSH regressions and browser checks exit 0 with no failed tests.

- [x] **Step 6: Review the final diff**

```bash
git status --short
git diff --check
git diff --stat
git diff -- pair-agent/mvp
```

Confirm only the approved Completion-specific Turn-end Handoff scope changed. Do not commit or push without a separate explicit user request.
