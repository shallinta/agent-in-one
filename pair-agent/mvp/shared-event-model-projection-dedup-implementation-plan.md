# Shared Event Model Projection Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove duplicate pure-text content from model-facing Shared Event projections without changing the canonical Pair Ledger, while keeping request reconstruction format-aware.

**Architecture:** Add a pure, version-selected Shared Event projector in the context package. Thread its immutable format identity through request materials, layout manifests, durable snapshots, and historical reconstruction; retain the legacy full serializer and make strict text deduplication the active format.

**Tech Stack:** TypeScript, Vitest, pnpm, JSONL Pair Ledger, DSH request-layout seam.

---

## 1. File map

- `packages/context/src/serialize.ts`: format constants, strict clone-and-deduplicate projector, version-selected serialization.
- `packages/context/src/request-layout.ts`: carry format identity into request construction, manifest, snapshot, and digest.
- `packages/context/tests/serialize.test.ts`: projector RED/GREEN tests.
- `packages/context/tests/request-layout.test.ts`: manifest/snapshot and identical-prefix tests.
- `packages/runtime/src/request-material-registry.ts`: make format part of immutable material identity.
- `packages/runtime/src/dsh-adapter.ts`: select the active format and reconstruct historical requests with their recorded format.
- `packages/runtime/src/pair-request-plugin.ts`: pass material-selected format into the layout.
- `packages/runtime/tests/request-material-registry.test.ts`: material-key tests.
- `packages/runtime/tests/pair-request-plugin.test.ts`: Provider-boundary projection tests.
- `packages/runtime/tests/dsh-adapter.contract.test.ts`: historical full/deduplicated request reconstruction test.
- `README.md` and the approved design: document the active model projection and unchanged Ledger.

## 2. Task 1: Add strict version-selected model projection

- [x] Add failing tests proving the deduplicated format removes only `content: [{type: "text", text}]`, retains non-equivalent content, does not mutate the input, and the full format preserves legacy bytes.
- [x] Run `pnpm --filter @pair-agent/context exec vitest run tests/serialize.test.ts` and confirm the failures are caused by missing format/projector behavior.
- [x] Add these exported identities and make the serializer require one of them:

```ts
export const SHARED_EVENT_CONTEXT_FULL_V1 = 'pair-event-context/full-v1';
export const SHARED_EVENT_CONTEXT_TEXT_DEDUP_V1 =
  'pair-event-context/text-dedup-v1';
export type SharedEventContextFormat =
  | typeof SHARED_EVENT_CONTEXT_FULL_V1
  | typeof SHARED_EVENT_CONTEXT_TEXT_DEDUP_V1;
```

- [x] Implement a pure projector that canonical-clones the event and deletes `payload.content` only when canonical equality with `[{ type: 'text', text: payload.text }]` proves redundancy and the block has no additional keys.
- [x] Preserve the exact existing wrapper and bytes for `full-v1`; use `schema="pair-event-context/text-dedup-v1"` for the deduplicated format and compute its watermark over projected bytes.
- [x] Re-run the focused context tests and confirm GREEN.

## 3. Task 2: Bind the format to request identity

- [x] Add failing request-layout tests requiring `sharedEventContextFormat` in `PairRequestLayoutInput`, `LayoutManifest`, and `PairRequestSnapshot`, and proving Navigator/Pilot still receive an identical Shared prefix.
- [x] Add failing material-registry tests proving two otherwise identical entries with different format identities do not alias and an unregistered format cannot resolve.
- [x] Run the focused tests and confirm failures identify the missing format fields.
- [x] Add `sharedEventContextFormat` to request layout validation, serialization selection, manifest, snapshot, `PairRequestMaterialEntry`, `PairRequestMaterialVersions`, and the registry key.
- [x] Re-run context and registry tests and confirm GREEN.

## 4. Task 3: Select the active format and preserve historical reconstruction

- [x] Add failing PairRequestPlugin tests proving the Provider boundary uses material-selected deduplicated events and the persisted snapshot records that format.
- [x] Add a DSH contract test that builds one historical request with `full-v1`, starts a runtime whose active material uses `text-dedup-v1`, and reconstructs the historical digest with `full-v1` exactly.
- [x] Run the focused runtime tests and confirm RED for missing format plumbing.
- [x] Default new DSH Pair runtime materials to `text-dedup-v1`, allow tests/recovery setup to select `full-v1`, pass the value through PairRequestPlugin, and resolve historical materials with the snapshot value.
- [x] Re-run focused runtime tests and confirm GREEN.

## 5. Task 4: Documentation and verification

- [x] Update `pair-agent/mvp/README.md` and the approved design to state that Ledger/API/UI keep both fields while the model projection removes strictly equivalent content.
- [x] Run `pnpm test`, `pnpm run typecheck`, and `git diff --check` from `pair-agent/mvp`.
- [x] Inspect `git diff` and confirm only intended files changed; preserve the pre-existing user modification in `pair-agent/pair-agent-dsh-mvp.md`.
- [x] Do not restart the real-model service or delete test Pair data in this task; report that activation requires a later restart and a compatible fresh/clean Pair because existing snapshots predate the new format coordinate.
- [x] Do not commit or push until the user explicitly requests it.
