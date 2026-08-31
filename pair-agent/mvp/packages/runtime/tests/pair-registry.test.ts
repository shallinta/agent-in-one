import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPairSessionIds,
  type DshBuildRef,
  type PairEventDraft,
  type PairRole,
} from '@pair-agent/contracts';
import {
  JsonlPairLedgerStore,
  encodePairIdForStorage,
  replayPairProjection,
} from '@pair-agent/ledger';
import { afterEach, describe, expect, test } from 'vitest';

import {
  DuplicatePairError,
  PairNotFoundError,
  PairNotReadyError,
  PairOwnershipConflictError,
  PairResumeError,
  PairRegistry,
  RegistryClosedError,
  type AgentAdapter,
  type AgentHandle,
  type PreparePairAgentInput,
  type PreparedPairAgent,
} from '../src/pair-registry.js';

const roots: string[] = [];

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pair-runtime-registry-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

const dshBuild: DshBuildRef = {
  upstreamRepository: 'openai/deepseek-harness',
  upstreamCommit: 'a'.repeat(40),
  sourceRepository: 'example/pair-agent',
  sourceCommit: 'b'.repeat(40),
  requestLayoutSeamVersion: 1,
};

const runtimeArtifacts = {
  schemaVersion: 1 as const,
  buildProfile: 'official' as const,
  roots: ['apps', 'native', 'packages', 'vendor'] as const,
  fileCount: 1936,
  digest: `sha256:${'c'.repeat(64)}`,
};

class FakeAdapter implements AgentAdapter {
  readonly calls: string[] = [];
  readonly released: AgentHandle[] = [];
  closeCalls = 0;
  failRole?: PairRole;
  failResumeRole?: PairRole;
  onPrepare?: (input: PreparePairAgentInput) => Promise<void>;
  onResume?: (input: PreparePairAgentInput) => Promise<void>;
  auditError?: Error;
  releaseFailuresRemaining = 0;
  closeFailuresRemaining = 0;
  attestedDshBuild: DshBuildRef = dshBuild;
  attestedRuntimeArtifacts = runtimeArtifacts;

  getDshRuntimeAttestation() {
    return {
      dshBuild: this.attestedDshBuild,
      runtimeArtifacts: this.attestedRuntimeArtifacts,
    };
  }

  async preparePairAgent(input: PreparePairAgentInput): Promise<PreparedPairAgent> {
    this.calls.push(`prepare:${input.role}:${input.sessionId}`);
    await this.onPrepare?.(input);
    if (input.role === this.failRole) throw new Error(`${input.role} failed`);
    return {
      handle: { sessionId: input.sessionId },
      descriptor: {
        role: input.role,
        source: `${input.role}-session`,
        sessionId: input.sessionId,
      },
    };
  }

  async release(handle: AgentHandle): Promise<void> {
    this.calls.push(`release:${handle.sessionId}`);
    this.released.push(handle);
    if (this.releaseFailuresRemaining > 0) {
      this.releaseFailuresRemaining -= 1;
      throw new Error(`release failed for ${handle.sessionId}`);
    }
  }

  async resumePairAgent(input: PreparePairAgentInput): Promise<PreparedPairAgent> {
    this.calls.push(`resume:${input.role}:${input.sessionId}`);
    await this.onResume?.(input);
    if (input.role === this.failResumeRole) {
      throw new Error(`${input.role} resume failed`);
    }
    return {
      handle: { sessionId: input.sessionId, resumed: true },
      descriptor: {
        role: input.role,
        source: `${input.role}-session`,
        sessionId: input.sessionId,
      },
    };
  }

  async followup(): Promise<void> {}

  async auditPairRequests(): Promise<void> {
    if (this.auditError !== undefined) throw this.auditError;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeFailuresRemaining > 0) {
      this.closeFailuresRemaining -= 1;
      throw new Error('adapter close failed');
    }
  }
}

