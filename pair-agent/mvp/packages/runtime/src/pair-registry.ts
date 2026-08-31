import { realpath } from 'node:fs/promises';

import {
  assertJsonObject,
  canonicalJsonStringify,
  createPairSessionIds,
  parsePairId,
  type DshBuildRef,
  type DshRuntimeArtifactRef,
  type JsonObject,
  type PairId,
  type PairEvent,
  type PairEventDraft,
  type PairPaneDescriptor,
  type PairProjection,
  type PairRole,
} from '@pair-agent/contracts';
import {
  JsonlPairLedgerStore,
  LedgerConflictError,
  foldPairEvent,
  replayPairProjection,
} from '@pair-agent/ledger';

export interface AgentHandle {
  readonly sessionId: string;
  readonly [key: string]: unknown;
}

export interface PreparePairAgentInput {
  pairId: PairId;
  role: PairRole;
  sessionId: string;
}

export interface PreparedPairAgent {
  handle: AgentHandle;
  descriptor: PairPaneDescriptor;
}

export interface FollowupInput {
  sessionId: string;
  deliveryId: string;
  trigger: JsonObject;
}

export type DshRuntimeArtifactAttestation = DshRuntimeArtifactRef;

export interface DshRuntimeAttestation {
  readonly dshBuild: DshBuildRef;
  readonly runtimeArtifacts: DshRuntimeArtifactAttestation;
}

export interface AgentAdapter {
  /** Immutable build facts verified by the adapter before it becomes usable. */
  getDshRuntimeAttestation(): DshRuntimeAttestation;
  preparePairAgent(input: PreparePairAgentInput): Promise<PreparedPairAgent>;
  resumePairAgent(input: PreparePairAgentInput): Promise<PreparedPairAgent>;
  auditPairRequests?(input: {
    pairId: PairId;
    sessions: Readonly<Record<PairRole, AgentHandle>>;
  }): Promise<void>;
  release(handle: AgentHandle): Promise<void>;
  // Phase 0 uses followup as the uniform wake primitive for both Pair roles.
  followup(input: FollowupInput): Promise<void>;
  /**
   * Optional adapter-wide teardown. Resolving is an attestation that every
   * handle owned by this adapter is quiesced and disposed, including handles
   * whose individual release rejected.
   */
  close?(): Promise<void>;
}

export interface CreatePairInput {
  pairId: string;
  dshBuild: DshBuildRef;
  expectedLedgerHead: number;
}

export interface ReadyPair {
  status: 'ready';
  projection: PairProjection;
  panes: readonly [PairPaneDescriptor, PairPaneDescriptor];
  handles: Readonly<Record<PairRole, AgentHandle>>;
}

export interface FailedPair {
  status: 'failed';
  projection: PairProjection;
  failedRole?: PairRole;
  reason: string;
}

export type PairCreationResult = ReadyPair | FailedPair;
export type PairProjectionListener = (projection: PairProjection) => void;

export interface PairRegistryOptions {
  onSubscriberError?: (
    error: unknown,
    context: { pairId: PairId; projection: PairProjection },
  ) => void;
}

export interface PairMutationContext {
  pairId: PairId;
  projection: PairProjection;
  ready: ReadyPair;
  append(draft: PairEventDraft): Promise<PairEvent>;
}

export class DuplicatePairError extends Error {
  readonly pairId: string;

  constructor(pairId: string) {
    super(`Pair ${pairId} already exists`);
    this.name = 'DuplicatePairError';
    this.pairId = pairId;
  }
}

export class PairNotFoundError extends Error {
  readonly pairId: string;

  constructor(pairId: string) {
    super(`Pair ${pairId} was not found`);
    this.name = 'PairNotFoundError';
    this.pairId = pairId;
  }
}

export class PairNotReadyError extends Error {
  readonly pairId: string;

  constructor(pairId: string, detail = 'ready agent mapping is incomplete') {
    super(`Pair ${pairId} is not ready: ${detail}`);
    this.name = 'PairNotReadyError';
    this.pairId = pairId;
  }
}

export class PairResumeError extends PairNotReadyError {
  readonly failedRole?: PairRole;

