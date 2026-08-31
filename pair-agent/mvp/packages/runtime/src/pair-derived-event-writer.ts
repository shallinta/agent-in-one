import {
  assertP05PairEventPayload,
  canonicalJsonStringify,
  type JsonObject,
  type PairEvent,
  type PairEventDraft,
  type PairId,
} from '@pair-agent/contracts';

import { PairRegistry } from './pair-registry.js';

export interface DerivedEventSpec {
  readonly sourceId: string;
  readonly representedSourceId?: string;
  readonly representedPairEventId?: string;
  readonly draft: PairEventDraft;
}

export class DerivedEventConflictError extends Error {
  readonly sourceId: string;

  constructor(sourceId: string, detail: string) {
    super(`Derived Pair event conflict for ${sourceId}: ${detail}`);
    this.name = 'DerivedEventConflictError';
    this.sourceId = sourceId;
  }
}

function pairEventId(event: Pick<PairEvent, 'pairId' | 'seq'>): string {
  return `${event.pairId}:${event.seq}`;
}

function indexCanonicalSources(events: readonly PairEvent[]): Map<string, PairEvent> {
  const bySource = new Map<string, PairEvent>();
  for (const event of events) {
    for (const sourceId of event.refs.sourceEventIds ?? []) {
      if (bySource.has(sourceId)) {
        throw new DerivedEventConflictError(
          sourceId,
          'the durable Ledger contains more than one event for this source',
        );
      }
      bySource.set(sourceId, event);
    }
  }
  return bySource;
}

function indexPairEventIds(events: readonly PairEvent[]): Map<string, PairEvent> {
  return new Map(events.map((event) => [pairEventId(event), event]));
}

function withSourceId(
  draft: PairEventDraft,
  sourceId: string,
): PairEventDraft {
  if (sourceId.trim() === '') {
    throw new DerivedEventConflictError(sourceId, 'sourceId must be non-empty');
  }
  const claimedSourceIds = draft.refs.sourceEventIds;
  if (
    claimedSourceIds !== undefined &&
    (claimedSourceIds.length !== 1 || claimedSourceIds[0] !== sourceId)
  ) {
    throw new DerivedEventConflictError(
      sourceId,
      'draft may claim only its own canonical sourceId',
    );
  }
  return {
    ...draft,
    refs: { ...draft.refs, sourceEventIds: [sourceId] },
  };
}

function canonicalDraft(event: PairEvent): PairEventDraft {
  return {
    type: event.type,
    actor: event.actor,
    source: event.source,
    channel: event.channel,
    visibility: event.visibility,
    authority: event.authority,
    refs: event.refs,
    payload: event.payload,
  };
}

function assertCanonicalDerivation(
  existing: PairEvent,
  sourceId: string,
  expected: PairEventDraft,
): void {
  if (
    canonicalJsonStringify(canonicalDraft(existing)) !==
    canonicalJsonStringify(expected)
  ) {
    throw new DerivedEventConflictError(
      sourceId,
      'existing event differs from the canonical derivation',
    );
  }
}

function materializeDraft(
  spec: DerivedEventSpec,
  bySource: ReadonlyMap<string, PairEvent>,
  byPairEventId: ReadonlyMap<string, PairEvent>,
): PairEventDraft {
  if (spec.draft.type !== 'session_event.linked') {
    if (
      spec.representedSourceId !== undefined ||
      spec.representedPairEventId !== undefined
    ) {
      throw new DerivedEventConflictError(
        spec.sourceId,
        'represented message selectors are valid only for session_event.linked',
      );
    }
    return withSourceId(spec.draft, spec.sourceId);
  }

  if (
    (spec.representedSourceId === undefined) ===
    (spec.representedPairEventId === undefined)
  ) {
    throw new DerivedEventConflictError(
      spec.sourceId,
      'session_event.linked requires exactly one represented message selector',
    );
  }
  const represented =
    spec.representedSourceId === undefined
      ? byPairEventId.get(spec.representedPairEventId!)
      : bySource.get(spec.representedSourceId);
  if (
    represented === undefined ||
    (represented.type !== 'user.message' && represented.type !== 'agent.message')
  ) {
    throw new DerivedEventConflictError(
      spec.sourceId,
      `represented message ${spec.representedSourceId ?? spec.representedPairEventId} is missing`,
    );
  }
  return withSourceId(
    {
      ...spec.draft,
      payload: {
        ...(spec.draft.payload as JsonObject),
        pairEventId: pairEventId(represented),
      },
    },
    spec.sourceId,
  );
}

export class PairDerivedEventWriter {
  constructor(private readonly registry: PairRegistry) {}

  async appendGroup(
    pairId: PairId,
    specs: readonly DerivedEventSpec[],
  ): Promise<PairEvent[]> {
    return this.registry.runDerivedMutation(
      pairId,
      async ({ events, appendDerived }) => {
        const bySource = indexCanonicalSources(events);
        const byPairEventId = indexPairEventIds(events);

        for (const spec of specs) {
          if (
            spec.draft.type === 'session_event.linked' &&
            bySource.has(spec.sourceId) &&
            ((spec.representedSourceId !== undefined &&
              !bySource.has(spec.representedSourceId)) ||
              (spec.representedPairEventId !== undefined &&
                !byPairEventId.has(spec.representedPairEventId)) ||
              (spec.representedSourceId === undefined &&
                spec.representedPairEventId === undefined))
          ) {
            throw new DerivedEventConflictError(
              spec.sourceId,
              'orphan link exists without its represented message',
            );
          }
        }

        const output: PairEvent[] = [];
        for (const spec of specs) {
          const draft = materializeDraft(spec, bySource, byPairEventId);
          if (
            draft.type !== 'user.message' &&
            draft.type !== 'agent.message' &&
            draft.type !== 'session_event.linked'
          ) {
            throw new DerivedEventConflictError(
              spec.sourceId,
              `unsupported derived event type ${draft.type}`,
            );
          }
          assertP05PairEventPayload(draft.type, draft.payload);
          const existing = bySource.get(spec.sourceId);
          if (existing !== undefined) {
            assertCanonicalDerivation(existing, spec.sourceId, draft);
            output.push(existing);
            continue;
          }
          const event = await appendDerived(draft);
          bySource.set(spec.sourceId, event);
          byPairEventId.set(pairEventId(event), event);
          output.push(event);
        }
        return output;
      },
    );
  }
}
