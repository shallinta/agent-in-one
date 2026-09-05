import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const requireFromVitest = createRequire(require.resolve('vitest/package.json'));
const viteNodeManifest = requireFromVitest.resolve('vite-node/package.json');
const viteNode = join(dirname(viteNodeManifest), 'vite-node.mjs');
const child = spawn(
  process.execPath,
  [viteNode, 'scripts/analyze-requests.ts', ...process.argv.slice(2)],
  { cwd: process.cwd(), env: process.env, stdio: 'inherit' },
);

const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
if (result.signal !== null) process.exitCode = 1;
else process.exitCode = result.code ?? 1;
