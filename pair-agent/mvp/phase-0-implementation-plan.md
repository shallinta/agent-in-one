# Pair Agent DSH Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally runnable Pair Agent Phase 0 that maps one Pair Session to independent Navigator and Pilot DSH Sessions, constructs cache-first local requests, and presents both native DSH Web sessions in a Pair Web Shell.

**Architecture:** Pair-owned TypeScript packages maintain the Pair Ledger, projections, shared context and Pair Session mapping. A narrow DSH patch series adds a provider-request layout waterfall and URL-addressed embedded Web session without adding Pair types to DSH. The Pair Web Shell renders Pair state and embeds two isolated native DSH Web instances; it never merges the two Agent transcripts.

**Tech Stack:** TypeScript, Node.js `>=22.19`, pnpm `11.7.0`, Vitest, React 18, Vite 6, DeepSeek Harness `dsh-v0.1.1-rc.2` / `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`, OpenAI Chat Completions-compatible route.

---

## 1. File structure

```text
pair-agent/mvp/
├── .gitignore
├── .nvmrc
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.workspace.ts
├── dsh.lock.json
├── README.md
├── phase-0-implementation-plan.md
├── apps/
│   ├── pair-host/
│   │   ├── package.json
│   │   ├── src/server.ts
│   │   └── tests/server.test.ts
│   └── pair-web/
│       ├── index.html
│       ├── package.json
│       ├── src/{main,app,pair-client,pair-header,pair-pane}.tsx
│       └── tests/{app,pair-pane}.test.tsx
├── packages/
│   ├── contracts/src/index.ts
│   ├── ledger/src/{store,projection}.ts
│   ├── context/src/{serialize,local-history,request-layout}.ts
│   ├── runtime/src/{pair-registry,coordinator}.ts
│   └── testkit/src/index.ts
├── patches/deepseek-harness/
│   ├── 0001-agent-request-layout.patch
│   └── 0002-web-addressed-session.patch
├── scripts/
│   ├── prepare-dsh.mjs
│   └── verify-dsh.mjs
└── tests/e2e/phase-0.test.ts
```

`packages/*` cannot import DSH private `src/*` files. DSH-specific imports are restricted to `packages/runtime`; the patch series contains only generic DSH changes and no Pair domain types.

## 2. Task 1: Workspace and reproducible DSH source lock

**Files:**

- Create: `pair-agent/mvp/package.json`
- Create: `pair-agent/mvp/pnpm-workspace.yaml`
- Create: `pair-agent/mvp/tsconfig.base.json`
- Create: `pair-agent/mvp/vitest.workspace.ts`
- Create: `pair-agent/mvp/.nvmrc`
- Create: `pair-agent/mvp/.gitignore`
- Create: `pair-agent/mvp/dsh.lock.json`
- Create: `pair-agent/mvp/scripts/prepare-dsh.mjs`
- Create: `pair-agent/mvp/scripts/verify-dsh.mjs`

- [x] Write a failing script test which rejects a floating DSH ref, a non-full commit SHA, the wrong package-manager version, or a dirty prepared checkout.
- [x] Run `corepack pnpm@11.7.0 --filter @pair-agent/source-lock test` and confirm it fails because the source-lock implementation is absent.
- [x] Add the minimal workspace configuration and a lock containing the upstream repository, tag, full commit SHA, supported Node range, pnpm version, ordered patch series and expected derived commit.
- [x] Implement `prepare-dsh.mjs` to clone into ignored `.runtime/deepseek-harness`, checkout the locked SHA, apply the ordered patch series with `git am`, and reject any unexpected HEAD.
- [x] Implement `verify-dsh.mjs` to report upstream HEAD, derived HEAD, dirty state and patch order as JSON.
- [x] Run the source-lock tests, `corepack pnpm@11.7.0 install --frozen-lockfile`, `corepack pnpm@11.7.0 typecheck`, and `corepack pnpm@11.7.0 test`.

Expected result: a fresh checkout can deterministically reconstruct the local DSH fork; no DSH source tree is committed into this repository.

## 3. Task 2: Pair contracts, stable Session mapping and JSONL Ledger

**Files:**