  constructor(pairId: string, failedRole: PairRole | undefined, detail: string) {
    super(pairId, detail);
    this.name = 'PairResumeError';
    this.failedRole = failedRole;
  }
}

export class RegistryClosedError extends Error {
  constructor() {
    super('Pair registry is closed');
    this.name = 'RegistryClosedError';
  }
}

export class DshBuildAttestationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DshBuildAttestationError';
  }
}

export class PairOwnershipConflictError extends Error {
  readonly pairId: PairId;

  constructor(pairId: PairId) {
    super(`Pair ${pairId} is already owned by another live PairRegistry`);
    this.name = 'PairOwnershipConflictError';
    this.pairId = pairId;
  }
}

export { RegistryClosedError as RuntimeClosedError };

const PAIR_MUTATION_QUEUES = new Map<string, Promise<void>>();
const LIVE_PAIR_OWNERS = new Map<string, object>();

function serializePairMutation<TResult>(
  key: string,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const prior = PAIR_MUTATION_QUEUES.get(key) ?? Promise.resolve();
  const result = prior.catch(() => undefined).then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  PAIR_MUTATION_QUEUES.set(key, settled);
  void settled.finally(() => {
    if (PAIR_MUTATION_QUEUES.get(key) === settled) {
      PAIR_MUTATION_QUEUES.delete(key);
    }
  });
  return result;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.slice(0, 4096);
  }
  return 'Agent preparation failed';
}

function validateDshBuildRef(
  build: DshBuildRef,
): asserts build is DshBuildRef & JsonObject {
  assertJsonObject(build);
  const commitPattern = /^[0-9a-fA-F]{40}$/;
  if (
    typeof build.upstreamRepository !== 'string' ||
    build.upstreamRepository.length === 0 ||
    build.upstreamRepository.length > 4096
  ) {
    throw new TypeError('dshBuild.upstreamRepository must be non-empty');
  }
  if (!commitPattern.test(build.upstreamCommit)) {
    throw new TypeError('dshBuild.upstreamCommit must be a full 40-character commit');
  }
  if (
    typeof build.sourceRepository !== 'string' ||
    build.sourceRepository.length === 0 ||
    build.sourceRepository.length > 4096
  ) {
    throw new TypeError('dshBuild.sourceRepository must be non-empty');
  }
  if (!commitPattern.test(build.sourceCommit)) {
    throw new TypeError('dshBuild.sourceCommit must be a full 40-character commit');
  }
  if (build.requestLayoutSeamVersion !== 1) {
    throw new TypeError('dshBuild.requestLayoutSeamVersion must be 1');
  }
}

function validateRuntimeAttestation(
  attestation: DshRuntimeAttestation,
): asserts attestation is DshRuntimeAttestation & JsonObject {
  assertJsonObject(attestation);
  validateDshBuildRef(attestation.dshBuild);
  assertJsonObject(attestation.runtimeArtifacts);
  const artifacts = attestation.runtimeArtifacts;
  if (
    artifacts.schemaVersion !== 1 ||
    artifacts.buildProfile !== 'official' ||
    !Array.isArray(artifacts.roots) ||
    canonicalJsonStringify(artifacts.roots) !==
      canonicalJsonStringify(['apps', 'native', 'packages', 'vendor']) ||
    !Number.isSafeInteger(artifacts.fileCount) ||
    artifacts.fileCount <= 0 ||
    typeof artifacts.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifacts.digest)
  ) {
    throw new TypeError('DSH runtime artifact attestation is invalid');
  }
}

function assertAdapterBuild(
  adapter: AgentAdapter,
  expected: DshBuildRef,
): DshRuntimeAttestation {
  let attestation: DshRuntimeAttestation;
  try {
    attestation = adapter.getDshRuntimeAttestation();
    validateRuntimeAttestation(attestation);
  } catch (error) {
    throw new DshBuildAttestationError(
      'Agent adapter did not provide a valid DSH runtime attestation',
      { cause: error },
    );
  }
  if (
    canonicalJsonStringify(attestation.dshBuild) !==
    canonicalJsonStringify(expected)
  ) {
    throw new DshBuildAttestationError(
      'Claimed DSH build does not match the Agent adapter attestation',
    );
  }
  return attestation;
}

