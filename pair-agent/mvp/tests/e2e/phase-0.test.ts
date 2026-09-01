import { createRequire } from 'node:module';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPairSessionIds } from '../../packages/contracts/src/index.js';
import { JsonlPairLedgerStore } from '../../packages/ledger/src/index.js';
import {
  DshPairAgentAdapter,
  launchDshPairWebRuntime,
  PairCoordinator,
  PeerMessageRouter,
  PeerMessageService,
  PairRegistry,
} from '../../packages/runtime/src/index.js';
import { createPairHostServer } from '../../apps/pair-host/src/server.js';
import { afterEach, describe, expect, test } from 'vitest';
import { closeBestEffort, pairWebRuntimeDefines } from '../../scripts/runtime-utils.js';

const roots: string[] = [];
const mvpRoot = resolve(import.meta.dirname, '../..');
const dshRoot = join(mvpRoot, '.runtime/deepseek-harness');
const dshLockPath = join(mvpRoot, 'dsh.lock.json');
const commonSystem = {
  version: 'pair-prompt/v1',
  content: 'Pair common system.',
};

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `pair-phase0-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Pair Agent Phase 0 live DSH Web composition', () => {
  test.each([
    ['adapter', 'beforeDispose'],
    ['context', 'beforeHostedContextDispose'],
  ] as const)(
    'retries only the failed %s side of hosted runtime cleanup',
    async (_label, failurePoint) => {
      const dataRoot = await tempRoot(`close-${failurePoint}`);
      let adapterAttempts = 0;
      let contextAttempts = 0;
      const runtime = await launchDshPairWebRuntime({
        source: { derivedRoot: dshRoot, lockPath: dshLockPath },
        dataRoot,
        store: new JsonlPairLedgerStore(join(dataRoot, 'pairs')),
        commonSystem,
        provider: 'openai-completions',
        model: 'capture-model',
        capture: { responses: [] },
        lifecycleFaults: {
          beforeDispose(reason: 'rollback' | 'release' | 'close') {
            if (reason !== 'close') return;
            adapterAttempts += 1;
            if (failurePoint === 'beforeDispose' && adapterAttempts === 1) {
              throw new Error('injected adapter close failure');
            }
          },
          beforeHostedContextDispose() {
            contextAttempts += 1;
            if (failurePoint === 'beforeHostedContextDispose' && contextAttempts === 1) {
              throw new Error('injected context close failure');
            }
          },
        } as never,
        web: { host: '127.0.0.1', port: 0 },
      });
      const registry = new PairRegistry(
        new JsonlPairLedgerStore(join(dataRoot, 'pairs')),
        runtime.adapter,
      );
      const coordinator = new PairCoordinator(
        registry,
        new JsonlPairLedgerStore(join(dataRoot, 'pairs')),
        runtime.adapter,
      );
      await coordinator.createPair({
        pairId: `pair-close-${failurePoint}`,
        dshBuild: runtime.adapter.getDshRuntimeAttestation().dshBuild,
        expectedLedgerHead: 0,
      });

      try {
        await expect(runtime.close()).rejects.toThrow(/hosted DSH runtime cleanup/i);
        await expect(runtime.close()).resolves.toBeUndefined();
        await expect(runtime.close()).resolves.toBeUndefined();
        // Two Pair handles close on the first attempt; an injected failure leaves
        // exactly one handle for the retry. A context-only retry never re-closes them.
        expect(adapterAttempts).toBe(failurePoint === 'beforeDispose' ? 3 : 2);
        expect(contextAttempts).toBe(failurePoint === 'beforeHostedContextDispose' ? 2 : 1);
      } finally {
        await runtime.adapter.close().catch(() => undefined);
        await runtime.context.fiber.dispose().catch(() => undefined);
      }
    },
    60_000,
  );

  test('settles the adapter close attempt before disposing the hosted Context', async () => {
    const dataRoot = await tempRoot('close-order');
    const store = new JsonlPairLedgerStore(join(dataRoot, 'pairs'));
    let announceAdapter!: () => void;
    let releaseAdapter!: () => void;
    let contextAttempts = 0;
    const adapterEntered = new Promise<void>((resolveEntered) => {
      announceAdapter = resolveEntered;
    });
    const adapterGate = new Promise<void>((resolveGate) => {
      releaseAdapter = resolveGate;
    });
    const runtime = await launchDshPairWebRuntime({
      source: { derivedRoot: dshRoot, lockPath: dshLockPath },
      dataRoot,
      store,
      commonSystem,
      provider: 'openai-completions',
      model: 'capture-model',
      capture: { responses: [] },
      lifecycleFaults: {
        async beforeDispose(reason: 'rollback' | 'release' | 'close') {
          if (reason !== 'close') return;
          announceAdapter();
          await adapterGate;
        },
        beforeHostedContextDispose() {
          contextAttempts += 1;
        },
      } as never,
      web: { host: '127.0.0.1', port: 0 },
    });
    const registry = new PairRegistry(store, runtime.adapter);
    const coordinator = new PairCoordinator(registry, store, runtime.adapter);
    await coordinator.createPair({
      pairId: 'pair-close-order',
      dshBuild: runtime.adapter.getDshRuntimeAttestation().dshBuild,
      expectedLedgerHead: 0,
    });
    const closing = runtime.close();
    try {
      await adapterEntered;
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
      expect(contextAttempts).toBe(0);
    } finally {
      releaseAdapter();
      await closing.catch(() => undefined);
      await runtime.adapter.close().catch(() => undefined);
      await runtime.context.fiber.dispose().catch(() => undefined);
    }
    await expect(closing).resolves.toBeUndefined();
    expect(contextAttempts).toBe(1);
  }, 60_000);

  test('fails closed when the hosted DSH catalog contributes an unexpected global tool', async () => {
    const dataRoot = await tempRoot('unexpected-tool');
    let unexpectedRuntime: Awaited<ReturnType<typeof launchDshPairWebRuntime>> | undefined;
    const outcome = await launchDshPairWebRuntime({
      source: { derivedRoot: dshRoot, lockPath: dshLockPath },
      dataRoot,
      store: new JsonlPairLedgerStore(join(dataRoot, 'pairs')),
      commonSystem,
      provider: 'openai-completions',
      model: 'capture-model',
      capture: { responses: [] },
      tools: [{
        name: 'phase0_echo',
        description: 'Expected tool.',
        parameters: { text: { type: 'string' } },
        async execute() { return []; },
      }],
      lifecycleFaults: {
        hostedExtraTool: {
          name: 'future_global_tool',
          description: 'Simulates a future DSH global tool.',
          parameters: { input: { type: 'string' } },
          async execute() { return []; },
        },
      } as never,
      web: { host: '127.0.0.1', port: 0 },
    }).then(
      (runtime) => {
        unexpectedRuntime = runtime;
        return { error: undefined };
      },
      (error: unknown) => ({ error }),
    );
    try {
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toMatch(/tool catalog.*exact|unexpected.*tool/i);
    } finally {
      await unexpectedRuntime?.close().catch(() => undefined);
    }
  }, 60_000);

  test('serializes DSH_HOME boot sections across concurrent hosted data roots', async () => {
    const firstRoot = await tempRoot('home-first');
    const secondRoot = await tempRoot('home-second');
    const canonicalFirstRoot = await realpath(firstRoot);
    const canonicalSecondRoot = await realpath(secondRoot);
    const original = process.env.DSH_HOME;
    process.env.DSH_HOME = '/phase0/sentinel-home';
    let firstEntered!: () => void;
    let releaseFirst!: () => void;
    let secondEntered = false;
    const entered = new Promise<void>((resolveEntered) => { firstEntered = resolveEntered; });
    const gate = new Promise<void>((resolveGate) => { releaseFirst = resolveGate; });
    let firstRuntime: Awaited<ReturnType<typeof launchDshPairWebRuntime>> | undefined;
    let secondRuntime: Awaited<ReturnType<typeof launchDshPairWebRuntime>> | undefined;
    try {
      const firstLaunch = launchDshPairWebRuntime({
        source: { derivedRoot: dshRoot, lockPath: dshLockPath },
        dataRoot: firstRoot,
        store: new JsonlPairLedgerStore(join(firstRoot, 'pairs')),
        commonSystem,
        provider: 'openai-completions',
        model: 'capture-model',
        capture: { responses: [] },
        lifecycleFaults: {
          async afterHostedHomeSet(home: string) {
            expect(home).toBe(join(canonicalFirstRoot, 'dsh-home'));
            expect(process.env.DSH_HOME).toBe(home);
            firstEntered();
            await gate;
            expect(process.env.DSH_HOME).toBe(home);
          },
        } as never,
        web: { host: '127.0.0.1', port: 0 },
      }).then((runtime) => {
        firstRuntime = runtime;
        return runtime;
      });
      await Promise.race([
        entered,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('first DSH_HOME section was not entered')), 2_000)),
      ]);
      const secondLaunch = launchDshPairWebRuntime({
        source: { derivedRoot: dshRoot, lockPath: dshLockPath },
        dataRoot: secondRoot,
        store: new JsonlPairLedgerStore(join(secondRoot, 'pairs')),
        commonSystem,
        provider: 'openai-completions',
        model: 'capture-model',
        capture: { responses: [] },
        lifecycleFaults: {
          afterHostedHomeSet(home: string) {
            secondEntered = true;
            expect(home).toBe(join(canonicalSecondRoot, 'dsh-home'));
            expect(process.env.DSH_HOME).toBe(home);
          },
        } as never,
        web: { host: '127.0.0.1', port: 0 },
      }).then((runtime) => {
        secondRuntime = runtime;
        return runtime;
      });
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
      expect(secondEntered).toBe(false);
      expect(process.env.DSH_HOME).toBe(join(canonicalFirstRoot, 'dsh-home'));
      releaseFirst();
      [firstRuntime, secondRuntime] = await Promise.all([firstLaunch, secondLaunch]);
      expect(secondEntered).toBe(true);
      expect(firstRuntime.paths.harnessHome).toBe(join(canonicalFirstRoot, 'dsh-home'));
      expect(secondRuntime.paths.harnessHome).toBe(join(canonicalSecondRoot, 'dsh-home'));
      expect(process.env.DSH_HOME).toBe('/phase0/sentinel-home');
    } finally {
      releaseFirst?.();
      await Promise.allSettled([
        firstRuntime?.close(),
        secondRuntime?.close(),
      ]);
      if (original === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME');
      else process.env.DSH_HOME = original;
    }
  }, 90_000);

  test('mounts the native DSH Host API on the exact Context used by the Pair adapter', async () => {
    const dataRoot = await tempRoot('same-context');
    const pairRoot = join(dataRoot, 'pairs');
    const runtime = await launchDshPairWebRuntime({
      source: {
        derivedRoot: dshRoot,
        lockPath: dshLockPath,
      },
      dataRoot,
      store: new JsonlPairLedgerStore(pairRoot),
      commonSystem,
      provider: 'openai-completions',
      model: 'capture-model',
      capture: { responses: [] },
      web: { host: '127.0.0.1', port: 0 },
    });
    try {
      expect(runtime.adapter).toBeInstanceOf(DshPairAgentAdapter);
      expect(runtime.adapter.context).toBe(runtime.context);
      expect(runtime.context.get('sandboxPolicy')).toMatchObject({
        defaultMode: 'read-only',
        workspaceRoot: runtime.paths.dataRoot,
      });
      expect(runtime.context.get('fs')).toMatchObject({
        config: { cwd: runtime.paths.dataRoot },
      });
      expect(runtime.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(runtime.origin);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('__DSH_BOOT__');

      await runtime.adapter.close();
      expect(await fetch(runtime.origin)).toMatchObject({ status: 200 });
    } finally {
      await runtime.close();
    }
    await expect(fetch(runtime.origin)).rejects.toThrow();
  }, 60_000);

  test('runs the dual-Agent flow, proves live native panes, and resumes all durable identities', async () => {
    const dataRoot = await tempRoot('vertical');
    const pairRoot = join(dataRoot, 'pairs');
    const pairId = 'pair-phase0-e2e';
    const ids = createPairSessionIds(pairId);
    let releasePilot!: () => void;
    let announcePilotTool!: () => void;
    const pilotGate = new Promise<void>((resolveGate) => {
      releasePilot = resolveGate;
    });
    const pilotToolStarted = new Promise<void>((resolveStarted) => {
      announcePilotTool = resolveStarted;
    });
    const store = new JsonlPairLedgerStore(pairRoot);
    const peerRouter = new PeerMessageRouter();
    let registry!: PairRegistry;
    const runtime = await launchDshPairWebRuntime({
      source: { derivedRoot: dshRoot, lockPath: dshLockPath },
      dataRoot,
      store,
      commonSystem,
      provider: 'openai-completions',
      model: 'capture-model',
      capture: {
        responses: [
          'Navigator acknowledged the initial request.',
          {
            toolCall: {
              id: 'call-phase0-echo',
              name: 'phase0_echo',
              arguments: { text: 'pilot harmless work' },
            },
          },
          'Navigator stayed responsive while Pilot was working.',
          'Pilot completed the harmless work.',
        ],
      },
      tools: [
        peerRouter.toolDefinition(),
        {
          name: 'phase0_echo',
          description: 'A deterministic harmless Phase 0 echo tool.',
          parameters: { text: { type: 'string' } },
          async execute(args) {
            announcePilotTool();
            await pilotGate;
            return [{ type: 'text', text: `echo: ${String(args.text)}` }];
          },
        },
      ],
      onLedgerAdvanced: async (advancedPairId) => {
        await registry.publish(advancedPairId);
      },
      web: { host: '127.0.0.1', port: 0 },
    });
    registry = new PairRegistry(store, runtime.adapter);
    const coordinator = new PairCoordinator(registry, store, runtime.adapter);
    peerRouter.bind(new PeerMessageService(coordinator, runtime.adapter));
    const attestation = runtime.adapter.getDshRuntimeAttestation();
    let pairHost: ReturnType<typeof createPairHostServer> | undefined;
    let viteServer:
      | {
          listen(): Promise<void>;
          close(): Promise<void>;
          resolvedUrls?: { local: string[] };
        }
      | undefined;
    let browser: { close(): Promise<void> } | undefined;
    let headerBeforeRestart: unknown;
    let digestsBeforeRestart: string[] = [];
    try {
      const created = await coordinator.createPair({
        pairId,
        dshBuild: attestation.dshBuild,
        expectedLedgerHead: 0,
      });
      expect(created.status).toBe('ready');
      expect(created.status === 'ready' ? created.panes.map((pane) => pane.sessionId) : [])
        .toEqual([ids.navigatorSessionId, ids.pilotSessionId]);

      await coordinator.sendNavigator({
        pairId,
        text: 'Please prepare the Phase 0 demonstration.',
        expectedLedgerHead: (await store.heads(pairId)).ledgerHead,
      });
      await runtime.adapter.whenIdle(ids.navigatorSessionId);
      await coordinator.assignTask({
        pairId,
        expectedLedgerHead: (await store.heads(pairId)).ledgerHead,
        task: {
          id: 'phase0-task',
          revision: 1,
          summary: 'Run one harmless Pilot echo tool.',
          state: 'queued',
        },
      });
      await pilotToolStarted;

      await coordinator.sendNavigator({
        pairId,
        text: 'While Pilot is blocked, please confirm you can still respond.',
        expectedLedgerHead: (await store.heads(pairId)).ledgerHead,
      });
      await runtime.adapter.whenIdle(ids.navigatorSessionId);
      expect(runtime.adapter.captureRequests().filter((request) => request.sessionId === ids.navigatorSessionId))
        .toHaveLength(2);
      releasePilot();
      await runtime.adapter.whenIdle(ids.pilotSessionId);

      const subagentCatalogResponse = await fetch(`${runtime.origin}/api/subagent.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'phase0-subagent-catalog',
          method: 'subagent.list',
          payload: { parentSessionId: ids.pilotSessionId },
        }),
      });
      expect(subagentCatalogResponse.status).toBe(200);
      expect(await subagentCatalogResponse.json()).toMatchObject({
        result: {
          ok: true,
          value: { entries: [], parentAvailable: true },
        },
      });

      pairHost = createPairHostServer({
        registry,
        coordinator,
        dshBuild: attestation.dshBuild,
        host: '127.0.0.1',
        port: 0,
      });
      const pairAddress = await pairHost.listen();
      const requireFromPairWeb = createRequire(join(mvpRoot, 'apps/pair-web/package.json'));
      const viteEntry = requireFromPairWeb.resolve('vite');
      const vite = (await import(pathToFileURL(viteEntry).href)) as {
        createServer(config: unknown): Promise<{
          listen(): Promise<void>;
          close(): Promise<void>;
          resolvedUrls?: { local: string[] };
        }>;
      };
      viteServer = await vite.createServer({
        root: join(mvpRoot, 'apps/pair-web'),
        define: pairWebRuntimeDefines(runtime.origin),
        server: {
          host: '127.0.0.1',
          port: 0,
          strictPort: true,
          proxy: { '/api': { target: pairAddress.origin } },
        },
      });
      await viteServer.listen();
      const shellOrigin = viteServer.resolvedUrls?.local[0]?.replace(/\/$/, '');
      if (shellOrigin === undefined) throw new Error('Pair Web Vite server exposed no local URL');

      const requireFromDshWeb = createRequire(join(dshRoot, 'apps/web/package.json'));
      const playwrightEntry = requireFromDshWeb.resolve('playwright');
      const playwright = (await import(pathToFileURL(playwrightEntry).href)) as {
        chromium: { launch(): Promise<any> };
      };
      browser = await playwright.chromium.launch();
      const page = await (browser as any).newPage({
        locale: 'en-US',
        viewport: { width: 1680, height: 1000 },
      });
      const historyTargets: string[] = [];
      page.on('request', (request: any) => {
        const url = new URL(request.url());
        if (url.pathname !== '/api/session.history') return;
        const payload = request.postDataJSON()?.payload;
        if (typeof payload?.sessionId === 'string') historyTargets.push(payload.sessionId);
      });
      await page.goto(`${shellOrigin}/pair.html?pairId=${pairId}`, { waitUntil: 'load' });
      await expect.poll(
        () => page.locator('body').innerText(),
        { timeout: 30_000 },
      ).toContain('Run one harmless Pilot echo tool.');
      const navigatorFrame = page.frameLocator('iframe[title="Navigator DSH session"]');
      const pilotFrame = page.frameLocator('iframe[title="Pilot DSH session"]');
      await Promise.all([
        navigatorFrame.locator('[data-embedded="true"]').waitFor({ timeout: 30_000 }),
        pilotFrame.locator('[data-embedded="true"]').waitFor({ timeout: 30_000 }),
      ]);
      const frames = page.frames().filter((frame: any) => frame !== page.mainFrame());
      expect(frames.map((frame: any) => frame.url())).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`session=${encodeURIComponent(ids.navigatorSessionId)}`),
          expect.stringContaining(`session=${encodeURIComponent(ids.pilotSessionId)}`),
        ]),
      );
      await navigatorFrame.getByText('Navigator stayed responsive while Pilot was working.', { exact: true })
        .waitFor({ timeout: 30_000 });
      await pilotFrame.getByText('Pilot completed the harmless work.', { exact: true })
        .waitFor({ timeout: 30_000 });
      expect(await pilotFrame.getByText(/phase0_echo/).count()).toBeGreaterThan(0);
      await pilotFrame.getByRole('tab', { name: 'Trajectory', exact: true }).click();
      await pilotFrame.locator('[data-trajectory-scroll]').waitFor({ timeout: 30_000 });
      expect(await pilotFrame.getByRole('button', { name: /subagent/i }).count()).toBe(0);
      await expect.poll(() => new Set(historyTargets), { timeout: 30_000 }).toEqual(
        new Set([ids.navigatorSessionId, ids.pilotSessionId]),
      );

      const before = await coordinator.getPair(pairId);
      headerBeforeRestart = before.projection.header;
      const pairEvents = await store.read(pairId);
      digestsBeforeRestart = pairEvents
        .filter((event) => event.type === 'pair.request_built')
        .map((event) =>
          (event.payload as { snapshot: { fullRequestDigest: string } }).snapshot.fullRequestDigest,
        );
      expect(digestsBeforeRestart).toHaveLength(4);
      const expectedTools = [
        {
          name: 'pair_message_peer',
          description: 'Send one bounded message to the other Pair Agent and wake it.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['text'],
            properties: {
              text: { type: 'string', minLength: 1, maxLength: 65536 },
            },
          },
        },
        {
          name: 'phase0_echo',
          description: 'A deterministic harmless Phase 0 echo tool.',
          parameters: { type: 'object', properties: { text: { type: 'string' } } },
        },
      ].sort((left, right) => left.name.localeCompare(right.name));
      expect(runtime.adapter.captureRequests()).toHaveLength(4);
      for (const request of runtime.adapter.captureRequests()) {
        expect(request.tools).toEqual(expectedTools);
      }
      expect(await readFile(runtime.adapter.sessionArtifact(ids.navigatorSessionId).path, 'utf8'))
        .toContain('While Pilot is blocked');
      expect(await readFile(runtime.adapter.sessionArtifact(ids.pilotSessionId).path, 'utf8'))
        .toContain('phase0_echo');
    } finally {
      await closeBestEffort('Phase 0 E2E live cleanup', [
        async () => browser?.close(),
        async () => viteServer?.close(),
        async () => pairHost?.close(),
        async () => runtime.close(),
      ]);
    }

    const resumedStore = new JsonlPairLedgerStore(pairRoot);
    const resumedPeerRouter = new PeerMessageRouter();
    const resumedRuntime = await launchDshPairWebRuntime({
      source: { derivedRoot: dshRoot, lockPath: dshLockPath },
      dataRoot,
      store: resumedStore,
      commonSystem,
      provider: 'openai-completions',
      model: 'capture-model',
      capture: { responses: [] },
      tools: [
        resumedPeerRouter.toolDefinition(),
        {
          name: 'phase0_echo',
          description: 'A deterministic harmless Phase 0 echo tool.',
          parameters: { text: { type: 'string' } },
          async execute(args) {
            return [{ type: 'text', text: `echo: ${String(args.text)}` }];
          },
        },
      ],
      web: { host: '127.0.0.1', port: 0 },
    });
    const resumedRegistry = new PairRegistry(resumedStore, resumedRuntime.adapter);
    const resumedCoordinator = new PairCoordinator(
      resumedRegistry,
      resumedStore,
      resumedRuntime.adapter,
    );
    resumedPeerRouter.bind(new PeerMessageService(resumedCoordinator, resumedRuntime.adapter));
    try {
      const recovered = await resumedRegistry.recoverPair(pairId);
      expect(recovered.projection.header).toEqual(headerBeforeRestart);
      const resumedEvents = await resumedStore.read(pairId);
      expect(
        resumedEvents
          .filter((event) => event.type === 'pair.request_built')
          .map((event) =>
            (event.payload as { snapshot: { fullRequestDigest: string } }).snapshot.fullRequestDigest,
          ),
      ).toEqual(digestsBeforeRestart);
      for (const event of resumedEvents.filter((candidate) => candidate.type === 'pair.request_built')) {
        const payload = event.payload as {
          requestId: string;
          snapshot: { fullRequestDigest: string };
        };
        await expect(resumedRuntime.adapter.rebuildRequestDigest(payload.requestId))
          .resolves.toBe(payload.snapshot.fullRequestDigest);
      }
    } finally {
      await closeBestEffort('Phase 0 E2E recovery cleanup', [
        async () => resumedCoordinator.close(),
        async () => resumedRuntime.close(),
      ]);
    }
  }, 180_000);
});
