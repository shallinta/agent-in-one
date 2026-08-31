import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viteBinary = resolve(appDirectory, 'node_modules/.bin/vite');

function productionBuild(overrides: Record<string, string | undefined>) {
  const env = { ...process.env };
  delete env.VITE_DSH_WEB_ORIGIN;
  delete env.VITE_PAIR_SHELL_ORIGIN;
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) env[key] = value;
  }
  return spawnSync(viteBinary, ['build', '--mode', 'production'], {
    cwd: appDirectory,
    env,
    encoding: 'utf8',
  });
}

test.each([
  ['missing DSH origin', { VITE_PAIR_SHELL_ORIGIN: 'https://shell.example' }],
  [
    'invalid DSH origin',
    {
      VITE_PAIR_SHELL_ORIGIN: 'https://shell.example',
      VITE_DSH_WEB_ORIGIN: 'javascript:alert(1)',
    },
  ],
  [
    'same-origin DSH',
    {
      VITE_PAIR_SHELL_ORIGIN: 'https://shell.example',
      VITE_DSH_WEB_ORIGIN: 'https://shell.example/',
    },
  ],
])('production build fails closed for %s', (_name, env) => {
  const result = productionBuild(env);

  expect(result.status).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toMatch(
    /DSH Web origin|separate origin|VITE_DSH_WEB_ORIGIN/i,
  );
});