function paneFor(
  role: PairRole,
  sessionId: string,
): PairPaneDescriptor {
  return {
    role,
    source: `${role}-session`,
    sessionId,
  };
}

function isExpectedDescriptor(
  descriptor: PairPaneDescriptor,
  expected: PairPaneDescriptor,
): boolean {
  return (
    descriptor.role === expected.role &&
    descriptor.source === expected.source &&
    descriptor.sessionId === expected.sessionId
  );
}

function readReadyPanes(value: unknown): readonly [PairPaneDescriptor, PairPaneDescriptor] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const panes = (value as Record<string, unknown>).panes;
  if (!Array.isArray(panes) || panes.length !== 2) return undefined;
  const [navigator, pilot] = panes;
  if (
    typeof navigator !== 'object' ||
    navigator === null ||
    Array.isArray(navigator) ||
    typeof pilot !== 'object' ||
    pilot === null ||
    Array.isArray(pilot)
  ) {
    return undefined;
  }
  const first = navigator as Record<string, unknown>;
  const second = pilot as Record<string, unknown>;
  if (
    first.role !== 'navigator' ||
    first.source !== 'navigator-session' ||
    typeof first.sessionId !== 'string' ||
    second.role !== 'pilot' ||
    second.source !== 'pilot-session' ||
    typeof second.sessionId !== 'string' ||
    first.sessionId === second.sessionId
  ) {
    return undefined;
  }
  return [
    paneFor('navigator', first.sessionId),
    paneFor('pilot', second.sessionId),
  ];
}

export class PairRegistry {
  readonly #states = new Map<PairId, PairCreationResult>();
  readonly #subscriptions = new Map<PairId, Set<PairProjectionListener>>();
  readonly #latestProjections = new Map<PairId, PairProjection>();
  readonly #resumeErrors = new Map<PairId, PairResumeError>();
  readonly #recoveries = new Map<PairId, Promise<ReadyPair>>();
  readonly #lifecycles = new Set<Promise<unknown>>();
  readonly #degradedHandles = new Map<PairId, Set<AgentHandle>>();
  readonly #releasedHandles = new WeakSet<AgentHandle>();
  readonly #options: PairRegistryOptions;
  readonly #ownershipToken = {};
  readonly #ownedLeaseKeys = new Map<PairId, string>();
  #storageIdentity?: Promise<string>;
  #closed = false;
  #closePromise?: Promise<void>;

  constructor(
    readonly store: JsonlPairLedgerStore,
    readonly adapter: AgentAdapter,
    options: PairRegistryOptions = {},
  ) {
    this.#options = options;
  }

