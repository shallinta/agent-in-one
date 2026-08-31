import {
  canonicalJsonStringify,
  createPairSessionIds,
  parsePairId,
  type PairEvent,
  type PairEventDraft,
  type PairEventType,
  type JsonObject,
  type Visibility,
} from '@pair-agent/contracts';
import { describe, expect, test } from 'vitest';

import {
  ProjectionInvariantError,
  foldPairEvent,
  replayPairProjection,
} from '../src/projection.js';

const pairId = parsePairId('pair-01');

function event(
  seq: number,
  type: PairEventType,
  payload: JsonObject,
  options: {
    refs?: PairEventDraft['refs'];
    visibility?: Visibility;
  } = {},
): PairEvent {
  return {
    pairId,
    seq,
    type,
    actor: { kind: 'agent', role: 'navigator' },
    source: 'pair',
    channel: 'shared-control',
    visibility: options.visibility ?? 'shared',
    authority: 'navigator',
    refs: options.refs ?? {},
    payload,
    occurredAt: `2026-08-26T00:00:0${seq}.000Z`,
  };
}

function created(seq = 1): PairEvent {
  return event(seq, 'pair.created', {
    ...createPairSessionIds(pairId),
    schemaVersion: 1,
  });
}

describe('pair projection lifecycle', () => {
  test('requires pair.created at seq 1 and initializes both session IDs', () => {
    const projection = foldPairEvent(undefined, created());

    expect(projection.header).toMatchObject({
      pairId,
      navigatorSessionId: 'pair:pair-01:navigator',
      pilotSessionId: 'pair:pair-01:pilot',
      schemaVersion: 1,
      ledgerHead: 1,
      sharedHead: 1,
    });
    expect(projection.attention).toEqual({ requested: false });
    expect(projection.pause).toEqual({ paused: false, changedAtSeq: 1 });
  });

  test('rejects pair.created at another sequence or more than once', () => {
    expect(() => foldPairEvent(undefined, created(2))).toThrow(
      ProjectionInvariantError,
    );
    expect(() => replayPairProjection([created(), created(2)])).toThrow(
      ProjectionInvariantError,
    );
  });

  test('rejects pair.created session IDs that do not match the PairId mapping', () => {
    const invalid = event(1, 'pair.created', {
      navigatorSessionId: 'opaque-but-wrong',
      pilotSessionId: 'pair:pair-01:pilot',
      schemaVersion: 1,
    });

    expect(() => foldPairEvent(undefined, invalid)).toThrow(
      ProjectionInvariantError,
    );
  });

  test('validates every dshBuild field before adding it to the header', () => {
    const validBuild = {
      upstreamRepository: 'openai/dsh',
      upstreamCommit: 'a'.repeat(40),
      sourceRepository: 'example/pair-agent',
      sourceCommit: 'B'.repeat(40),
      requestLayoutSeamVersion: 1,
    };
    const valid = event(1, 'pair.created', {
      ...createPairSessionIds(pairId),
      schemaVersion: 1,
      dshBuild: validBuild,
    });
    expect(foldPairEvent(undefined, valid).header.dshBuild).toEqual(validBuild);

    const invalidBuilds = [
      { ...validBuild, upstreamRepository: '' },
      { ...validBuild, sourceRepository: '' },
      { ...validBuild, upstreamCommit: 'not-a-commit' },
      { ...validBuild, sourceCommit: 'f'.repeat(39) },
      { ...validBuild, requestLayoutSeamVersion: 2 },
    ];
    for (const dshBuild of invalidBuilds) {
      const invalid = event(1, 'pair.created', {
        ...createPairSessionIds(pairId),
        schemaVersion: 1,
        dshBuild,
      });
      expect(() => foldPairEvent(undefined, invalid)).toThrow(
        ProjectionInvariantError,
      );
    }
  });
});

