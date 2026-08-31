import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createPairHostServer } from '../apps/pair-host/src/server.js';
import { JsonlPairLedgerStore } from '../packages/ledger/src/index.js';
import {
  launchDshPairWebRuntime,
  PairCoordinator,
  PairRegistry,
  type DshPairWebRuntime,
} from '../packages/runtime/src/index.js';

import { readPhase0DevConfig } from './dev-config.js';
import { closeBestEffort, pairWebRuntimeDefines } from './runtime-utils.js';

const mvpRoot = fileURLToPath(new URL('..', import.meta.url));

async function ready(url: string, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      last = new Error(`${label} returned HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`${label} did not become ready`, { cause: last });
}

export async function runPhase0Dev(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = readPhase0DevConfig(environment);
  await mkdir(config.dataRoot, { recursive: true });
  const pairRoot = join(config.dataRoot, 'pairs');
  const store = new JsonlPairLedgerStore(pairRoot);
  let registry!: PairRegistry;
  let dshRuntime: DshPairWebRuntime | undefined;
  let pairHost: ReturnType<typeof createPairHostServer> | undefined;
  let pairWeb:
    | {
        listen(): Promise<void>;
        close(): Promise<void>;
        resolvedUrls?: { local: string[] };
      }
    | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    const attempt = closeBestEffort('Phase 0 shutdown failed', [
      async () => pairWeb?.close(),
      async () => pairHost?.close(),
      async () => dshRuntime?.close(),
    ]);
    closing = attempt;
    void attempt.catch(() => {
      if (closing === attempt) closing = undefined;
    });
    return attempt;
  };

  try {
    const captureResponses = [
      'Navigator accepted the Phase 0 demonstration.',
      {
        toolCall: {
          id: 'call-phase0-demo',
          name: 'phase0_echo',
          arguments: { text: 'Pair Agent Phase 0 is live' },
        },
      } as const,
      'Pilot completed the harmless Phase 0 demonstration.',
      ...Array.from({ length: 128 }, (_, index) => `Capture response ${String(index + 1)}.`),
    ];
    dshRuntime = await launchDshPairWebRuntime({
      source: {
        derivedRoot: join(mvpRoot, '.runtime/deepseek-harness'),
        lockPath: join(mvpRoot, 'dsh.lock.json'),
      },
      dataRoot: config.dataRoot,
      store,
      commonSystem: {
        version: 'pair-prompt/v1',
        content: [
          'You are one member of a Pair Agent.',
          'Navigator owns goal clarification and Pilot owns delegated execution.',
          'The active role is supplied by a later active-role reminder.',
        ].join('\n'),
      },
      provider: 'openai-completions',
      model: config.provider.model,
      ...(config.provider.kind === 'capture'
        ? { capture: { responses: captureResponses } }
        : {
            openai: {
              baseURL: config.provider.baseURL,
              apiKeyEnv: config.provider.apiKeyEnv,
              contextWindow: config.provider.contextWindow,
              maxTokens: config.provider.maxTokens,
            },
          }),
      tools: [
        {
          name: 'phase0_echo',
          description: 'Echo text without side effects.',
          parameters: { text: { type: 'string' } },
          async execute(args) {
            return [{ type: 'text', text: `echo: ${String(args.text)}` }];
          },
        },
      ],
      onLedgerAdvanced: async (pairId) => {
        await registry.publish(pairId);
      },
      web: { host: '127.0.0.1', port: config.ports.dshWeb },
    });
    registry = new PairRegistry(store, dshRuntime.adapter);
    const coordinator = new PairCoordinator(registry, store, dshRuntime.adapter);
    const existingHead = (await store.heads(config.pairId)).ledgerHead;
    if (existingHead === 0) {
      await coordinator.createPair({
        pairId: config.pairId,
        dshBuild: dshRuntime.adapter.getDshRuntimeAttestation().dshBuild,
        expectedLedgerHead: 0,
      });
      if (config.provider.kind === 'capture') {
        await coordinator.sendNavigator({
          pairId: config.pairId,
          text: 'Start the local Pair Agent Phase 0 demonstration.',
          expectedLedgerHead: (await store.heads(config.pairId)).ledgerHead,
        });
        await dshRuntime.adapter.whenIdle(`pair:${config.pairId}:navigator`);
        await coordinator.assignTask({
          pairId: config.pairId,
          expectedLedgerHead: (await store.heads(config.pairId)).ledgerHead,
          task: {
            id: 'phase0-demo',
            revision: 1,
            summary: 'Run the harmless Phase 0 echo tool.',
            state: 'queued',
          },
        });
        await dshRuntime.adapter.whenIdle(`pair:${config.pairId}:pilot`);
      }
    } else {
      await registry.recoverPair(config.pairId);
    }

    pairHost = createPairHostServer({
      registry,
      coordinator,
      dshBuild: dshRuntime.adapter.getDshRuntimeAttestation().dshBuild,
      host: '127.0.0.1',
      port: config.ports.pairHost,
    });
    const pairHostAddress = await pairHost.listen();
    const requireFromPairWeb = createRequire(join(mvpRoot, 'apps/pair-web/package.json'));
    const vite = (await import(pathToFileURL(requireFromPairWeb.resolve('vite')).href)) as {
      createServer(config: unknown): Promise<{
        listen(): Promise<void>;
        close(): Promise<void>;
        resolvedUrls?: { local: string[] };
      }>;
    };
    pairWeb = await vite.createServer({
      root: join(mvpRoot, 'apps/pair-web'),
      define: pairWebRuntimeDefines(dshRuntime.origin),
      server: {
        host: '127.0.0.1',
        port: config.ports.pairWeb,
        strictPort: true,
        proxy: { '/api': { target: pairHostAddress.origin } },
      },
    });
    await pairWeb.listen();
    const pairWebOrigin = pairWeb.resolvedUrls?.local[0]?.replace(/\/$/, '');
    if (pairWebOrigin === undefined) throw new Error('Pair Web server exposed no local URL');
    const pairUrl = `${pairWebOrigin}/pair.html?pairId=${encodeURIComponent(config.pairId)}`;
    await Promise.all([
      ready(dshRuntime.origin, 'DSH Web'),
      ready(`${pairHostAddress.origin}/api/pairs/${encodeURIComponent(config.pairId)}`, 'Pair Host'),
      ready(pairUrl, 'Pair Web'),
    ]);
    process.stdout.write([
      'Pair Agent Phase 0 ready',
      `Pair Web: ${pairUrl}`,
      `DSH Web: ${dshRuntime.origin}`,
      `Pair Host: ${pairHostAddress.origin}`,
      `Data root: ${config.dataRoot}`,
      `Provider: ${config.provider.kind}`,
      '',
    ].join('\n'));

    await new Promise<void>((resolveStop, rejectStop) => {
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        void close().then(resolveStop, rejectStop);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } catch (error) {
    await close().catch((closeError: unknown) => {
      throw new AggregateError([error, closeError], 'Phase 0 startup and cleanup failed');
    });
    throw error;
  }
}
