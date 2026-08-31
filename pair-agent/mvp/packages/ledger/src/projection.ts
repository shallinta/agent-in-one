import {
  createPairSessionIds,
  isPairTaskState,
  parsePairId,
  type DshBuildRef,
  type DshRuntimeArtifactRef,
  type PairEvent,
  type PairExecutionPlan,
  type PairGoal,
  type PairProjection,
  type PairRole,
  type PairTask,
} from '@pair-agent/contracts';

export class ProjectionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionInvariantError';
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new ProjectionInvariantError(message);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  const prototype =
    typeof value === 'object' && value !== null
      ? Object.getPrototypeOf(value)
      : undefined;
  invariant(
    typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      (prototype === Object.prototype || prototype === null),
    `${label} must be a plain object`,
  );
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  invariant(typeof value === 'string' && value.length > 0, `${label} is required`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  invariant(
    Number.isSafeInteger(value) && (value as number) > 0,
    `${label} must be a positive integer`,
  );
  return value as number;
}

function optionalStringArray(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  invariant(
    Array.isArray(value) && value.every((item) => typeof item === 'string'),
    `${label} must be an array of strings`,
  );
  return [...value] as string[];
}

function readDshBuild(value: unknown): DshBuildRef {
  const build = record(value, 'pair.created dshBuild');
  const upstreamRepository = nonEmptyString(
    build.upstreamRepository,
    'dshBuild.upstreamRepository',
  );
  const sourceRepository = nonEmptyString(
    build.sourceRepository,
    'dshBuild.sourceRepository',
  );
  const commitPattern = /^[0-9a-fA-F]{40}$/;
  invariant(
    typeof build.upstreamCommit === 'string' &&
      commitPattern.test(build.upstreamCommit),
    'dshBuild.upstreamCommit must be a 40-character hexadecimal commit',
  );
  invariant(
    typeof build.sourceCommit === 'string' && commitPattern.test(build.sourceCommit),
    'dshBuild.sourceCommit must be a 40-character hexadecimal commit',
  );
  invariant(
    build.requestLayoutSeamVersion === 1,
    'dshBuild.requestLayoutSeamVersion must be 1',
  );
  return {
    upstreamRepository,
    upstreamCommit: build.upstreamCommit,
    sourceRepository,
    sourceCommit: build.sourceCommit,
    requestLayoutSeamVersion: 1,
  };
}

function readDshRuntimeArtifacts(value: unknown): DshRuntimeArtifactRef {
  const artifacts = record(value, 'pair.created dshRuntimeArtifacts');
  const roots = ['apps', 'native', 'packages', 'vendor'] as const;
  invariant(artifacts.schemaVersion === 1, 'dshRuntimeArtifacts.schemaVersion must be 1');
  invariant(artifacts.buildProfile === 'official', 'dshRuntimeArtifacts.buildProfile must be official');
  invariant(
    Array.isArray(artifacts.roots) &&
      artifacts.roots.length === roots.length &&
      artifacts.roots.every((entry, index) => entry === roots[index]),
    'dshRuntimeArtifacts.roots must match the official build roots',
  );
  invariant(
    typeof artifacts.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(artifacts.digest),
    'dshRuntimeArtifacts.digest must be a sha256 digest',
  );
  return {
    schemaVersion: 1,
    buildProfile: 'official',
    roots,
    fileCount: positiveInteger(artifacts.fileCount, 'dshRuntimeArtifacts.fileCount'),
    digest: artifacts.digest,
  };
}

function readGoal(event: PairEvent): PairGoal {
  const payload = record(event.payload, 'goal payload');
  const goal = record(payload.goal, 'goal');
  const parsed: PairGoal = {
    id: nonEmptyString(goal.id, 'goal.id'),
    version: positiveInteger(goal.version, 'goal.version'),
    summary: nonEmptyString(goal.summary, 'goal.summary'),
  };
  const successCriteria = optionalStringArray(
    goal.successCriteria,
    'goal.successCriteria',
  );
  const constraints = optionalStringArray(goal.constraints, 'goal.constraints');
  if (successCriteria !== undefined) parsed.successCriteria = successCriteria;
  if (constraints !== undefined) parsed.constraints = constraints;

  if (event.refs.goal !== undefined) {
    invariant(
      event.refs.goal.id === parsed.id &&
        event.refs.goal.version === parsed.version,
      'goal ref must match goal payload',
    );
  }
  return parsed;
}

