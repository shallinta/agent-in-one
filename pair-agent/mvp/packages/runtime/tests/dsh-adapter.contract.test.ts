import { mkdir, readFile, realpath, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createPairSessionIds, type DshBuildRef } from '@pair-agent/contracts';
import { JsonlPairLedgerStore } from '@pair-agent/ledger';
import { afterEach, describe, expect, test } from 'vitest';

import { PairCoordinator } from '../src/coordinator.js';
import {
  DshPairAgentAdapter,
  DshSourceVerificationError,
  launchDshPairWebRuntime,
  measureRuntimeArtifacts,
  verifyRuntimeArtifacts,
} from '../src/dsh-adapter.js';
import { PairRegistry } from '../src/pair-registry.js';
import type { PairRequestMaterialEntry } from '../src/request-material-registry.js';

const roots: string[] = [];

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pair-dsh-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const mvpRoot = resolve(import.meta.dirname, '../../..');
const dshRoot = join(mvpRoot, '.runtime/deepseek-harness');
const dshLockPath = join(mvpRoot, 'dsh.lock.json');
const dshLock = JSON.parse(await readFile(dshLockPath, 'utf8')) as {
  upstreamRepository: string;
  upstreamCommit: string;
  sourceRepository: string;
  expectedDerivedCommit: string;
  requestLayoutSeamVersion: 1;
};

const dshBuild: DshBuildRef = {
  upstreamRepository: dshLock.upstreamRepository,
  upstreamCommit: dshLock.upstreamCommit,
  sourceRepository: dshLock.sourceRepository,
  sourceCommit: dshLock.expectedDerivedCommit,
  requestLayoutSeamVersion: dshLock.requestLayoutSeamVersion,
};

const commonSystem = {
  version: 'pair-prompt/v1',
  content: [
    'You are one member of a Pair Agent.',
    'Navigator owns goal clarification and Pilot owns delegated execution.',
    'The active role is supplied by a later active-role reminder.',
  ].join('\n'),
};

async function createRuntime(
  pairId: string,
  pairRoot: string,
  sessionRoot: string,
  options: {
    model?: string;
    responses?: readonly (
      | string
      | { readonly failure: { readonly message: string; readonly code: string } }
      | {
          readonly toolCall: {
            readonly id: string;
            readonly name: string;
            readonly arguments: Record<string, string>;
          };
        }
    )[];
    retryFailures?: boolean;
    echoTool?: boolean;
    maxTokens?: number;
    reasoningEffort?: string;
    historicalRequestMaterials?: readonly PairRequestMaterialEntry[];
    commonSystem?: { readonly version: string; readonly content: string };
    lifecycleFaults?: {
      afterAgentOpened?(): void;
      beforeDispose?(reason: 'rollback' | 'release' | 'close'): void;
    };
  } = {},
) {
  const store = new JsonlPairLedgerStore(pairRoot);
  let registry: PairRegistry;
  const adapter = await DshPairAgentAdapter.create({
    source: { derivedRoot: dshRoot, lockPath: dshLockPath },
    store,
    sessionRoot,
    commonSystem: options.commonSystem ?? commonSystem,
    provider: 'openai-completions',
    model: options.model ?? 'capture-model',
    capture: {
      responses: [...(options.responses ?? ['Navigator accepted.', 'Pilot accepted.'])],
      ...(options.retryFailures === true ? { retryFailures: true } : {}),
    },
    ...(options.echoTool === true
      ? {
          tools: [
            {
              name: 'echo',
              description: 'Echo text without side effects.',
              parameters: { text: { type: 'string' } },
              async execute(args: Record<string, unknown>) {
                return [{ type: 'text', text: `echo: ${String(args.text)}` }];
              },
            },
          ],
        }
      : {}),
    ...(options.maxTokens === undefined && options.reasoningEffort === undefined
      ? {}
      : {
          requestDefaults: {
            ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
            ...(options.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: options.reasoningEffort }),
          },
        }),
    ...(options.historicalRequestMaterials === undefined
      ? {}
      : { historicalRequestMaterials: options.historicalRequestMaterials }),
    ...(options.lifecycleFaults === undefined
      ? {}
      : { lifecycleFaults: options.lifecycleFaults }),
    onLedgerAdvanced: async (advancedPairId) => {
      await registry.publish(advancedPairId);
    },
  });
  registry = new PairRegistry(store, adapter);
  const coordinator = new PairCoordinator(registry, store, adapter);
  return { pairId, store, adapter, registry, coordinator };
}