describe('versioned business state', () => {
  test('folds goal commit and the next revision', () => {
    const projection = replayPairProjection([
      created(),
      event(
        2,
        'goal.committed',
        { goal: { id: 'goal-1', version: 1, summary: 'Ship Phase 0' } },
        { refs: { goal: { id: 'goal-1', version: 1 } } },
      ),
      event(
        3,
        'goal.revised',
        { goal: { id: 'goal-1', version: 2, summary: 'Ship verified Phase 0' } },
        { refs: { goal: { id: 'goal-1', version: 2 } } },
      ),
    ]);

    expect(projection.goal).toEqual({
      id: 'goal-1',
      version: 2,
      summary: 'Ship verified Phase 0',
    });
  });

  test.each([1, 3])('rejects stale or skipped goal version %s', (version) => {
    expect(() =>
      replayPairProjection([
        created(),
        event(2, 'goal.committed', {
          goal: { id: 'goal-1', version: 1, summary: 'Initial' },
        }),
        event(3, 'goal.revised', {
          goal: { id: 'goal-1', version, summary: 'Invalid' },
        }),
      ]),
    ).toThrow(ProjectionInvariantError);
  });

  test('folds task assignment and exact next revision', () => {
    const projection = replayPairProjection([
      created(),
      event(2, 'task.assigned', {
        task: {
          id: 'task-1',
          revision: 1,
          summary: 'Implement contracts',
          state: 'queued',
        },
      }),
      event(3, 'task.revised', {
        task: {
          id: 'task-1',
          revision: 2,
          summary: 'Implement contracts and ledger',
          state: 'active',
        },
      }),
    ]);

    expect(projection.task).toMatchObject({
      id: 'task-1',
      revision: 2,
      state: 'active',
    });
  });

  test.each([1, 3])('rejects stale or skipped task revision %s', (revision) => {
    expect(() =>
      replayPairProjection([
        created(),
        event(2, 'task.assigned', {
          task: { id: 'task-1', revision: 1, summary: 'Initial', state: 'queued' },
        }),
        event(3, 'task.revised', {
          task: { id: 'task-1', revision, summary: 'Invalid', state: 'queued' },
        }),
      ]),
    ).toThrow(ProjectionInvariantError);
  });

  test('folds task.state_changed only from the current valid state', () => {
    const assigned = [
      created(),
      event(2, 'task.assigned', {
        task: {
          id: 'task-1',
          revision: 1,
          summary: 'Implement ledger',
          state: 'queued',
        },
      }),
    ];

    const projection = replayPairProjection([
      ...assigned,
      event(3, 'task.state_changed', { from: 'queued', to: 'active' }),
    ]);
    expect(projection.task).toMatchObject({ state: 'active', revision: 1 });

    expect(() =>
      replayPairProjection([
        ...assigned,
        event(3, 'task.state_changed', { from: 'paused', to: 'active' }),
      ]),
    ).toThrow(ProjectionInvariantError);
    expect(() =>
      replayPairProjection([
        ...assigned,
        event(3, 'task.state_changed', { from: 'queued', to: 'unknown' }),
      ]),
    ).toThrow(ProjectionInvariantError);
  });

  test('requires execution plan revisions to start at 1 and increment by 1', () => {
    const valid = replayPairProjection([
      created(),
      event(2, 'execution_plan.updated', {
        executionPlan: { id: 'plan-1', revision: 1, steps: ['write tests'] },
      }),
      event(3, 'execution_plan.updated', {
        executionPlan: {
          id: 'plan-1',
          revision: 2,
          steps: ['write tests', 'implement'],
        },
      }),
    ]);

    expect(valid.executionPlan).toMatchObject({ id: 'plan-1', revision: 2 });
    expect(() =>
      replayPairProjection([
        created(),
        event(2, 'execution_plan.updated', {
          executionPlan: { id: 'plan-1', revision: 2, steps: [] },
        }),
      ]),
    ).toThrow(ProjectionInvariantError);
  });

  test('rejects a missing execution plan id and an id change', () => {
    expect(() =>
      replayPairProjection([
        created(),
        event(2, 'execution_plan.updated', {
          executionPlan: { revision: 1, steps: [] },
        }),
      ]),
    ).toThrow(ProjectionInvariantError);

    expect(() =>
      replayPairProjection([
        created(),
        event(2, 'execution_plan.updated', {
          executionPlan: { id: 'plan-1', revision: 1, steps: [] },
        }),
        event(3, 'execution_plan.updated', {
          executionPlan: { id: 'plan-2', revision: 2, steps: [] },
        }),
      ]),
    ).toThrow(ProjectionInvariantError);
  });

  test('rejects an execution plan ref that disagrees with its payload', () => {
    expect(() =>
      replayPairProjection([
        created(),
        event(
          2,
          'execution_plan.updated',
          { executionPlan: { id: 'plan-1', revision: 1, steps: [] } },
          {
            refs: {
              executionPlan: { id: 'other-plan', revision: 1 },
            } as unknown as PairEventDraft['refs'],
          },
        ),
      ]),
    ).toThrow(ProjectionInvariantError);
  });
});

describe('control state and replay stability', () => {
  test('folds attention and pause state transitions', () => {
    const projection = replayPairProjection([
      created(),
      event(2, 'attention.requested', {
        reason: 'Goal is ambiguous',
        requestedBy: 'pilot',
      }),
      event(3, 'pair.paused', { reason: 'Waiting for Navigator' }),
      event(4, 'attention.cleared', {}),
      event(5, 'pair.resumed', {}),
    ]);

    expect(projection.attention).toEqual({ requested: false });
    expect(projection.pause).toEqual({ paused: false, changedAtSeq: 5 });
  });

  test('infrastructure events only advance ledgerHead', () => {
    const before = replayPairProjection([
      created(),
      event(2, 'goal.committed', {
        goal: { id: 'goal-1', version: 1, summary: 'Stable business state' },
      }),
    ]);
    const after = foldPairEvent(
      before,
      event(
        3,
        'pair.request_built',
        { goal: { id: 'forged', version: 99, summary: 'ignored' } },
        { visibility: 'infrastructure' },
      ),
    );

    expect(after.goal).toEqual(before.goal);
    expect(after.header).toMatchObject({ ledgerHead: 3, sharedHead: 2 });
  });

  test('replay produces byte-stable headers and projections', () => {
    const events = [
      created(),
      event(2, 'task.assigned', {
        task: { summary: 'Test replay', revision: 1, id: 'task-1', state: 'queued' },
      }),
    ];

    const first = replayPairProjection(events);
    const second = replayPairProjection(
      JSON.parse(canonicalJsonStringify(events)) as PairEvent[],
    );

    expect(canonicalJsonStringify(first.header)).toBe(
      canonicalJsonStringify(second.header),
    );
    expect(canonicalJsonStringify(first)).toBe(canonicalJsonStringify(second));
  });
});