describe('PairRegistry create lifecycle', () => {
  test('creates a stable ready mapping only after both distinct agents prepare', async () => {
    const store = new JsonlPairLedgerStore(await createRoot());
    const adapter = new FakeAdapter();
    const registry = new PairRegistry(store, adapter);

    const result = await registry.createPair({
      pairId: 'pair-01',
      dshBuild,
      expectedLedgerHead: 0,
    });

    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('expected ready Pair');
    expect(result.panes).toEqual([
      {
        role: 'navigator',
        source: 'navigator-session',
        sessionId: 'pair:pair-01:navigator',
      },
      {
        role: 'pilot',
        source: 'pilot-session',
        sessionId: 'pair:pair-01:pilot',
      },
    ]);
    expect(new Set(result.panes.map((pane) => pane.sessionId)).size).toBe(2);
    expect(result.handles).toEqual({
      navigator: { sessionId: 'pair:pair-01:navigator' },
      pilot: { sessionId: 'pair:pair-01:pilot' },
    });
    expect(adapter.calls).toEqual([
      'prepare:navigator:pair:pair-01:navigator',
      'prepare:pilot:pair:pair-01:pilot',
    ]);

    const events = await store.read('pair-01');
    expect(events.map(({ type, visibility }) => [type, visibility])).toEqual([
      ['pair.created', 'shared'],
      ['pair.agent_ready', 'infrastructure'],
    ]);
    expect(events[0]?.payload).toMatchObject({
      schemaVersion: 1,
      ...createPairSessionIds('pair-01'),
      dshBuild,
    });
  });

  test('releases every successful handle and records a failed, non-addressable Pair', async () => {
    const store = new JsonlPairLedgerStore(await createRoot());
    const adapter = new FakeAdapter();
    adapter.failRole = 'pilot';
    const registry = new PairRegistry(store, adapter);

    const result = await registry.createPair({
      pairId: 'pair-failed',
      dshBuild,
      expectedLedgerHead: 0,
    });

    expect(result).toMatchObject({ status: 'failed', failedRole: 'pilot' });
    expect(adapter.released).toEqual([
      { sessionId: 'pair:pair-failed:navigator' },
    ]);
    expect((await store.read('pair-failed')).map((event) => event.type)).toEqual([
      'pair.created',
      'pair.agent_failed',
    ]);
    await expect(registry.getReadyPair('pair-failed')).rejects.toBeInstanceOf(
      PairNotReadyError,
    );
  });

  test('retains a create-cleanup failure for retry by registry close', async () => {
    const store = new JsonlPairLedgerStore(await createRoot());
    const adapter = new FakeAdapter();
    adapter.failRole = 'pilot';
    adapter.releaseFailuresRemaining = 1;
    const registry = new PairRegistry(store, adapter);

    await expect(
      registry.createPair({
        pairId: 'pair-create-degraded',
        dshBuild,
        expectedLedgerHead: 0,
      }),
    ).resolves.toMatchObject({ status: 'failed', failedRole: 'pilot' });
    expect(adapter.released).toEqual([
      { sessionId: 'pair:pair-create-degraded:navigator' },
    ]);

    await registry.close();
    expect(adapter.released).toEqual([
      { sessionId: 'pair:pair-create-degraded:navigator' },
      { sessionId: 'pair:pair-create-degraded:navigator' },
    ]);
  });

  test('releases both handles if an adapter returns a conflicting descriptor', async () => {
    const store = new JsonlPairLedgerStore(await createRoot());
    const adapter = new FakeAdapter();
    adapter.preparePairAgent = async (input) => ({
      handle: { sessionId: input.sessionId },
      descriptor: {
        role: input.role,
        source: `${input.role}-session`,
        sessionId: input.role === 'pilot' ? 'wrong-session' : input.sessionId,
      },
    });
    const registry = new PairRegistry(store, adapter);

    const result = await registry.createPair({
      pairId: 'pair-invalid-adapter',
      dshBuild,
      expectedLedgerHead: 0,
    });

    expect(result.status).toBe('failed');
    expect(adapter.released).toHaveLength(2);
    expect((await store.read('pair-invalid-adapter')).at(-1)?.type).toBe(
      'pair.agent_failed',
    );
  });

  test('contains a synchronous adapter throw and still releases other prepared handles', async () => {
    const store = new JsonlPairLedgerStore(await createRoot());
    const adapter = new FakeAdapter();
    adapter.preparePairAgent = (input) => {
      if (input.role === 'pilot') throw new Error('synchronous adapter failure');
      return Promise.resolve({
        handle: { sessionId: input.sessionId },
        descriptor: {
          role: input.role,
          source: `${input.role}-session`,
          sessionId: input.sessionId,
        },
      });
    };
    const registry = new PairRegistry(store, adapter);

    const result = await registry.createPair({
      pairId: 'pair-sync-failure',
      dshBuild,
      expectedLedgerHead: 0,
    });

    expect(result).toMatchObject({ status: 'failed', failedRole: 'pilot' });
    expect(adapter.released).toEqual([
      { sessionId: 'pair:pair-sync-failure:navigator' },
    ]);
    expect((await store.read('pair-sync-failure')).at(-1)?.type).toBe(
      'pair.agent_failed',
    );
  });

  test('records preparation failure even when adapter release itself throws', async () => {
    const store = new JsonlPairLedgerStore(await createRoot());
    const adapter = new FakeAdapter();
    adapter.failRole = 'pilot';
    adapter.release = () => {
      throw new Error('release failed synchronously');
    };
    const registry = new PairRegistry(store, adapter);

    const result = await registry.createPair({
      pairId: 'pair-release-failure',
      dshBuild,
      expectedLedgerHead: 0,
    });

    expect(result.status).toBe('failed');
    expect((await store.read('pair-release-failure')).at(-1)?.type).toBe(
      'pair.agent_failed',
    );
  });

  test('rejects duplicate creation without preparing more agents', async () => {
    const store = new JsonlPairLedgerStore(await createRoot());
    const adapter = new FakeAdapter();
    const registry = new PairRegistry(store, adapter);
    await registry.createPair({ pairId: 'pair-duplicate', dshBuild, expectedLedgerHead: 0 });

    await expect(
      registry.createPair({ pairId: 'pair-duplicate', dshBuild, expectedLedgerHead: 0 }),
    ).rejects.toBeInstanceOf(DuplicatePairError);
    expect(adapter.calls.filter((call) => call.startsWith('prepare:'))).toHaveLength(2);
  });

  test('rejects an invalid DSH build reference before writing pair.created', async () => {
    const store = new JsonlPairLedgerStore(await createRoot());
    const adapter = new FakeAdapter();
    const registry = new PairRegistry(store, adapter);

    await expect(
      registry.createPair({
        pairId: 'invalid-build',
        dshBuild: { ...dshBuild, upstreamCommit: 'floating-tag' },
        expectedLedgerHead: 0,
      }),
    ).rejects.toThrow(/upstreamCommit/);
    expect(await store.read('invalid-build')).toEqual([]);
    expect(adapter.calls).toEqual([]);
  });

  test('persists the adapter-owned runtime artifact attestation in Pair Header', async () => {
    const store = new JsonlPairLedgerStore(await createRoot());
    const adapter = new FakeAdapter();
    const result = await new PairRegistry(store, adapter).createPair({
      pairId: 'artifact-header',
      dshBuild,
      expectedLedgerHead: 0,
    });
    expect(result.projection.header.dshRuntimeArtifacts).toEqual(runtimeArtifacts);
    expect((await store.read('artifact-header'))[0]?.payload).toMatchObject({
      dshRuntimeArtifacts: runtimeArtifacts,
    });
  });

  test('rejects a claimed DSH build that differs from the adapter attestation before writing pair.created', async () => {
    const store = new JsonlPairLedgerStore(await createRoot());
    const adapter = new FakeAdapter();
    adapter.attestedDshBuild = {
      ...dshBuild,
      sourceCommit: 'd'.repeat(40),
    };
    const registry = new PairRegistry(store, adapter);

    await expect(
      registry.createPair({
        pairId: 'false-build-claim',
        dshBuild,
        expectedLedgerHead: 0,
      }),
    ).rejects.toThrow(/attestation|build/i);
    expect(await store.read('false-build-claim')).toEqual([]);
    expect(adapter.calls).toEqual([]);
  });

  test('close waits for in-flight creation, releases prepared handles, and prevents ready state', async () => {
    const store = new JsonlPairLedgerStore(await createRoot());
    const adapter = new FakeAdapter();
    const prepareEntered = deferred<void>();
    const releasePrepare = deferred<void>();
    let entered = 0;
    adapter.onPrepare = async () => {
      entered += 1;
      if (entered === 2) prepareEntered.resolve();
      await releasePrepare.promise;
    };
    const registry = new PairRegistry(store, adapter);

    const creating = registry.createPair({
      pairId: 'pair-close-create',
      dshBuild,
      expectedLedgerHead: 0,
    });
    await prepareEntered.promise;
    const closing = registry.close();
    await expect(
      Promise.race([closing.then(() => 'closed'), Promise.resolve('pending')]),
    ).resolves.toBe('pending');
    releasePrepare.resolve();

    await expect(creating).rejects.toBeInstanceOf(RegistryClosedError);
    await closing;
    expect(adapter.released).toEqual([
      { sessionId: 'pair:pair-close-create:navigator' },
      { sessionId: 'pair:pair-close-create:pilot' },
    ]);
    expect((await store.read('pair-close-create')).map(({ type }) => type)).toEqual([
      'pair.created',
    ]);
    await expect(
      registry.createPair({
        pairId: 'pair-after-close',
        dshBuild,
        expectedLedgerHead: 0,
      }),
    ).rejects.toBeInstanceOf(RegistryClosedError);
    expect(await store.read('pair-after-close')).toEqual([]);
  });
});