- Create: `pair-agent/mvp/packages/contracts/package.json`
- Create: `pair-agent/mvp/packages/contracts/src/index.ts`
- Create: `pair-agent/mvp/packages/contracts/tests/contracts.test.ts`
- Create: `pair-agent/mvp/packages/ledger/package.json`
- Create: `pair-agent/mvp/packages/ledger/src/store.ts`
- Create: `pair-agent/mvp/packages/ledger/src/projection.ts`
- Create: `pair-agent/mvp/packages/ledger/tests/{store,projection}.test.ts`

- [x] Write failing contract tests proving one `pairId` deterministically maps to two distinct IDs, `pair:<id>:navigator` and `pair:<id>:pilot`, and invalid IDs are rejected before path construction.
- [x] Run the contract test and confirm the missing exports are the failure cause.
- [x] Implement branded IDs, `PairCreated`, `PairHeader`, `PairEvent`, `PairProjection`, `PairPaneDescriptor` and HTTP DTOs with exhaustive role/channel/source unions.
- [x] Write failing Ledger tests for append-only JSONL, sequence CAS, shared/ledger heads, flush-before-return, truncated-last-line recovery and deterministic replay.
- [x] Run Ledger tests and confirm they fail because no store exists.
- [x] Implement `JsonlPairLedgerStore` using an explicit data root, per-Pair serialized append queue and atomic in-memory CAS; never derive filesystem paths from unvalidated input.
- [x] Write failing projection tests for `pair.created`, Goal/Task revision, pause, attention and infrastructure-only events.
- [x] Implement a pure `foldPairEvent` and replay projection; infrastructure events advance `ledgerHead` but not `sharedHead`.
- [x] Run all contract and Ledger tests plus typecheck.

Expected result: `pair.created` is sufficient to recover the two DSH Session IDs, and replay produces a byte-stable Pair Header and Projection.

## 4. Task 3: Shared context, Local History projection and request snapshot

**Files:**

- Create: `pair-agent/mvp/packages/context/package.json`
- Create: `pair-agent/mvp/packages/context/src/serialize.ts`
- Create: `pair-agent/mvp/packages/context/src/local-history.ts`
- Create: `pair-agent/mvp/packages/context/src/request-layout.ts`
- Create: `pair-agent/mvp/packages/context/tests/{serialize,local-history,request-layout}.test.ts`

- [x] Write failing serialization tests proving Navigator and Pilot receive byte-identical Common System, Shared Events and Shared Projection for the same `sharedHead`.
- [x] Implement canonical JSON-lines serialization with stable field ordering and explicit prompt/version references.
- [x] Write failing Local History tests for full-link deduplication, conservative retention of unlinked/summary/artifact messages, and atomic tool-call/result span retention.
- [x] Implement the conservative projector and a `LayoutManifest` which records the source of every retained or excluded boundary span.
- [x] Write failing request-layout tests proving the first role difference is the user-role `<system-reminder><active-role>…`, current trigger is last, and prompt-injected fake reminder text cannot change the harness-selected role.
- [x] Implement cache-first request composition and SHA-256 `PairRequestSnapshot` digests over messages, tools, config and manifest.
- [x] Run package tests and typecheck.

Expected result: the same inputs rebuild the same request digest without Provider state, while malformed or unlinked history is retained rather than silently dropped.

## 5. Task 4: Pair Host API and Pair Session registry

**Files:**

- Create: `pair-agent/mvp/packages/runtime/package.json`
- Create: `pair-agent/mvp/packages/runtime/src/pair-registry.ts`
- Create: `pair-agent/mvp/packages/runtime/src/coordinator.ts`
- Create: `pair-agent/mvp/packages/runtime/tests/{pair-registry,coordinator}.test.ts`
- Create: `pair-agent/mvp/apps/pair-host/package.json`
- Create: `pair-agent/mvp/apps/pair-host/src/server.ts`
- Create: `pair-agent/mvp/apps/pair-host/tests/server.test.ts`

- [x] Write failing registry tests for create, recover, missing Pair, duplicate Pair, and the invariant that a ready Pair always contains two distinct Session IDs.
- [x] Implement `PairRegistry` over the Ledger and expose an adapter interface for create/resume/prompt/followup without importing DSH in the domain layer.
- [x] Write failing Coordinator tests proving Pair events are appended and flushed before an Agent wake, and Task assignment targets only Pilot.
- [x] Implement the minimum Coordinator for `createPair`, `sendNavigator`, `sendPilot` and `assignTask`; P1 Goal-impact classification and revision fencing remain out of scope.
- [x] Write failing HTTP tests for `POST /api/pairs`, `GET /api/pairs/:pairId`, Navigator/Pilot message endpoints, and an SSE Pair projection stream.
- [x] Implement the Node HTTP server with structured errors and abort-safe SSE cleanup.
- [x] Run Host/package tests and typecheck.

