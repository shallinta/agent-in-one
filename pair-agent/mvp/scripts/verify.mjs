import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dshRoot = join(root, '.runtime/deepseek-harness');
const dshVitest = join(dshRoot, 'node_modules/.bin/vitest');

if (!existsSync(dshVitest)) {
  throw new Error(
    'Prepared DSH test runtime is missing; follow README prepare/build/refresh prerequisites first',
  );
}

/** @param {string} label @param {string} command @param {string[]} args @param {string} cwd */
async function run(label, command, args, cwd) {
  process.stdout.write(`\n== ${label}\n`);
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
      DSH_SNAPSHOT: 'replay',
    },
    stdio: 'inherit',
  });
  const result = await new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveResult({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(
      `${label} failed${result.signal === null ? ` with exit ${String(result.code)}` : ` on ${result.signal}`}`,
    );
  }
}

await run('locked DSH source', 'corepack', ['pnpm@11.7.0', 'run', 'verify:source'], root);
await run('Pair tests including Phase 0 E2E', 'corepack', ['pnpm@11.7.0', 'test'], root);
await run('Pair typecheck', 'corepack', ['pnpm@11.7.0', 'run', 'typecheck'], root);
await run('Pair build', 'corepack', ['pnpm@11.7.0', 'run', 'build'], root);
await run(
  'DSH request-layout, addressed-session and fixed-root UI unit regressions',
  dshVitest,
  [
    'run',
    'packages/core/agent-loop/tests/request-layout.spec.ts',
    'packages/client/runtime/tests/web-boot-options.client.spec.ts',
    'packages/client/runtime/tests/sessions-service.client.spec.ts',
    'packages/client/runtime/tests/workspaces-service.client.spec.ts',
    'packages/client/ui-conversation/tests/skeleton.client.spec.tsx',
    'packages/client/ui-layout/tests/app-frame.client.spec.tsx',
  ],
  dshRoot,
);
await run(
  'DSH addressed embedded browser regression',
  dshVitest,
  [
    'run',
    '--config',
    'vitest.web.config.ts',
    'apps/web/tests/addressed-embedded-session.e2e.ts',
  ],
  dshRoot,
);
process.stdout.write('\nPair Agent Phase 0 verification passed.\n');