describe('PairRegistry recovery and subscriptions', () => {
  test('grants one live registry ownership and transfers it only after close', async () => {
    const root = await createRoot();
    const firstAdapter = new FakeAdapter();
    const first = new PairRegistry(new JsonlPairLedgerStore(root), firstAdapter);
    await first.createPair({ pairId: 'owned-pair', dshBuild, expectedLedgerHead: 0 });
    const secondAdapter = new FakeAdapter();
    const second = new PairRegistry(new JsonlPairLedgerStore(root), secondAdapter);

    await expect(second.recoverPair('owned-pair')).rejects.toMatchObject({
      name: 'PairOwnershipConflictError',
    });
    expect(secondAdapter.calls).toEqual([]);
    await first.close();
    await expect(second.recoverPair('owned-pair')).resolves.toMatchObject({ status: 'ready' });
    expect(secondAdapter.calls).toEqual([
      'resume:navigator:pair:owned-pair:navigator',
      'resume:pilot:pair:owned-pair:pilot',
    ]);
    await second.close();
  });

  test('releases ownership and both resumed handles when Pair-level audit fails', async () => {
    const root = await createRoot();
    const creator = new PairRegistry(new JsonlPairLedgerStore(root), new FakeAdapter());
    await creator.createPair({ pairId: 'audit-failure', dshBuild, expectedLedgerHead: 0 });
    await creator.close();
    const failingAdapter = new FakeAdapter();
    failingAdapter.auditError = new Error('unconsumed historical snapshot');
    const failing = new PairRegistry(new JsonlPairLedgerStore(root), failingAdapter);
    await expect(failing.recoverPair('audit-failure')).rejects.toThrow(/unconsumed/);
    expect(failingAdapter.released).toHaveLength(2);
    const successor = new PairRegistry(new JsonlPairLedgerStore(root), new FakeAdapter());
    await expect(successor.recoverPair('audit-failure')).resolves.toMatchObject({ status: 'ready' });
    await successor.close();
    await failing.close();
  });

  test('retains degraded ownership when audit cleanup cannot release a resumed handle', async () => {
    const root = await createRoot();
    const creator = new PairRegistry(new JsonlPairLedgerStore(root), new FakeAdapter());
    await creator.createPair({
      pairId: 'audit-release-failure',
      dshBuild,
      expectedLedgerHead: 0,
    });
    await creator.close();
    const failingAdapter = new FakeAdapter();
    failingAdapter.auditError = new Error('historical audit failed');
    failingAdapter.releaseFailuresRemaining = 1;
    const failing = new PairRegistry(
      new JsonlPairLedgerStore(root),
      failingAdapter,
    );

    await expect(failing.recoverPair('audit-release-failure')).rejects.toThrow(
      /historical audit failed/,
    );
    const successorAdapter = new FakeAdapter();
    const successor = new PairRegistry(
      new JsonlPairLedgerStore(root),
      successorAdapter,
    );
    await expect(successor.recoverPair('audit-release-failure')).rejects.toBeInstanceOf(
      PairOwnershipConflictError,
    );
    expect(successorAdapter.calls).toEqual([]);

    await failing.close();
    await expect(successor.recoverPair('audit-release-failure')).resolves.toMatchObject({
      status: 'ready',
    });
    await successor.close();
  });

  test('does not transfer ownership until a failed close cleanup is retried successfully', async () => {
    const root = await createRoot();
    const adapter = new FakeAdapter();
    const first = new PairRegistry(new JsonlPairLedgerStore(root), adapter);
    await first.createPair({
      pairId: 'close-cleanup-failure',
      dshBuild,
      expectedLedgerHead: 0,
    });
    adapter.releaseFailuresRemaining = 1;
    adapter.closeFailuresRemaining = 1;

    await expect(first.close()).rejects.toThrow(/cleanup|close failed/i);
    const successorAdapter = new FakeAdapter();
    const successor = new PairRegistry(
      new JsonlPairLedgerStore(root),
      successorAdapter,
    );
    await expect(successor.recoverPair('close-cleanup-failure')).rejects.toBeInstanceOf(
      PairOwnershipConflictError,
    );
    expect(successorAdapter.calls).toEqual([]);

    await expect(first.close()).resolves.toBeUndefined();
    expect(
      adapter.calls.filter(
        (call) => call === 'release:pair:close-cleanup-failure:navigator',
      ),
    ).toHaveLength(2);
    expect(
      adapter.calls.filter(
        (call) => call === 'release:pair:close-cleanup-failure:pilot',
      ),
    ).toHaveLength(1);
    await expect(successor.recoverPair('close-cleanup-failure')).resolves.toMatchObject({
      status: 'ready',
    });
    await successor.close();
  });

  test('keeps ownership when handle release fails and the adapter has no wide close', async () => {
    const root = await createRoot();
    const adapter = new FakeAdapter();
    const first = new PairRegistry(new JsonlPairLedgerStore(root), adapter);
    await first.createPair({
      pairId: 'close-less-cleanup-failure',
      dshBuild,
      expectedLedgerHead: 0,
    });
    adapter.releaseFailuresRemaining = 2;
    (adapter as unknown as { close?: () => Promise<void> }).close = undefined;

    await expect(first.close()).rejects.toThrow(/could not prove/i);
    const successorAdapter = new FakeAdapter();
    const successor = new PairRegistry(
      new JsonlPairLedgerStore(root),
      successorAdapter,
    );
    await expect(
      successor.recoverPair('close-less-cleanup-failure'),
    ).rejects.toBeInstanceOf(PairOwnershipConflictError);
    expect(successorAdapter.calls).toEqual([]);

    await expect(first.close()).resolves.toBeUndefined();
    await expect(
      successor.recoverPair('close-less-cleanup-failure'),
    ).resolves.toMatchObject({ status: 'ready' });
    await successor.close();
  });

  test('recovers a ready Pair by resuming both persisted agent sessions', async () => {
    const root = await createRoot();
    const store = new JsonlPairLedgerStore(root);
    const firstAdapter = new FakeAdapter();
    const firstRegistry = new PairRegistry(store, firstAdapter);
    await firstRegistry.createPair({
      pairId: 'pair-recover',
      dshBuild,
      expectedLedgerHead: 0,
    });
    await firstRegistry.close();
    const recoveringAdapter = new FakeAdapter();

    const recovered = await new PairRegistry(
      new JsonlPairLedgerStore(root),
      recoveringAdapter,
    ).recoverPair('pair-recover');

    expect(recovered.status).toBe('ready');
    expect(recovered.projection.header.ledgerHead).toBe(2);
    expect(recovered.handles).toEqual({
      navigator: { sessionId: 'pair:pair-recover:navigator', resumed: true },
      pilot: { sessionId: 'pair:pair-recover:pilot', resumed: true },
    });
    expect(recoveringAdapter.calls).toEqual([
      'resume:navigator:pair:pair-recover:navigator',
      'resume:pilot:pair:pair-recover:pilot',
    ]);
  });

  test('rejects recovery from a different attested DSH fork before resuming either session', async () => {
    const root = await createRoot();
    const store = new JsonlPairLedgerStore(root);
    await new PairRegistry(store, new FakeAdapter()).createPair({
      pairId: 'pair-wrong-fork',
      dshBuild,
      expectedLedgerHead: 0,
    });
    const differentFork = new FakeAdapter();
    differentFork.attestedDshBuild = {
      ...dshBuild,
      upstreamRepository: 'example/a-different-fork',
    };

    await expect(
      new PairRegistry(
        new JsonlPairLedgerStore(root),
        differentFork,
      ).recoverPair('pair-wrong-fork'),
    ).rejects.toThrow(/attestation|build/i);
    expect(differentFork.calls).toEqual([]);
  });

  test('rejects the same source commit with different runtime artifacts before resume', async () => {
    const root = await createRoot();
    const store = new JsonlPairLedgerStore(root);
    await new PairRegistry(store, new FakeAdapter()).createPair({
      pairId: 'pair-wrong-artifacts',
      dshBuild,
      expectedLedgerHead: 0,
    });
    const changed = new FakeAdapter();
    changed.attestedRuntimeArtifacts = {
      ...runtimeArtifacts,
      digest: `sha256:${'d'.repeat(64)}`,
    };

    await expect(
      new PairRegistry(new JsonlPairLedgerStore(root), changed).recoverPair(
        'pair-wrong-artifacts',
      ),
    ).rejects.toThrow(/runtime artifacts.*attestation/i);
    expect(changed.calls).toEqual([]);
  });

  test('releases a partially resumed Pair and reports an explicit degraded recovery error', async () => {
    const root = await createRoot();
    const store = new JsonlPairLedgerStore(root);
    const creator = new PairRegistry(store, new FakeAdapter());
    await creator.createPair({
      pairId: 'pair-resume-failed',
      dshBuild,
      expectedLedgerHead: 0,
    });
    await creator.close();
    const recoveringAdapter = new FakeAdapter();
    recoveringAdapter.failResumeRole = 'pilot';
    const recovering = new PairRegistry(
      new JsonlPairLedgerStore(root),
      recoveringAdapter,
    );

    await expect(recovering.recoverPair('pair-resume-failed')).rejects.toMatchObject({
      name: 'PairResumeError',
      failedRole: 'pilot',
    } satisfies Partial<PairResumeError>);
    expect(recoveringAdapter.released).toEqual([
      { sessionId: 'pair:pair-resume-failed:navigator', resumed: true },
    ]);
    await expect(recovering.getReadyPair('pair-resume-failed')).rejects.toBeInstanceOf(
      PairResumeError,
    );
  });

  test('single-flights concurrent cold recover and getReady calls per Pair', async () => {
    const root = await createRoot();
    const creator = new PairRegistry(
      new JsonlPairLedgerStore(root),
      new FakeAdapter(),
    );
    await creator.createPair({
      pairId: 'pair-single-flight',
      dshBuild,
      expectedLedgerHead: 0,
    });
    await creator.close();
    const resumeEntered = deferred<void>();
    const releaseResume = deferred<void>();
    let entered = 0;
    const adapter = new FakeAdapter();
    adapter.onResume = async () => {
      entered += 1;
      if (entered === 2) resumeEntered.resolve();
      await releaseResume.promise;
    };
    const registry = new PairRegistry(new JsonlPairLedgerStore(root), adapter);

    const first = registry.recoverPair('pair-single-flight');
    const second = registry.getReadyPair('pair-single-flight');
    expect(first).toBe(second);
    await resumeEntered.promise;
    releaseResume.resolve();
    const [firstReady, secondReady] = await Promise.all([first, second]);

    expect(firstReady).toBe(secondReady);
    expect(
      adapter.calls.filter((call) => call.startsWith('resume:navigator')),
    ).toHaveLength(1);
    expect(
      adapter.calls.filter((call) => call.startsWith('resume:pilot')),
    ).toHaveLength(1);
    await registry.close();
  });

  test('close waits for an in-flight cold recovery and releases every resumed handle', async () => {
    const root = await createRoot();
    const creator = new PairRegistry(
      new JsonlPairLedgerStore(root),
      new FakeAdapter(),
    );
    await creator.createPair({
      pairId: 'pair-close-recovery',
      dshBuild,
      expectedLedgerHead: 0,
    });
    await creator.close();
    const resumeEntered = deferred<void>();
    const releaseResume = deferred<void>();
    let entered = 0;
    const adapter = new FakeAdapter();
    adapter.onResume = async () => {
      entered += 1;
      if (entered === 2) resumeEntered.resolve();
      await releaseResume.promise;
    };
    const registry = new PairRegistry(new JsonlPairLedgerStore(root), adapter);

    const recovery = registry.recoverPair('pair-close-recovery');
    await resumeEntered.promise;
    const closing = registry.close();
    releaseResume.resolve();
    await Promise.all([recovery, closing]);

    expect(adapter.released).toEqual([
      { sessionId: 'pair:pair-close-recovery:navigator', resumed: true },
      { sessionId: 'pair:pair-close-recovery:pilot', resumed: true },
    ]);
  });

  test('rejects a missing Pair and a ledger without a complete ready mapping', async () => {
    const store = new JsonlPairLedgerStore(await createRoot());
    const registry = new PairRegistry(store, new FakeAdapter());
    await expect(registry.recoverPair('missing')).rejects.toBeInstanceOf(
      PairNotFoundError,
    );

    await store.append(
      'partial',
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
          ...createPairSessionIds('partial'),
          dshBuild: { ...dshBuild },
          dshRuntimeArtifacts: { ...runtimeArtifacts },
        },
      },
      0,
    );
    await expect(registry.recoverPair('partial')).rejects.toBeInstanceOf(
      PairNotReadyError,
    );
  });

  test('does not recover an obsolete ready mapping followed by agent failure', async () => {
    const root = await createRoot();
    const store = new JsonlPairLedgerStore(root);
    await new PairRegistry(store, new FakeAdapter()).createPair({
      pairId: 'failed-after-ready',
      dshBuild,
      expectedLedgerHead: 0,
    });
    await store.append(
      'failed-after-ready',
      {
        type: 'pair.agent_failed',
        actor: { kind: 'host' },
        source: 'pair',
        channel: 'shared-control',
        visibility: 'infrastructure',
        authority: 'host',
        refs: {},
        payload: { failedRole: 'pilot', reason: 'session unavailable' },
      },
      2,
    );

    await expect(
      new PairRegistry(
        new JsonlPairLedgerStore(root),
        new FakeAdapter(),
      ).recoverPair('failed-after-ready'),
    ).rejects.toBeInstanceOf(PairNotReadyError);
  });

  test('publishes a fresh projection after each successful registry append', async () => {
    const registry = new PairRegistry(
      new JsonlPairLedgerStore(await createRoot()),
      new FakeAdapter(),
    );
    const heads: number[] = [];
    const unsubscribe = registry.subscribe('pair-events', (projection) => {
      heads.push(projection.header.ledgerHead);
    });

    await registry.createPair({
      pairId: 'pair-events',
      dshBuild,
      expectedLedgerHead: 0,
    });
    unsubscribe();

    expect(heads).toEqual([1, 2]);
    expect(registry.subscriberCount('pair-events')).toBe(0);
  });

  test('accepts only a strictly newer projection and ignores equal or older candidates', async () => {
    const store = new JsonlPairLedgerStore(await createRoot());
    const registry = new PairRegistry(store, new FakeAdapter());
    await registry.createPair({ pairId: 'pair-monotonic', dshBuild, expectedLedgerHead: 0 });
    const messageDraft = (text: string): PairEventDraft => ({
      type: 'user.message',
      actor: { kind: 'user' },
      source: 'pair',
      channel: 'navigator',
      visibility: 'shared',
      authority: 'user',
      refs: {},
      payload: { text },
    });
    await store.append('pair-monotonic', messageDraft('head 3'), 2);
    const older = replayPairProjection(await store.read('pair-monotonic'));
    await store.append('pair-monotonic', messageDraft('head 4'), 3);
    const newer = replayPairProjection(await store.read('pair-monotonic'));
    const heads: number[] = [];
    registry.subscribe('pair-monotonic', (projection) => {
      heads.push(projection.header.ledgerHead);
    });

    registry.publishProjection(newer);
    registry.publishProjection(older);
    registry.publishProjection(newer);

    expect(heads).toEqual([4]);
    expect((await registry.getReadyPair('pair-monotonic')).projection.header.ledgerHead).toBe(4);
  });

  test('isolates throwing subscribers and reports them without blocking later listeners', async () => {
    const subscriberErrors: unknown[] = [];
    const registry = new PairRegistry(
      new JsonlPairLedgerStore(await createRoot()),
      new FakeAdapter(),
      { onSubscriberError: (error) => subscriberErrors.push(error) },
    );
    await registry.createPair({ pairId: 'pair-listener-error', dshBuild, expectedLedgerHead: 0 });
    const heads: number[] = [];
    registry.subscribe('pair-listener-error', () => {
      throw new Error('broken listener');
    });
    registry.subscribe('pair-listener-error', (projection) => {
      heads.push(projection.header.ledgerHead);
    });

    await storeAppendMessage(registry.store, 'pair-listener-error', 2);
    await registry.publish('pair-listener-error');

    expect(heads).toEqual([3]);
    expect(subscriberErrors).toHaveLength(1);
  });

  test('releases both owned handles once during idempotent shutdown', async () => {
    const adapter = new FakeAdapter();
    const registry = new PairRegistry(
      new JsonlPairLedgerStore(await createRoot()),
      adapter,
    );
    await registry.createPair({ pairId: 'pair-close', dshBuild, expectedLedgerHead: 0 });

    await Promise.all([registry.close(), registry.close()]);
    await registry.close();

    expect(adapter.released).toEqual([
      { sessionId: 'pair:pair-close:navigator' },
      { sessionId: 'pair:pair-close:pilot' },
    ]);
    expect(adapter.closeCalls).toBe(1);
  });

  test('writes actual JSONL records to the configured temp root', async () => {
    const root = await createRoot();
    const registry = new PairRegistry(new JsonlPairLedgerStore(root), new FakeAdapter());
    await registry.createPair({ pairId: 'pair-disk', dshBuild, expectedLedgerHead: 0 });

    const ledger = await readFile(
      join(root, encodePairIdForStorage('pair-disk'), 'pair.jsonl'),
      'utf8',
    );
    expect(ledger.trim().split('\n')).toHaveLength(2);
  });
});

async function storeAppendMessage(
  store: JsonlPairLedgerStore,
  pairId: string,
  expectedLedgerHead: number,
): Promise<void> {
  await store.append(
    pairId,
    {
      type: 'user.message',
      actor: { kind: 'user' },
      source: 'pair',
      channel: 'navigator',
      visibility: 'shared',
      authority: 'user',
      refs: {},
      payload: { text: 'publish' },
    },
    expectedLedgerHead,
  );
}