describe('DshPairAgentAdapter real-runtime contract', () => {
  test('rejects a prepared checkout whose HEAD does not equal dsh.lock', async () => {
    const badLockRoot = await temporaryRoot('bad-lock');
    const lock = JSON.parse(await readFile(dshLockPath, 'utf8')) as Record<string, unknown>;
    await writeFile(
      join(badLockRoot, 'dsh.lock.json'),
      JSON.stringify({ ...lock, expectedDerivedCommit: '0'.repeat(40) }),
    );

    await expect(
      DshPairAgentAdapter.create({
        source: {
          derivedRoot: dshRoot,
          lockPath: join(badLockRoot, 'dsh.lock.json'),
        },
        store: new JsonlPairLedgerStore(await temporaryRoot('bad-lock-ledger')),
        sessionRoot: await temporaryRoot('bad-lock-sessions'),
        commonSystem,
        provider: 'openai-completions',
        model: 'capture-model',
        capture: { responses: [] },
      }),
    ).rejects.toBeInstanceOf(DshSourceVerificationError);
  });

  test('rejects a tampered transitive DSH runtime artifact even when Git is clean', async () => {
    const root = await temporaryRoot('isolated-artifacts');
    const fixtureRoot = await realpath(root);
    for (const name of ['apps', 'native', 'packages', 'vendor']) {
      await mkdir(join(root, name, 'sample/lib'), { recursive: true });
      await writeFile(join(root, name, 'sample/lib/index.js'), `export const root = '${name}'\n`);
    }
    const base = {
      schemaVersion: 1 as const,
      buildProfile: 'official' as const,
      roots: ['apps', 'native', 'packages', 'vendor'] as const,
      include: 'lib/**/*.{js,cjs,mjs}' as const,
      fileCount: 0,
      digest: `sha256:${'0'.repeat(64)}`,
    };
    const measured = await measureRuntimeArtifacts(fixtureRoot, dshBuild.sourceCommit, base);
    const lock = { ...base, ...measured };
    await expect(verifyRuntimeArtifacts(fixtureRoot, dshBuild.sourceCommit, lock)).resolves.toBeUndefined();
    await writeFile(
      join(root, 'packages/sample/lib/index.js'),
      'export const root = "tampered transitive"\n',
    );
    await expect(
      verifyRuntimeArtifacts(fixtureRoot, dshBuild.sourceCommit, lock),
    ).rejects.toThrow(/runtime artifact integrity/i);
  }, 30_000);

  test('rejects runtime artifact entry floods and oversized files before hashing', async () => {
    const root = await realpath(await temporaryRoot('artifact-limits'));
    for (const name of ['apps', 'native', 'packages', 'vendor']) {
      await mkdir(join(root, name, 'sample/lib'), { recursive: true });
      await writeFile(join(root, name, 'sample/lib/index.js'), 'export const value = 1\n');
    }
    const lock = {
      schemaVersion: 1 as const,
      buildProfile: 'official' as const,
      roots: ['apps', 'native', 'packages', 'vendor'] as const,
      include: 'lib/**/*.{js,cjs,mjs}' as const,
      fileCount: 4,
      digest: `sha256:${'0'.repeat(64)}`,
    };
    const baseLimits = {
      maxTraversalEntries: 100,
      maxDepth: 10,
      maxFiles: 10,
      maxFileBytes: 1024,
      maxTotalBytes: 4096,
    };
    await expect(
      measureRuntimeArtifacts(root, dshBuild.sourceCommit, lock, {
        ...baseLimits,
        maxFiles: 3,
      }),
    ).rejects.toThrow(/file limit/i);
    await expect(
      measureRuntimeArtifacts(root, dshBuild.sourceCommit, lock, {
        ...baseLimits,
        maxFileBytes: 4,
      }),
    ).rejects.toThrow(/per-file size limit/i);
  });

  test('mounts the official openai-completions provider and prepares a stateless call without network I/O', async () => {
    const adapter = await DshPairAgentAdapter.create({
      source: { derivedRoot: dshRoot, lockPath: dshLockPath },
      store: new JsonlPairLedgerStore(await temporaryRoot('official-ledger')),
      sessionRoot: await temporaryRoot('official-sessions'),
      commonSystem,
      provider: 'openai-completions',
      model: 'gpt-test',
      openai: {
        baseURL: 'https://api.openai.com/v1',
        apiKeyEnv: 'PAIR_AGENT_TEST_OPENAI_KEY',
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
    });

    const prepared = await adapter.prepareProviderCall();
    expect(prepared).toMatchObject({
      provider: 'openai-completions',
      model: 'gpt-test',
      maxTokens: 4_096,
    });
    const activeMaterials = adapter.exportRequestMaterials().at(-1);
    expect(activeMaterials?.config).toEqual(prepared);
    expect(JSON.stringify(prepared)).not.toContain('previous_response_id');
    expect(adapter.captureRequests()).toEqual([]);
    await adapter.close();
  }, 30_000);

  test('keeps an explicit OpenAI request maxTokens override in effective immutable materials', async () => {
    const adapter = await DshPairAgentAdapter.create({
      source: { derivedRoot: dshRoot, lockPath: dshLockPath },
      store: new JsonlPairLedgerStore(await temporaryRoot('official-explicit-ledger')),
      sessionRoot: await temporaryRoot('official-explicit-sessions'),
      commonSystem,
      provider: 'openai-completions',
      model: 'gpt-test',
      openai: {
        baseURL: 'https://api.openai.com/v1',
        apiKeyEnv: 'PAIR_AGENT_TEST_OPENAI_KEY',
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
      requestDefaults: { maxTokens: 2_048 },
    });

    const prepared = await adapter.prepareProviderCall();
    expect(prepared).toEqual({
      provider: 'openai-completions',
      model: 'gpt-test',
      maxTokens: 2_048,
    });
    expect(adapter.exportRequestMaterials().at(-1)?.config).toEqual(prepared);
    expect(adapter.captureRequests()).toEqual([]);
    await adapter.close();
  }, 30_000);

  test('persists an effective OpenAI request layout before a test sentinel stops provider streaming', async () => {
    const pairId = 'pair-official-request-layout';
    const dataRoot = await temporaryRoot('official-request-layout');
    const store = new JsonlPairLedgerStore(join(dataRoot, 'pairs'));
    const runtime = await launchDshPairWebRuntime({
      source: { derivedRoot: dshRoot, lockPath: dshLockPath },
      dataRoot,
      store,
      commonSystem,
      provider: 'openai-completions',
      model: 'gpt-test',
      openai: {
        baseURL: 'https://network-must-not-run.invalid/v1',
        apiKeyEnv: 'PAIR_AGENT_TEST_MUST_NOT_RESOLVE_OPENAI_KEY',
        contextWindow: 128_000,
        maxTokens: 4_096,
      },
      web: { host: '127.0.0.1', port: 0 },
    });
    const registry = new PairRegistry(store, runtime.adapter);
    const coordinator = new PairCoordinator(registry, store, runtime.adapter);
    const ids = createPairSessionIds(pairId);
    const sentinelMessage = 'TEST_SENTINEL_BEFORE_PIAI_STREAM';
    let observedConfig: Record<string, unknown> | undefined;
    const disposeSentinel = (runtime.context as unknown as {
      on(
        name: 'llm/stream',
        listener: (options: Record<string, unknown>) => AsyncIterable<never>,
      ): () => void;
    }).on('llm/stream', (options) => {
      observedConfig = {
        provider: options.provider,
        model: options.model,
        maxTokens: options.maxTokens,
      };
      return (async function* (): AsyncIterableIterator<never> {
        throw new Error(sentinelMessage);
      })();
    });

    try {
      await coordinator.createPair({
        pairId,
        dshBuild: runtime.adapter.getDshRuntimeAttestation().dshBuild,
        expectedLedgerHead: 0,
      });
      await coordinator.sendNavigator({
        pairId,
        text: 'Exercise the official OpenAI request layout.',
        expectedLedgerHead: (await store.heads(pairId)).ledgerHead,
      });
      await runtime.adapter.whenIdle(ids.navigatorSessionId);

      expect(runtime.adapter.sessionEvents(ids.navigatorSessionId)).toContainEqual(
        expect.objectContaining({
          type: 'turn/end',
          data: expect.objectContaining({
            reason: expect.objectContaining({
              kind: 'error',
              error: expect.objectContaining({ message: sentinelMessage }),
            }),
          }),
        }),
      );
      expect(observedConfig).toEqual({
        provider: 'openai-completions',
        model: 'gpt-test',
        maxTokens: 4_096,
      });
      const requests = (await store.read(pairId)).filter(
        (event) => event.type === 'pair.request_built',
      );
      expect(requests).toHaveLength(1);
      expect(
        (requests[0]?.payload as { snapshot: { requestConfigVersion: string } })
          .snapshot.requestConfigVersion,
      ).toBe(runtime.adapter.exportRequestMaterials().at(-1)?.requestConfigVersion);
      expect(runtime.adapter.exportRequestMaterials().at(-1)?.config).toEqual(observedConfig);
    } finally {
      disposeSentinel();
      try {
        await coordinator.close();
      } finally {
        await runtime.close();
      }
    }
  }, 60_000);

  test('rolls back a post-open prepare failure and retains a failed-dispose orphan for close retry', async () => {
    const pairId = 'pair-dsh-rollback-orphan';
    const pairRoot = await temporaryRoot('rollback-ledger');
    const sessionRoot = await temporaryRoot('rollback-sessions');
    let failRollbackDispose = true;
    const runtime = await createRuntime(pairId, pairRoot, sessionRoot, {
      lifecycleFaults: {
        afterAgentOpened() {
          throw new Error('fault after agent opened');
        },
        beforeDispose(reason) {
          if (reason === 'rollback' && failRollbackDispose) {
            failRollbackDispose = false;
            throw new Error('fault during rollback dispose');
          }
        },
      },
    });
    const ids = createPairSessionIds(pairId);
    await expect(
      runtime.adapter.preparePairAgent({
        pairId: pairId as never,
        role: 'navigator',
        sessionId: ids.navigatorSessionId,
      }),
    ).rejects.toThrow(/fault after agent opened/i);
    expect(runtime.adapter.ownedHandleCount()).toBe(0);
    expect(runtime.adapter.orphanHandleCount()).toBe(1);
    await runtime.adapter.close();
    expect(runtime.adapter.orphanHandleCount()).toBe(0);
  }, 30_000);

  test('keeps a release-failed handle owned so adapter close can retry disposal', async () => {
    const pairId = 'pair-dsh-release-retry';
    const pairRoot = await temporaryRoot('release-ledger');
    const sessionRoot = await temporaryRoot('release-sessions');
    let failRelease = true;
    const runtime = await createRuntime(pairId, pairRoot, sessionRoot, {
      lifecycleFaults: {
        beforeDispose(reason) {
          if (reason === 'release' && failRelease) {
            failRelease = false;
            throw new Error('fault during release dispose');
          }
        },
      },
    });
    const ids = createPairSessionIds(pairId);
    const prepared = await runtime.adapter.preparePairAgent({
      pairId: pairId as never,
      role: 'navigator',
      sessionId: ids.navigatorSessionId,
    });
    await expect(runtime.adapter.release(prepared.handle)).rejects.toThrow(
      /fault during release dispose/i,
    );
    expect(runtime.adapter.ownedHandleCount()).toBe(1);
    await runtime.adapter.close();
    expect(runtime.adapter.ownedHandleCount()).toBe(0);
  }, 30_000);

  test('keeps adapter ownership when close disposal fails and allows a successful close retry', async () => {
    const pairId = 'pair-dsh-close-retry';
    const pairRoot = await temporaryRoot('close-ledger');
    const sessionRoot = await temporaryRoot('close-sessions');
    let failClose = true;
    const runtime = await createRuntime(pairId, pairRoot, sessionRoot, {
      lifecycleFaults: {
        beforeDispose(reason) {
          if (reason === 'close' && failClose) {
            failClose = false;
            throw new Error('fault during close dispose');
          }
        },
      },
    });
    const ids = createPairSessionIds(pairId);
    await runtime.adapter.preparePairAgent({
      pairId: pairId as never,
      role: 'navigator',
      sessionId: ids.navigatorSessionId,
    });

    await expect(runtime.adapter.close()).rejects.toThrow(/could not dispose/i);
    expect(runtime.adapter.ownedHandleCount()).toBe(1);
    await expect(runtime.adapter.close()).resolves.toBeUndefined();
    expect(runtime.adapter.ownedHandleCount()).toBe(0);
  }, 30_000);

  test('persists distinct ordered snapshots for a transient Provider retry attempt', async () => {
    const pairId = 'pair-dsh-retry';
    const pairRoot = await temporaryRoot('retry-ledger');
    const sessionRoot = await temporaryRoot('retry-sessions');
    const runtime = await createRuntime(pairId, pairRoot, sessionRoot, {
      responses: [
        {
          failure: {
            message: 'capture provider temporarily unavailable',
            code: 'SERVICE_UNAVAILABLE',
          },
        },
        'Navigator recovered.',
      ],
      retryFailures: true,
    });
    const ids = createPairSessionIds(pairId);
    await runtime.coordinator.createPair({ pairId, dshBuild, expectedLedgerHead: 0 });
    const head = (await runtime.store.heads(pairId)).ledgerHead;
    await runtime.coordinator.sendNavigator({
      pairId,
      text: 'Retry this request once.',
      expectedLedgerHead: head,
    });
    await runtime.adapter.whenIdle(ids.navigatorSessionId);

    const captures = runtime.adapter.captureRequests();
    expect(captures).toHaveLength(2);
    expect(captures[0]?.fullRequestDigest).toBe(captures[1]?.fullRequestDigest);
    const snapshots = (await runtime.store.read(pairId)).filter(
      (event) => event.type === 'pair.request_built',
    );
    expect(
      snapshots.map((event) => ({
        seq: event.seq,
        requestId: (event.payload as { requestId: string }).requestId,
        attempt: (event.payload as { snapshot: { attempt: number } }).snapshot.attempt,
      })),
    ).toEqual([
      { seq: snapshots[0]?.seq, requestId: `${ids.navigatorSessionId}:1:1:1`, attempt: 1 },
      { seq: snapshots[1]?.seq, requestId: `${ids.navigatorSessionId}:1:1:2`, attempt: 2 },
    ]);
    expect(snapshots[0]!.seq).toBeLessThan(snapshots[1]!.seq);
    expect(captures.map((capture) => capture.snapshotLedgerSeq)).toEqual(
      snapshots.map((snapshot) => snapshot.seq),
    );
    await runtime.coordinator.close();
  }, 30_000);

  test('keeps a tool-call/result span closed on step 2 without repeating the Pair trigger', async () => {
    const pairId = 'pair-dsh-tool-step';
    const pairRoot = await temporaryRoot('tool-ledger');
    const sessionRoot = await temporaryRoot('tool-sessions');
    const runtime = await createRuntime(pairId, pairRoot, sessionRoot, {
      responses: [
        {
          toolCall: {
            id: 'call-echo-1',
            name: 'echo',
            arguments: { text: 'hello' },
          },
        },
        'Tool completed.',
      ],
      echoTool: true,
      maxTokens: 321,
    });
    const ids = createPairSessionIds(pairId);
    await runtime.coordinator.createPair({ pairId, dshBuild, expectedLedgerHead: 0 });
    const head = (await runtime.store.heads(pairId)).ledgerHead;
    await runtime.coordinator.sendNavigator({
      pairId,
      text: 'Use the echo tool.',
      expectedLedgerHead: head,
    });
    await runtime.adapter.whenIdle(ids.navigatorSessionId);

    const requests = runtime.adapter.captureRequests();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools).toEqual([
      expect.objectContaining({ name: 'echo' }),
    ]);
    expect(JSON.stringify(requests[0]?.messages)).toContain('<pair-trigger');
    expect(JSON.stringify(requests[1]?.messages)).not.toContain('<pair-trigger');
    const second = requests[1]!.messages;
    const toolCallIndex = second.findIndex((message) =>
      message.content.some((block) => block.type === 'tool-call'),
    );
    const toolResultIndex = second.findIndex((message) =>
      message.content.some((block) => block.type === 'tool-result'),
    );
    expect(toolCallIndex).toBeGreaterThan(0);
    expect(toolResultIndex).toBeGreaterThan(toolCallIndex);

    const snapshots = (await runtime.store.read(pairId)).filter(
      (event) => event.type === 'pair.request_built',
    );
    expect(
      snapshots.map((event) =>
        (event.payload as { snapshot: { step: number } }).snapshot.step,
      ),
    ).toEqual([1, 2]);
    expect(snapshots.every((event) => !('materials' in event.payload))).toBe(true);
    expect(
      (snapshots[1]!.payload as { snapshot: { toolsDigest: string; configDigest: string } })
        .snapshot,
    ).toMatchObject({ toolsDigest: expect.stringMatching(/^sha256:/), configDigest: expect.stringMatching(/^sha256:/) });
    const configSnapshots = snapshots.map(
      (event) =>
        (event.payload as {
          snapshot: { requestConfigVersion: string; configDigest: string };
        }).snapshot,
    );
    expect(new Set(configSnapshots.map(({ requestConfigVersion }) => requestConfigVersion)).size)
      .toBe(1);
    expect(configSnapshots[0]?.requestConfigVersion).toBe(
      `pair-config/v1:${configSnapshots[0]?.configDigest}`,
    );
    const historical = snapshots.map((event) => ({
      requestId: (event.payload as { requestId: string }).requestId,
      digest: (event.payload as { snapshot: { fullRequestDigest: string } })
        .snapshot.fullRequestDigest,
    }));
    const historicalRequestMaterials = runtime.adapter.exportRequestMaterials();
    await runtime.coordinator.close();

    const resumed = await createRuntime(pairId, pairRoot, sessionRoot, {
      maxTokens: 999,
      historicalRequestMaterials,
    });
    const currentConfigEntry = resumed.adapter
      .exportRequestMaterials()
      .find((entry) => entry.config.maxTokens === 999);
    expect(currentConfigEntry?.requestConfigVersion).not.toBe(
      configSnapshots[0]?.requestConfigVersion,
    );
    await resumed.registry.recoverPair(pairId);
    for (const request of historical) {
      await expect(resumed.adapter.rebuildRequestDigest(request.requestId))
        .resolves.toBe(request.digest);
    }
    await resumed.coordinator.close();
  }, 30_000);

  test('runs Navigator then Pilot through real DSH loops and persists auditable requests before Provider calls', async () => {
    const pairId = 'pair-dsh-vertical';
    const pairRoot = await temporaryRoot('ledger');
    const sessionRoot = await temporaryRoot('sessions');
    const runtime = await createRuntime(pairId, pairRoot, sessionRoot);
    const ids = createPairSessionIds(pairId);

    const created = await runtime.coordinator.createPair({
      pairId,
      dshBuild,
      expectedLedgerHead: 0,
    });
    expect(created.status).toBe('ready');
    expect(created.status === 'ready' && created.panes.map((pane) => pane.sessionId))
      .toEqual([ids.navigatorSessionId, ids.pilotSessionId]);

    const navigatorHead = (await runtime.store.heads(pairId)).ledgerHead;
    await runtime.coordinator.sendNavigator({
      pairId,
      text: 'Explore the requested implementation.',
      expectedLedgerHead: navigatorHead,
    });
    await runtime.adapter.whenIdle(ids.navigatorSessionId);

    const taskHead = (await runtime.store.heads(pairId)).ledgerHead;
    await runtime.coordinator.assignTask({
      pairId,
      expectedLedgerHead: taskHead,
      task: {
        id: 'task-1',
        revision: 1,
        summary: 'Implement the vertical slice.',
        state: 'queued',
      },
    });
    await runtime.adapter.whenIdle(ids.pilotSessionId);

    const requests = runtime.adapter.captureRequests();
    expect(requests).toHaveLength(2);
    const [navigatorRequest, pilotRequest] = requests;
    expect(navigatorRequest).toMatchObject({
      provider: 'openai-completions',
      model: 'capture-model',
      sessionId: ids.navigatorSessionId,
      system: commonSystem.content,
    });
    expect(pilotRequest).toMatchObject({
      provider: 'openai-completions',
      model: 'capture-model',
      sessionId: ids.pilotSessionId,
      system: commonSystem.content,
    });
    expect(navigatorRequest?.system).toBe(pilotRequest?.system);
    expect(navigatorRequest?.messages[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('<pair-session-events') }),
      ]),
    );
    expect(pilotRequest?.messages[0]?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('<pair-session-events') }),
      ]),
    );
    expect(JSON.stringify(navigatorRequest?.messages[2])).toContain(
      '<active-role>navigator</active-role>',
    );
    expect(JSON.stringify(navigatorRequest?.messages[2])).toContain(
      'Clarify and govern the Pair goal',
    );
    expect(JSON.stringify(pilotRequest?.messages[2])).toContain(
      '<active-role>pilot</active-role>',
    );
    expect(JSON.stringify(pilotRequest?.messages[2])).toContain(
      'Execute the delegated task',
    );
    expect(navigatorRequest?.messages[3]?.content[0]?.text).toContain(
      '<pair-local-bootstrap role="navigator">',
    );
    expect(pilotRequest?.messages[3]?.content[0]?.text).toContain(
      '<pair-local-bootstrap role="pilot">',
    );
    expect(JSON.stringify(navigatorRequest)).not.toContain('previous_response_id');
    expect(JSON.stringify(pilotRequest)).not.toContain('previous_response_id');

    const pairEvents = await runtime.store.read(pairId);
    const snapshots = pairEvents.filter((event) => event.type === 'pair.request_built');
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((event) => event.visibility === 'infrastructure')).toBe(true);
    expect(snapshots.map((event) => event.payload)).toEqual(
      requests.map((request) =>
        expect.objectContaining({
          requestId: expect.any(String),
          snapshot: expect.objectContaining({
            sessionId: request.sessionId,
            fullRequestDigest: request.fullRequestDigest,
          }),
        }),
      ),
    );
    expect(snapshots.every((event) => !('materials' in event.payload))).toBe(true);
    expect(requests.every((request) => request.snapshotLedgerSeq <= request.providerStartedAtLedgerHead))
      .toBe(true);

    const navigatorArtifact = runtime.adapter.sessionArtifact(ids.navigatorSessionId);
    const pilotArtifact = runtime.adapter.sessionArtifact(ids.pilotSessionId);
    expect(navigatorArtifact).toMatchObject({ compression: 'none', packChunks: false });
    expect(pilotArtifact).toMatchObject({ compression: 'none', packChunks: false });
    const [navigatorJsonl, pilotJsonl] = await Promise.all([
      readFile(navigatorArtifact.path, 'utf8'),
      readFile(pilotArtifact.path, 'utf8'),
    ]);
    expect(navigatorJsonl).toContain('Explore the requested implementation.');
    expect(navigatorJsonl).not.toContain('Implement the vertical slice.');
    expect(pilotJsonl).toContain('Implement the vertical slice.');
    expect(pilotJsonl).not.toContain('Explore the requested implementation.');

    const historicalDigests = snapshots.map(
      (event) => (event.payload as { snapshot: { fullRequestDigest: string } }).snapshot.fullRequestDigest,
    );
    for (const event of snapshots) {
      const payload = event.payload as {
        requestId: string;
        snapshot: { fullRequestDigest: string };
      };
      await expect(runtime.adapter.rebuildRequestDigest(payload.requestId))
        .resolves.toBe(payload.snapshot.fullRequestDigest);
    }
    const historicalRequestMaterials = runtime.adapter.exportRequestMaterials();
    await runtime.coordinator.close();

    const resumed = await createRuntime(pairId, pairRoot, sessionRoot, {
      model: 'capture-model-v2',
      historicalRequestMaterials,
      commonSystem: {
        version: 'pair-prompt/v2',
        content: `${commonSystem.content}\nThe current prompt revision adds no retroactive semantics.`,
      },
    });
    const recovered = await resumed.registry.recoverPair(pairId);
    expect(recovered.projection.header).toEqual(
      expect.objectContaining({
        pairId,
        navigatorSessionId: ids.navigatorSessionId,
        pilotSessionId: ids.pilotSessionId,
      }),
    );
    expect(resumed.adapter.sessionEvents(ids.navigatorSessionId)).not.toEqual(
      resumed.adapter.sessionEvents(ids.pilotSessionId),
    );
    expect(
      (await resumed.store.read(pairId))
        .filter((event) => event.type === 'pair.request_built')
        .map((event) =>
          (event.payload as { snapshot: { fullRequestDigest: string } }).snapshot.fullRequestDigest,
        ),
    ).toEqual(historicalDigests);
    const resumedSnapshots = (await resumed.store.read(pairId)).filter(
      (event) => event.type === 'pair.request_built',
    );
    for (const event of resumedSnapshots) {
      const payload = event.payload as {
        requestId: string;
        snapshot: { fullRequestDigest: string };
      };
      await expect(resumed.adapter.rebuildRequestDigest(payload.requestId))
        .resolves.toBe(payload.snapshot.fullRequestDigest);
    }
    await resumed.coordinator.close();
  }, 30_000);

  test('serializes concurrent role snapshots with CAS while keeping the shared prefix identical', async () => {
    const pairId = 'pair-dsh-concurrent';
    const pairRoot = await temporaryRoot('concurrent-ledger');
    const sessionRoot = await temporaryRoot('concurrent-sessions');
    const runtime = await createRuntime(pairId, pairRoot, sessionRoot);
    const ids = createPairSessionIds(pairId);
    await runtime.coordinator.createPair({ pairId, dshBuild, expectedLedgerHead: 0 });

    const navigatorEvent = await runtime.store.append(
      pairId,
      {
        type: 'user.message',
        actor: { kind: 'user' },
        source: 'pair',
        channel: 'navigator',
        visibility: 'shared',
        authority: 'user',
        refs: {},
        payload: { text: 'Navigator concurrent input' },
      },
      2,
    );
    const pilotEvent = await runtime.store.append(
      pairId,
      {
        type: 'user.message',
        actor: { kind: 'user' },
        source: 'pair',
        channel: 'pilot',
        visibility: 'shared',
        authority: 'user',
        refs: {},
        payload: { text: 'Pilot concurrent input' },
      },
      navigatorEvent.seq,
    );
    const navigatorFollowup = {
      sessionId: ids.navigatorSessionId,
      deliveryId: `${pairId}:${navigatorEvent.seq}`,
      trigger: {
        kind: 'user.message',
        role: 'navigator',
        text: 'Navigator concurrent input',
        pairEventId: `${pairId}:${navigatorEvent.seq}`,
      },
    } as const;
    const pilotFollowup = {
      sessionId: ids.pilotSessionId,
      deliveryId: `${pairId}:${pilotEvent.seq}`,
      trigger: {
        kind: 'user.message',
        role: 'pilot',
        text: 'Pilot concurrent input',
        pairEventId: `${pairId}:${pilotEvent.seq}`,
      },
    } as const;

    await Promise.all([
      runtime.adapter.followup(navigatorFollowup),
      runtime.adapter.followup(navigatorFollowup),
      runtime.adapter.followup(pilotFollowup),
    ]);
    await Promise.all([
      runtime.adapter.whenIdle(ids.navigatorSessionId),
      runtime.adapter.whenIdle(ids.pilotSessionId),
    ]);

    const requests = [...runtime.adapter.captureRequests()].sort((a, b) =>
      a.sessionId.localeCompare(b.sessionId),
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]?.system).toBe(requests[1]?.system);
    expect(requests[0]?.messages.slice(0, 2)).toEqual(
      requests[1]?.messages.slice(0, 2),
    );
    expect(requests[0]?.messages[2]).not.toEqual(requests[1]?.messages[2]);

    const events = await runtime.store.read(pairId);
    const snapshots = events.filter((event) => event.type === 'pair.request_built');
    expect(snapshots).toHaveLength(2);
    expect(new Set(snapshots.map((event) => event.seq)).size).toBe(2);
    expect(
      snapshots.map((event) =>
        (event.payload as { snapshot: { sharedHead: number } }).snapshot.sharedHead,
      ),
    ).toEqual([pilotEvent.seq, pilotEvent.seq]);
    expect((await runtime.coordinator.getPair(pairId)).projection.header.ledgerHead)
      .toBe(events.at(-1)?.seq);
    await runtime.coordinator.close();
  }, 30_000);

  test('fails closed on unknown session bindings and corrupted persisted sessions', async () => {
    const pairId = 'pair-dsh-corrupt';
    const pairRoot = await temporaryRoot('corrupt-ledger');
    const sessionRoot = await temporaryRoot('corrupt-sessions');
    const first = await createRuntime(pairId, pairRoot, sessionRoot);
    await first.coordinator.createPair({ pairId, dshBuild, expectedLedgerHead: 0 });
    const ids = createPairSessionIds(pairId);
    const head = (await first.store.heads(pairId)).ledgerHead;
    await first.coordinator.sendNavigator({ pairId, text: 'materialize', expectedLedgerHead: head });
    await first.adapter.whenIdle(ids.navigatorSessionId);
    const artifact = first.adapter.sessionArtifact(ids.navigatorSessionId);
    await first.coordinator.close();

    const second = await createRuntime(pairId, pairRoot, sessionRoot);
    await expect(
      second.adapter.resumePairAgent({
        pairId: pairId as never,
        role: 'navigator',
        sessionId: ids.pilotSessionId,
      }),
    ).rejects.toThrow(/session.*navigator/i);
    await writeFile(artifact.path, '{not-json}\n');
    await expect(second.registry.recoverPair(pairId)).rejects.toThrow(/corrupt|header|json/i);
    await second.coordinator.close();
  }, 30_000);

  test('fails closed when a deterministic Pair Session artifact is missing', async () => {
    const pairId = 'pair-dsh-missing';
    const pairRoot = await temporaryRoot('missing-ledger');
    const sessionRoot = await temporaryRoot('missing-sessions');
    const first = await createRuntime(pairId, pairRoot, sessionRoot);
    await first.coordinator.createPair({ pairId, dshBuild, expectedLedgerHead: 0 });
    const ids = createPairSessionIds(pairId);
    const missingArtifact = first.adapter.sessionArtifact(ids.pilotSessionId);
    await first.coordinator.close();
    await rm(missingArtifact.path);

    const resumed = await createRuntime(pairId, pairRoot, sessionRoot);
    await expect(resumed.registry.recoverPair(pairId)).rejects.toThrow(
      /not found|missing|session/i,
    );
    await resumed.coordinator.close();
  }, 30_000);

  test('fails recovery when a historical request material version is absent', async () => {
    const pairId = 'pair-dsh-missing-material-version';
    const pairRoot = await temporaryRoot('missing-material-version-ledger');
    const sessionRoot = await temporaryRoot('missing-material-version-sessions');
    const first = await createRuntime(pairId, pairRoot, sessionRoot, {
      maxTokens: 128,
    });
    const ids = createPairSessionIds(pairId);
    await first.coordinator.createPair({ pairId, dshBuild, expectedLedgerHead: 0 });
    const head = (await first.store.heads(pairId)).ledgerHead;
    await first.coordinator.sendNavigator({
      pairId,
      text: 'Create one auditable request.',
      expectedLedgerHead: head,
    });
    await first.adapter.whenIdle(ids.navigatorSessionId);
    await first.coordinator.close();

    const resumed = await createRuntime(pairId, pairRoot, sessionRoot, {
      maxTokens: 256,
    });
    await expect(resumed.registry.recoverPair(pairId)).rejects.toThrow(
      /no immutable request materials/i,
    );
    await resumed.coordinator.close();
  }, 30_000);

  test('fails Pair recovery before ready when a request snapshot targets an unknown Session', async () => {
    const pairId = 'pair-dsh-unknown-request-session';
    const pairRoot = await temporaryRoot('unknown-request-ledger');
    const sessionRoot = await temporaryRoot('unknown-request-sessions');
    const first = await createRuntime(pairId, pairRoot, sessionRoot);
    await first.coordinator.createPair({ pairId, dshBuild, expectedLedgerHead: 0 });
    await first.coordinator.close();
    const head = (await first.store.heads(pairId)).ledgerHead;
    const sessionId = 'pair:another-pair:navigator';
    const requestId = `${sessionId}:1:1:1`;
    await first.store.append(
      pairId,
      {
        type: 'pair.request_built',
        actor: { kind: 'host' },
        source: 'pair',
        channel: 'shared-control',
        visibility: 'infrastructure',
        authority: 'host',
        refs: {},
        payload: {
          requestId,
          snapshot: {
            requestId,
            sessionId,
            role: 'navigator',
            turn: 1,
            step: 1,
            attempt: 1,
            fullRequestDigest: `sha256:${'a'.repeat(64)}`,
          },
          manifest: {},
        },
      },
      head,
    );

    const resumed = await createRuntime(pairId, pairRoot, sessionRoot);
    await expect(resumed.registry.recoverPair(pairId)).rejects.toThrow(
      /authoritative coordinates/i,
    );
    expect(resumed.adapter.ownedHandleCount()).toBe(0);
    await resumed.coordinator.close();
  }, 30_000);

  test('fails recovery when the durable DSH local-history boundary no longer matches its snapshot', async () => {
    const pairId = 'pair-dsh-boundary-mismatch';
    const pairRoot = await temporaryRoot('boundary-ledger');
    const sessionRoot = await temporaryRoot('boundary-sessions');
    const first = await createRuntime(pairId, pairRoot, sessionRoot);
    const ids = createPairSessionIds(pairId);
    await first.coordinator.createPair({ pairId, dshBuild, expectedLedgerHead: 0 });
    const head = (await first.store.heads(pairId)).ledgerHead;
    await first.coordinator.sendNavigator({
      pairId,
      text: 'Build a boundary snapshot.',
      expectedLedgerHead: head,
    });
    await first.adapter.whenIdle(ids.navigatorSessionId);
    const artifact = first.adapter.sessionArtifact(ids.navigatorSessionId);
    const historicalRequestMaterials = first.adapter.exportRequestMaterials();
    await first.coordinator.close();

    const rows = (await readFile(artifact.path, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const bootstrap = rows.find(
      (row) => row.type === 'user/message' && JSON.stringify(row).includes('pair-local-bootstrap'),
    );
    expect(bootstrap).toBeDefined();
    const data = bootstrap!.data as { content: Array<{ type: string; text: string }> };
    data.content[0]!.text = '<pair-local-bootstrap>tampered but valid JSON</pair-local-bootstrap>';
    await writeFile(artifact.path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    const resumed = await createRuntime(pairId, pairRoot, sessionRoot, {
      model: 'capture-model-v2',
      historicalRequestMaterials,
    });
    await expect(resumed.registry.recoverPair(pairId)).rejects.toThrow(
      /historical reconstruction audit/i,
    );
    await resumed.coordinator.close();
  }, 30_000);
});
