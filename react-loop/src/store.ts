import type { TransitionResult } from "./machine";
import type { Effect, LoopEvent, LoopState } from "./protocol";

export interface CommittedTransitionRecord {
  readonly record_type: "transition";
  readonly run_id: string;
  readonly record_sequence: number;
  readonly previous_revision: number | null;
  readonly next_revision: number;
  readonly input_id: string;
  readonly state: LoopState;
  readonly effects: readonly Effect[];
  readonly events: readonly LoopEvent[];
}

export type StoreCommitResult =
  | { readonly kind: "applied"; readonly record: CommittedTransitionRecord }
  | { readonly kind: "conflict"; readonly current_revision: number | null };

export interface LoopStore {
  loadState(runId: string): Promise<LoopState | null>;
  createRun(result: TransitionResult): Promise<StoreCommitResult>;
  commitTransition(result: TransitionResult, expectedRevision: number): Promise<StoreCommitResult>;
  readRecords(runId: string, afterSequenceExclusive?: number | null): AsyncIterable<CommittedTransitionRecord>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryLoopStore implements LoopStore {
  readonly #states = new Map<string, LoopState>();
  readonly #records = new Map<string, CommittedTransitionRecord[]>();

  async loadState(runId: string): Promise<LoopState | null> {
    const state = this.#states.get(runId);
    return state ? clone(state) : null;
  }

  async createRun(result: TransitionResult): Promise<StoreCommitResult> {
    const runId = result.state.run_id;
    const current = this.#states.get(runId);
    if (current) return { kind: "conflict", current_revision: current.revision };
    if (result.state.revision !== 0) return { kind: "conflict", current_revision: null };
    return this.#apply(result, null);
  }

  async commitTransition(result: TransitionResult, expectedRevision: number): Promise<StoreCommitResult> {
    const current = this.#states.get(result.state.run_id);
    if (!current || current.revision !== expectedRevision || result.state.revision !== expectedRevision + 1) {
      return { kind: "conflict", current_revision: current?.revision ?? null };
    }
    return this.#apply(result, expectedRevision);
  }

  async *readRecords(runId: string, afterSequenceExclusive: number | null = null): AsyncIterable<CommittedTransitionRecord> {
    const threshold = afterSequenceExclusive ?? -1;
    for (const record of this.#records.get(runId) ?? []) {
      if (record.record_sequence > threshold) yield clone(record);
    }
  }

  #apply(result: TransitionResult, previousRevision: number | null): StoreCommitResult {
    const runId = result.state.run_id;
    const records = this.#records.get(runId) ?? [];
    const record: CommittedTransitionRecord = {
      record_type: "transition",
      run_id: runId,
      record_sequence: records.length,
      previous_revision: previousRevision,
      next_revision: result.state.revision,
      input_id: result.state.last_input_id,
      state: clone(result.state),
      effects: clone(result.effects),
      events: clone(result.events),
    };
    this.#states.set(runId, clone(result.state));
    this.#records.set(runId, [...records, record]);
    return { kind: "applied", record: clone(record) };
  }
}