  createPair(input: CreatePairInput): Promise<PairCreationResult> {
    try {
      this.#assertOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#trackLifecycle(this.#createPair(input));
  }

  async #createPair(input: CreatePairInput): Promise<PairCreationResult> {
    const pairId = parsePairId(input.pairId);
    validateDshBuildRef(input.dshBuild);
    const attestation = assertAdapterBuild(this.adapter, input.dshBuild);
    if (this.#states.has(pairId) || (await this.store.read(pairId)).length > 0) {
      throw new DuplicatePairError(pairId);
    }

    const sessionIds = createPairSessionIds(pairId);
    const created = await this.store.append(
      pairId,
      {
        type: 'pair.created',
        actor: { kind: 'pair' },
        source: 'pair',
        channel: 'shared-control',
        visibility: 'shared',
        authority: 'host',
        refs: {},
        payload: {
          schemaVersion: 1,
          ...sessionIds,
          dshBuild: attestation.dshBuild as unknown as JsonObject,
          dshRuntimeArtifacts: attestation.runtimeArtifacts as unknown as JsonObject,
        },
      },
      input.expectedLedgerHead,
    );
    await this.publish(pairId);
    await this.#claimOwnership(pairId);
    let retainOwnership = false;
    try {

    const inputs: readonly PreparePairAgentInput[] = [
      { pairId, role: 'navigator', sessionId: sessionIds.navigatorSessionId },
      { pairId, role: 'pilot', sessionId: sessionIds.pilotSessionId },
    ];
    const settled = await Promise.allSettled(
      inputs.map((agentInput) =>
        Promise.resolve().then(() => this.adapter.preparePairAgent(agentInput)),
      ),
    );
    const prepared = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    if (this.#closed) {
      const released = await this.#releasePairHandles(
        pairId,
        prepared.map(({ handle }) => handle),
      );
      if (!released) retainOwnership = true;
      throw new RegistryClosedError();
    }
    const rejectedIndex = settled.findIndex((result) => result.status === 'rejected');
    let failure:
      | { failedRole?: PairRole; reason: string }
      | undefined;
    if (rejectedIndex >= 0) {
      const rejected = settled[rejectedIndex]!;
      failure = {
        failedRole: inputs[rejectedIndex]?.role,
        reason:
          rejected.status === 'rejected'
            ? errorMessage(rejected.reason)
            : 'Agent preparation failed',
      };
    } else {
      for (let index = 0; index < prepared.length; index += 1) {
        const expected = paneFor(inputs[index]!.role, inputs[index]!.sessionId);
        if (!isExpectedDescriptor(prepared[index]!.descriptor, expected)) {
          failure = {
            failedRole: inputs[index]!.role,
            reason: `Adapter returned an invalid ${inputs[index]!.role} descriptor`,
          };
          break;
        }
      }
    }

    if (failure !== undefined) {
      const released = await this.#releasePairHandles(
        pairId,
        prepared.map(({ handle }) => handle),
      );
      if (!released) retainOwnership = true;
      if (this.#closed) throw new RegistryClosedError();
      await this.store.append(
        pairId,
        {
          type: 'pair.agent_failed',
          actor: { kind: 'host' },
          source: 'pair',
          channel: 'shared-control',
          visibility: 'infrastructure',
          authority: 'host',
          refs: {},
          payload: {
            ...(failure.failedRole === undefined
              ? {}
              : { failedRole: failure.failedRole }),
            reason: failure.reason,
          },
        },
        created.seq,
      );
      const projection = await this.publish(pairId);
      if (this.#closed) throw new RegistryClosedError();
      const failed: FailedPair = { status: 'failed', projection, ...failure };
      this.#states.set(pairId, failed);
      return failed;
    }

    const panes = [
      prepared[0]!.descriptor,
      prepared[1]!.descriptor,
    ] as const;
    const durablePanes = panes.map((pane) => ({
      role: pane.role,
      source: pane.source,
      sessionId: pane.sessionId,
    }));
    if (this.#closed) {
      const released = await this.#releasePairHandles(
        pairId,
        prepared.map(({ handle }) => handle),
      );
      if (!released) retainOwnership = true;
      throw new RegistryClosedError();
    }
    try {
      await this.store.append(
        pairId,
        {
          type: 'pair.agent_ready',
          actor: { kind: 'host' },
          source: 'pair',
          channel: 'shared-control',
          visibility: 'infrastructure',
          authority: 'host',
          refs: {},
          payload: { panes: durablePanes },
        },
        created.seq,
      );
    } catch (error) {
      const released = await this.#releasePairHandles(
        pairId,
        prepared.map(({ handle }) => handle),
      );
      if (!released) retainOwnership = true;
      throw error;
    }
    const projection = await this.publish(pairId);
    if (this.#closed) {
      const released = await this.#releasePairHandles(
        pairId,
        prepared.map(({ handle }) => handle),
      );
      if (!released) retainOwnership = true;
      throw new RegistryClosedError();
    }
    const ready: ReadyPair = {
      status: 'ready',
      projection,
      panes,
      handles: {
        navigator: prepared[0]!.handle,
        pilot: prepared[1]!.handle,
      },
    };
    this.#states.set(pairId, ready);
    retainOwnership = true;
    return ready;
    } finally {
      if (!retainOwnership) this.#releaseOwnership(pairId);
    }
  }

  recoverPair(pairIdInput: string): Promise<ReadyPair> {
    let pairId: PairId;
    try {
      this.#assertOpen();
      pairId = parsePairId(pairIdInput);
    } catch (error) {
      return Promise.reject(error);
    }
    const resumeError = this.#resumeErrors.get(pairId);
    if (resumeError !== undefined) return Promise.reject(resumeError);
    const cached = this.#states.get(pairId);
    if (cached?.status === 'ready') return Promise.resolve(cached);
    if (cached?.status === 'failed') {
      return Promise.reject(new PairNotReadyError(pairId, cached.reason));
    }
    const existingRecovery = this.#recoveries.get(pairId);
    if (existingRecovery !== undefined) return existingRecovery;

    let recovery!: Promise<ReadyPair>;
    recovery = this.#trackLifecycle((async () => {
      try {
        return await this.#recoverColdPair(pairId);
      } finally {
        if (this.#recoveries.get(pairId) === recovery) {
          this.#recoveries.delete(pairId);
        }
      }
    })());
    this.#recoveries.set(pairId, recovery);
    return recovery;
  }

  async #recoverColdPair(pairId: PairId): Promise<ReadyPair> {
    const events = await this.store.replay(pairId);
    if (events.length === 0) throw new PairNotFoundError(pairId);
    const projection = replayPairProjection(events);
    const persistedBuild = projection.header.dshBuild;
    const persistedArtifacts = projection.header.dshRuntimeArtifacts;
    if (persistedBuild === undefined) {
      throw new DshBuildAttestationError(
        `Pair ${pairId} has no persisted DSH build attestation`,
      );
    }
    if (persistedArtifacts === undefined) {
      throw new DshBuildAttestationError(
        `Pair ${pairId} has no persisted DSH runtime artifact attestation`,
      );
    }
    const actualAttestation = assertAdapterBuild(this.adapter, persistedBuild);
    if (
      canonicalJsonStringify(actualAttestation.runtimeArtifacts) !==
      canonicalJsonStringify(persistedArtifacts)
    ) {
      throw new DshBuildAttestationError(
        `Pair ${pairId} DSH runtime artifacts do not match the Agent adapter attestation`,
      );
    }
    const lifecycleEvent = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === 'pair.agent_ready' || event.type === 'pair.agent_failed',
      );
    if (lifecycleEvent?.type !== 'pair.agent_ready') {
      throw new PairNotReadyError(pairId);
    }
    const panes = readReadyPanes(lifecycleEvent.payload);
    const expectedIds = createPairSessionIds(pairId);
    if (
      panes === undefined ||
      panes[0].sessionId !== expectedIds.navigatorSessionId ||
      panes[1].sessionId !== expectedIds.pilotSessionId
    ) {
      throw new PairNotReadyError(pairId);
    }
    await this.#claimOwnership(pairId);
    let retainOwnership = false;
    try {
    const inputs: readonly PreparePairAgentInput[] = panes.map((pane) => ({
      pairId,
      role: pane.role,
      sessionId: pane.sessionId,
    }));
    const settled = await Promise.allSettled(
      inputs.map((agentInput) =>
        Promise.resolve().then(() => this.adapter.resumePairAgent(agentInput)),
      ),
    );
    const resumed = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const rejectedIndex = settled.findIndex((result) => result.status === 'rejected');
    let failure:
      | { failedRole?: PairRole; reason: string }
      | undefined;
    if (rejectedIndex >= 0) {
      const rejected = settled[rejectedIndex]!;
      failure = {
        failedRole: inputs[rejectedIndex]?.role,
        reason:
          rejected.status === 'rejected'
            ? errorMessage(rejected.reason)
            : 'Agent resume failed',
      };
    } else {
      for (let index = 0; index < resumed.length; index += 1) {
        if (!isExpectedDescriptor(resumed[index]!.descriptor, panes[index]!)) {
          failure = {
            failedRole: inputs[index]!.role,
            reason: `Adapter returned an invalid resumed ${inputs[index]!.role} descriptor`,
          };
          break;
        }
      }
    }
    if (failure !== undefined) {
      const released = await this.#releasePairHandles(
        pairId,
        resumed.map(({ handle }) => handle),
      );
      if (!released) retainOwnership = true;
      const error = new PairResumeError(
        pairId,
        failure.failedRole,
        failure.reason,
      );
      this.#resumeErrors.set(pairId, error);
      throw error;
    }
    try {
      await this.adapter.auditPairRequests?.({
        pairId,
        sessions: {
          navigator: resumed[0]!.handle,
          pilot: resumed[1]!.handle,
        },
      });
    } catch (error) {
      const released = await this.#releasePairHandles(
        pairId,
        resumed.map(({ handle }) => handle),
      );
      if (!released) retainOwnership = true;
      const resumeError = new PairResumeError(
        pairId,
        undefined,
        errorMessage(error),
      );
      this.#resumeErrors.set(pairId, resumeError);
      throw resumeError;
    }
    const ready: ReadyPair = {
      status: 'ready',
      projection,
      panes,
      handles: {
        navigator: resumed[0]!.handle,
        pilot: resumed[1]!.handle,
      },
    };
    this.#states.set(pairId, ready);
    this.publishProjection(projection);
    retainOwnership = true;
    return ready;
    } finally {
      if (!retainOwnership) this.#releaseOwnership(pairId);
    }
  }

  getReadyPair(pairIdInput: string): Promise<ReadyPair> {
    return this.recoverPair(pairIdInput);
  }

  async runPairMutation<TResult>(
    pairIdInput: string,
    expectedLedgerHead: number,
    operation: (context: PairMutationContext) => Promise<TResult>,
  ): Promise<TResult> {
    this.#assertOpen();
    const pairId = parsePairId(pairIdInput);
    const storageIdentity = await this.#getStorageIdentity();
    return serializePairMutation(`${storageIdentity}\0${pairId}`, async () => {
      this.#assertOpen();
      const ready = await this.getReadyPair(pairId);
      const events = await this.store.replay(pairId);
      if (events.length === 0) throw new PairNotFoundError(pairId);
      let projection = replayPairProjection(events);
      const actualLedgerHead = projection.header.ledgerHead;
      if (actualLedgerHead !== expectedLedgerHead) {
        throw new LedgerConflictError(expectedLedgerHead, actualLedgerHead);
      }
      this.publishProjection(projection);
      let appended = false;
      return operation({
        pairId,
        projection,
        ready: { ...ready, projection },
        append: async (draft) => {
          if (appended) {
            throw new InvalidCommandMutationError('A command may append only one Pair event');
          }
          const event = await this.store.append(
            pairId,
            draft,
            projection.header.ledgerHead,
          );
          appended = true;
          projection = foldPairEvent(projection, event);
          this.publishProjection(projection);
          return event;
        },
      });
    });
  }

  subscribe(
    pairIdInput: string,
    listener: PairProjectionListener,
  ): () => void {
    const pairId = parsePairId(pairIdInput);
    const listeners = this.#subscriptions.get(pairId) ?? new Set();
    listeners.add(listener);
    this.#subscriptions.set(pairId, listeners);
    return () => {
      const current = this.#subscriptions.get(pairId);
      current?.delete(listener);
      if (current?.size === 0) this.#subscriptions.delete(pairId);
    };
  }

  subscriberCount(pairIdInput: string): number {
    const pairId = parsePairId(pairIdInput);
    return this.#subscriptions.get(pairId)?.size ?? 0;
  }

  async publish(pairIdInput: string): Promise<PairProjection> {
    const pairId = parsePairId(pairIdInput);
    const events = await this.store.replay(pairId);
    if (events.length === 0) throw new PairNotFoundError(pairId);
    const projection = replayPairProjection(events);
    return this.publishProjection(projection);
  }

  publishProjection(projection: PairProjection): PairProjection {
    const pairId = parsePairId(projection.header.pairId);
    const current = this.#latestProjections.get(pairId);
    if (
      current !== undefined &&
      projection.header.ledgerHead <= current.header.ledgerHead
    ) {
      return current;
    }
    this.#latestProjections.set(pairId, projection);
    const state = this.#states.get(pairId);
    if (state !== undefined) {
      this.#states.set(pairId, { ...state, projection });
    }
    for (const listener of this.#subscriptions.get(pairId) ?? []) {
      try {
        listener(projection);
      } catch (error) {
        try {
          this.#options.onSubscriberError?.(error, { pairId, projection });
        } catch {
          // Subscriber diagnostics must not break mutation delivery.
        }
      }
    }
    return projection;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    const lifecycles = [...this.#lifecycles];
    let closing!: Promise<void>;
    closing = (async () => {
      await Promise.allSettled(lifecycles);
      const handlesByPair = new Map<PairId, Set<AgentHandle>>();
      for (const [pairId, state] of this.#states) {
        if (state.status !== 'ready') continue;
        handlesByPair.set(
          pairId,
          new Set([state.handles.navigator, state.handles.pilot]),
        );
      }
      for (const [pairId, degraded] of this.#degradedHandles) {
        const handles = handlesByPair.get(pairId) ?? new Set<AgentHandle>();
        for (const handle of degraded) handles.add(handle);
        handlesByPair.set(pairId, handles);
      }
      const releaseResults = await Promise.all(
        [...handlesByPair].map(([pairId, handles]) =>
          this.#releasePairHandles(pairId, [...handles]),
        ),
      );
      const allHandlesReleased = releaseResults.every(Boolean);
      let adapterClosed = false;
      let adapterCloseError: unknown;
      if (this.adapter.close !== undefined) {
        try {
          await this.adapter.close();
          adapterClosed = true;
        } catch (error) {
          adapterCloseError = error;
        }
      }
      if (allHandlesReleased || adapterClosed) {
        this.#degradedHandles.clear();
        this.#releaseAllOwnership();
      }
      if (!allHandlesReleased && !adapterClosed) {
        throw new AggregateError(
          adapterCloseError === undefined ? [] : [adapterCloseError],
          'Pair registry cleanup could not prove every owned Agent was disposed',
        );
      }
      if (adapterCloseError !== undefined) throw adapterCloseError;
    })().catch((error: unknown) => {
      if (this.#closePromise === closing) this.#closePromise = undefined;
      throw error;
    });
    this.#closePromise = closing;
    return closing;
  }

  async #releasePairHandles(
    pairId: PairId,
    handles: readonly AgentHandle[],
  ): Promise<boolean> {
    const owned = new Set(
      [
        ...(this.#degradedHandles.get(pairId) ?? []),
        ...handles,
      ].filter((handle) => !this.#releasedHandles.has(handle)),
    );
    const settled = await Promise.allSettled(
      [...owned].map((handle) =>
        Promise.resolve().then(() => this.adapter.release(handle)),
      ),
    );
    const failed = new Set<AgentHandle>();
    let index = 0;
    for (const handle of owned) {
      if (settled[index]?.status === 'rejected') {
        failed.add(handle);
      } else {
        this.#releasedHandles.add(handle);
      }
      index += 1;
    }
    if (failed.size > 0) {
      this.#degradedHandles.set(pairId, failed);
      return false;
    }
    this.#degradedHandles.delete(pairId);
    return true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new RegistryClosedError();
  }

  #getStorageIdentity(): Promise<string> {
    return (this.#storageIdentity ??= realpath(this.store.root).catch((error) => {
      this.#storageIdentity = undefined;
      throw error;
    }));
  }

  async #claimOwnership(pairId: PairId): Promise<void> {
    const key = `${await this.#getStorageIdentity()}\0${pairId}`;
    const owner = LIVE_PAIR_OWNERS.get(key);
    if (owner !== undefined && owner !== this.#ownershipToken) {
      throw new PairOwnershipConflictError(pairId);
    }
    LIVE_PAIR_OWNERS.set(key, this.#ownershipToken);
    this.#ownedLeaseKeys.set(pairId, key);
  }

  #releaseOwnership(pairId: PairId): void {
    const key = this.#ownedLeaseKeys.get(pairId);
    if (key === undefined) return;
    if (LIVE_PAIR_OWNERS.get(key) === this.#ownershipToken) {
      LIVE_PAIR_OWNERS.delete(key);
    }
    this.#ownedLeaseKeys.delete(pairId);
  }

  #releaseAllOwnership(): void {
    for (const pairId of [...this.#ownedLeaseKeys.keys()]) {
      this.#releaseOwnership(pairId);
    }
  }

  #trackLifecycle<TResult>(promise: Promise<TResult>): Promise<TResult> {
    this.#lifecycles.add(promise);
    void promise.then(
      () => this.#lifecycles.delete(promise),
      () => this.#lifecycles.delete(promise),
    );
    return promise;
  }
}

class InvalidCommandMutationError extends Error {}