Expected result: a headless Pair can be created, inspected and driven through two explicit channels using a fake Agent adapter before real DSH integration.

## 6. Task 5: Pair Web Shell

**Files:**

- Create: `pair-agent/mvp/apps/pair-web/package.json`
- Create: `pair-agent/mvp/apps/pair-web/index.html`
- Create: `pair-agent/mvp/apps/pair-web/src/main.tsx`
- Create: `pair-agent/mvp/apps/pair-web/src/app.tsx`
- Create: `pair-agent/mvp/apps/pair-web/src/pair-client.ts`
- Create: `pair-agent/mvp/apps/pair-web/src/pair-header.tsx`
- Create: `pair-agent/mvp/apps/pair-web/src/pair-pane.tsx`
- Create: `pair-agent/mvp/apps/pair-web/tests/{app,pair-pane}.test.tsx`

- [x] Write a failing Pane test proving iframe URLs come from a validated Pair Header, not directly from arbitrary query-string Session values.
- [x] Implement `PairPane` with fixed role label, source boundary notice, loading/error state, origin validation and `embedded=1&session=<id>&pane=<role>` URL construction.
- [x] Write a failing App test proving `pairId` loads the Header, renders two different panes, applies SSE projection updates and never renders a merged transcript.
- [x] Implement the responsive desktop-first shell, Pair Header, attention/pause state and two isolated iframe panes.
- [x] Add a fake development mode that uses fixture iframe pages only for Web component tests; production mode must require a configured DSH Web origin.
- [x] Run component tests, production build and typecheck.

Expected result: `/pair.html?pairId=<id>` renders the correct two pane URLs and Pair state without copying any DSH conversation/tool JSX.

## 7. Task 6: Generic DSH request-layout seam

**Files:**

- Create: `pair-agent/mvp/patches/deepseek-harness/0001-agent-request-layout.patch`
- Modify in prepared DSH checkout: `packages/core/agent/src/runtime-types.ts`
- Modify in prepared DSH checkout: `packages/core/agent-loop/src/agent.ts`
- Modify in prepared DSH checkout: `packages/core/agent-loop/src/invariant.ts`
- Add DSH tests for identity, transformation, retry attempt, freeze and provenance.

- [x] Add failing DSH tests proving no listener preserves the exact baseline request, a listener can transform final boundary messages, retries expose a stable attempt index, and transformed requests remain compatible with reconstruction invariants.
- [x] Run the focused DSH Agent/Agent Loop suite and observe expected failures.
- [x] Add a generic typed `agent/request-layout` waterfall immediately before final request freeze; inputs include Agent/Session identity, turn, step, attempt, config, system, tools, full boundary messages and signal.
- [x] Add package-private source-boundary provenance so DSH invariant checks validate the Session-derived source boundary even when the final Provider layout is transformed.
- [x] Preserve identity behavior when no listener is installed and keep all Pair types outside DSH.
- [x] Run DSH focused tests, scoped-event generation/verification, typecheck and build.
- [x] Export the changes as deterministic format patch `0001-agent-request-layout.patch` and update `dsh.lock.json` derived commit.

Expected result: registering the Pair plugin changes only the immutable Provider request projection; DSH Session history, tools, cancel and resume behavior remain unchanged.

## 8. Task 7: Generic DSH addressed embedded Session seam

**Files:**

- Create: `pair-agent/mvp/patches/deepseek-harness/0002-web-addressed-session.patch`
- Modify in prepared DSH checkout: Web boot/runtime extension files selected at the locked commit.
- Add DSH browser/runtime tests for explicit Session startup.