function readTask(event: PairEvent): PairTask {
  const payload = record(event.payload, 'task payload');
  const task = record(payload.task, 'task');
  const parsed: PairTask = {
    id: nonEmptyString(task.id, 'task.id'),
    revision: positiveInteger(task.revision, 'task.revision'),
    summary: nonEmptyString(task.summary, 'task.summary'),
    state: task.state as PairTask['state'],
  };
  invariant(isPairTaskState(task.state), 'task.state is invalid');

  if (event.refs.task !== undefined) {
    invariant(
      event.refs.task.id === parsed.id &&
        event.refs.task.revision === parsed.revision,
      'task ref must match task payload',
    );
  }
  return parsed;
}

function assertNever(value: never): never {
  throw new ProjectionInvariantError(`unhandled Pair event type ${String(value)}`);
}

function readExecutionPlan(event: PairEvent): PairExecutionPlan {
  const payload = record(event.payload, 'execution plan payload');
  const plan = record(payload.executionPlan, 'executionPlan');
  invariant(
    Array.isArray(plan.steps) &&
      plan.steps.every((step) => typeof step === 'string'),
    'executionPlan.steps must be an array of strings',
  );
  const parsed: PairExecutionPlan = {
    id: nonEmptyString(plan.id, 'executionPlan.id'),
    revision: positiveInteger(plan.revision, 'executionPlan.revision'),
    steps: [...plan.steps] as string[],
  };
  if (plan.summary !== undefined) {
    parsed.summary = nonEmptyString(plan.summary, 'executionPlan.summary');
  }
  if (event.refs.executionPlan !== undefined) {
    invariant(
      event.refs.executionPlan.id === parsed.id &&
        event.refs.executionPlan.revision === parsed.revision,
      'execution plan ref must match payload',
    );
  }
  return parsed;
}

function initialize(event: PairEvent): PairProjection {
  invariant(event.seq === 1, 'pair.created must be seq 1');
  invariant(event.type === 'pair.created', 'first event must be pair.created');
  invariant(event.visibility === 'shared', 'pair.created must be shared');
  const pairId = parsePairId(event.pairId);
  const payload = record(event.payload, 'pair.created payload');
  const expectedIds = createPairSessionIds(pairId);
  invariant(payload.schemaVersion === 1, 'pair.created schemaVersion must be 1');
  invariant(
    payload.navigatorSessionId === expectedIds.navigatorSessionId,
    'pair.created navigatorSessionId does not match PairId',
  );
  invariant(
    payload.pilotSessionId === expectedIds.pilotSessionId,
    'pair.created pilotSessionId does not match PairId',
  );
  invariant(
    expectedIds.navigatorSessionId !== expectedIds.pilotSessionId,
    'Pair session IDs must be distinct',
  );
  const dshBuild =
    payload.dshBuild === undefined ? undefined : readDshBuild(payload.dshBuild);
  const dshRuntimeArtifacts =
    payload.dshRuntimeArtifacts === undefined
      ? undefined
      : readDshRuntimeArtifacts(payload.dshRuntimeArtifacts);

  return {
    header: {
      pairId,
      schemaVersion: 1,
      navigatorSessionId: expectedIds.navigatorSessionId,
      pilotSessionId: expectedIds.pilotSessionId,
      ...(dshBuild === undefined ? {} : { dshBuild }),
      ...(dshRuntimeArtifacts === undefined ? {} : { dshRuntimeArtifacts }),
      ledgerHead: 1,
      sharedHead: 1,
    },
    attention: { requested: false },
    pause: { paused: false, changedAtSeq: 1 },
  };
}

