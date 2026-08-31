import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const requireFromVitest = createRequire(require.resolve('vitest/package.json'));
const viteNodeManifest = requireFromVitest.resolve('vite-node/package.json');
const viteNode = join(dirname(viteNodeManifest), 'vite-node.mjs');
const child = spawn(process.execPath, [viteNode, 'scripts/dev-cli.ts'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

let forwarded = false;
/** @param {NodeJS.Signals} signal */
const forward = (signal) => {
  if (forwarded) return;
  forwarded = true;
  child.kill(signal);
};
process.once('SIGINT', () => forward('SIGINT'));
process.once('SIGTERM', () => forward('SIGTERM'));

const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
if (result.signal !== null) process.exitCode = result.signal === 'SIGINT' ? 130 : 1;
else process.exitCode = result.code ?? 1;