- [x] Write failing tests proving a valid addressed Session is selected before `SessionRuntime` restores or projects a current Session, embedded panes do not share the global persisted current key, and absence of boot options preserves baseline behavior.
- [x] Fail closed before mounting Composer when the addressed Session is absent or differs from the expected Pane Session; Pane labels never grant tools or authority.
- [x] Add a generic `embedded=1` presentation option which hides global chrome, limits navigation to the root Session and its legal Sub-agent lineage, and does not alter transcript or input semantics.
- [x] Prove two isolated browser contexts can stay fixed to different root Session IDs while Pilot navigates into and back from a legal Sub-agent; illegal cross-root navigation is rejected.
- [x] Run DSH Web tests and production build.
- [x] Export deterministic patch `0002-web-addressed-session.patch`, update the derived commit and rerun `prepare-dsh` from an empty runtime directory.

Expected result: both native DSH Web panes survive refresh and navigation without converging on one persisted current Session.

## 9. Task 8: Real DSH adapter and minimum dual-Agent vertical slice

**Files:**

- Modify: `pair-agent/mvp/packages/context/src/request-layout.ts`
- Modify: `pair-agent/mvp/packages/runtime/src/pair-registry.ts`
- Create: `pair-agent/mvp/packages/runtime/src/dsh-adapter.ts`
- Create: `pair-agent/mvp/packages/runtime/src/pair-request-plugin.ts`
- Create: `pair-agent/mvp/packages/runtime/tests/dsh-adapter.contract.test.ts`
- Reuse unchanged: `pair-agent/mvp/packages/runtime/src/coordinator.ts`
- Reuse unchanged: `pair-agent/mvp/apps/pair-host/src/server.ts`

- [x] Write a failing conformance test using a capture Provider: create two top-level DSH Agents with distinct JSONL Sessions, deliver one Navigator message, assign one Task, wake Pilot and capture both final Provider requests.
- [x] Install the common complete System Prompt, suppress DSH runtime context for Pair scopes, and register the Pair request-layout plugin.
- [x] Configure DSH JSONL persistence with `compression: none`, `packChunks: false`, and an explicit data root.
- [x] Configure the `openai-completions` route without Provider continuation identifiers; allow a deterministic capture Provider for automated tests.
- [x] Persist `PairRequestSnapshot` before Provider execution and prove offline digest reconstruction.
- [x] Resume both Sessions from disk and prove the Pair Header and historical request digest remain identical.
- [x] Run conformance tests plus the entire Pair workspace suite.

Expected result: the headless runtime performs one real Navigator-to-Pilot assignment on DSH while retaining two independent standard Agent Sessions.

## 10. Task 9: Phase 0 end-to-end verification and runbook

**Files:**

- Create: `pair-agent/mvp/tests/e2e/phase-0.test.ts`
- Create: `pair-agent/mvp/README.md`
- Modify: `pair-agent/mvp/package.json`

- [x] Write the failing end-to-end scenario: create Pair, send Navigator input, assign Task, run one harmless Pilot tool, keep Navigator responsive, open both Web panes, stop, restart, and compare reconstructed headers/request digests.
- [x] Add one command `corepack pnpm@11.7.0 dev` which starts Pair Host, prepared DSH Host/Web and Pair Web Shell with explicit ports and data roots.
- [x] Add one command `corepack pnpm@11.7.0 verify` which runs Pair tests/typecheck/build, DSH seam regressions and the end-to-end capture-provider scenario.
- [x] Document URLs, configuration, OpenAI-compatible environment variables, three persistence locations, visible reasoning limitations and how to enter Pilot Sub-agent/Trajectory views.
- [x] Run `verify` from a clean data directory and inspect the Pair JSONL, both DSH JSONL logs and request snapshots.

Expected result: Phase 0 has a reproducible local run command, an automated vertical proof and inspectable persistence artifacts; P1 permissions and P2 crash-window recovery are not claimed complete.

## 11. Execution order and completion boundary

Critical path:

```text
Task 1 → Task 6 → Task 8 → Task 9
       ↘ Tasks 2–5 ↗
       ↘ Task 7 ───↗
```

Tasks 2–5 can run independently against the adapter contract while Task 6 validates the DSH Go/No-Go seam. Task 8 cannot begin until Tasks 2, 3 and 6 pass. Task 9 cannot claim Phase 0 until the real DSH Web addressed-session test and the real dual-Agent capture-provider test both pass.

Phase 0 explicitly does not complete P1 Goal/Task permission matrices, full Plan/workflow/sub-agent semantics, or P2 delivery crash-window reconciliation. It must nevertheless preserve the architectural boundaries those phases depend on.