export function foldPairEvent(
  projection: PairProjection | undefined,
  event: PairEvent,
): PairProjection {
  if (projection === undefined) {
    return initialize(event);
  }

  invariant(event.type !== 'pair.created', 'pair.created may occur only once');
  invariant(
    event.pairId === projection.header.pairId,
    'event PairId does not match projection',
  );
  invariant(
    event.seq === projection.header.ledgerHead + 1,
    `expected event seq ${projection.header.ledgerHead + 1}, found ${event.seq}`,
  );

  const next: PairProjection = {
    ...projection,
    header: {
      ...projection.header,
      ledgerHead: event.seq,
      sharedHead:
        event.visibility === 'shared'
          ? event.seq
          : projection.header.sharedHead,
    },
  };

  if (event.visibility !== 'shared') {
    return next;
  }

  switch (event.type) {
    case 'goal.committed': {
      invariant(projection.goal === undefined, 'goal is already committed');
      const goal = readGoal(event);
      invariant(goal.version === 1, 'first goal version must be 1');
      return { ...next, goal };
    }
    case 'goal.revised': {
      invariant(projection.goal !== undefined, 'cannot revise a missing goal');
      const goal = readGoal(event);
      invariant(goal.id === projection.goal.id, 'goal id cannot change on revision');
      invariant(
        goal.version === projection.goal.version + 1,
        `expected goal version ${projection.goal.version + 1}`,
      );
      return { ...next, goal };
    }
    case 'task.assigned': {
      invariant(projection.task === undefined, 'task is already assigned');
      const task = readTask(event);
      invariant(task.revision === 1, 'first task revision must be 1');
      return { ...next, task };
    }
    case 'task.revised': {
      invariant(projection.task !== undefined, 'cannot revise a missing task');
      const task = readTask(event);
      invariant(task.id === projection.task.id, 'task id cannot change on revision');
      invariant(
        task.revision === projection.task.revision + 1,
        `expected task revision ${projection.task.revision + 1}`,
      );
      return { ...next, task };
    }
    case 'task.state_changed': {
      invariant(projection.task !== undefined, 'cannot change state of a missing task');
      const payload = record(event.payload, 'task.state_changed payload');
      invariant(isPairTaskState(payload.from), 'task.state_changed.from is invalid');
      invariant(isPairTaskState(payload.to), 'task.state_changed.to is invalid');
      invariant(
        payload.from === projection.task.state,
        `expected task state ${projection.task.state}`,
      );
      invariant(payload.to !== payload.from, 'task state must change');
      return {
        ...next,
        task: { ...projection.task, state: payload.to },
      };
    }
    case 'execution_plan.updated': {
      const executionPlan = readExecutionPlan(event);
      const expectedRevision = (projection.executionPlan?.revision ?? 0) + 1;
      if (projection.executionPlan !== undefined) {
        invariant(
          executionPlan.id === projection.executionPlan.id,
          'execution plan id cannot change on revision',
        );
      }
      invariant(
        executionPlan.revision === expectedRevision,
        `expected execution plan revision ${expectedRevision}`,
      );
      return { ...next, executionPlan };
    }
    case 'attention.requested': {
      const payload = record(event.payload, 'attention payload');
      const requestedBy = payload.requestedBy;
      invariant(
        requestedBy === undefined ||
          requestedBy === 'navigator' ||
          requestedBy === 'pilot',
        'attention.requestedBy is invalid',
      );
      return {
        ...next,
        attention: {
          requested: true,
          ...(payload.reason === undefined
            ? {}
            : { reason: nonEmptyString(payload.reason, 'attention.reason') }),
          ...(requestedBy === undefined
            ? {}
            : { requestedBy: requestedBy as PairRole }),
          requestedAtSeq: event.seq,
        },
      };
    }
    case 'attention.cleared':
      return { ...next, attention: { requested: false } };
    case 'pair.paused': {
      const payload = record(event.payload, 'pause payload');
      return {
        ...next,
        pause: {
          paused: true,
          ...(payload.reason === undefined
            ? {}
            : { reason: nonEmptyString(payload.reason, 'pause.reason') }),
          changedAtSeq: event.seq,
        },
      };
    }
    case 'pair.resumed':
      return {
        ...next,
        pause: { paused: false, changedAtSeq: event.seq },
      };
    case 'pair.agent_ready':
    case 'pair.agent_failed':
    case 'user.message':
    case 'agent.message':
    case 'artifact.recorded':
    case 'session_event.linked':
    case 'pair.request_built':
    case 'delivery.queued':
    case 'delivery.durable':
    case 'delivery.claimed':
    case 'delivery.completed':
    case 'delivery.failed':
    case 'delivery.cancelled':
    case 'delivery.superseded':
      return next;
    default:
      return assertNever(event.type);
  }
}

export function replayPairProjection(
  events: readonly PairEvent[],
): PairProjection {
  invariant(events.length > 0, 'cannot project an empty Pair ledger');
  let projection: PairProjection | undefined;
  for (const event of events) {
    projection = foldPairEvent(projection, event);
  }
  return projection!;
}
