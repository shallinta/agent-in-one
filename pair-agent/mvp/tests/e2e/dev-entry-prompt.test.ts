import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { PairEvent } from '../../packages/contracts/src/index.js';
import { encodePairIdForStorage } from '../../packages/ledger/src/index.js';
import { P05_PAIR_PROMPT } from '../../scripts/pair-prompt.js';
import { expect, test } from 'vitest';

const mvpRoot = resolve(import.meta.dirname, '../..');

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Expected an assigned TCP port');
  }
  const { port } = address;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

async function waitForStdout(child: ChildProcess, needle: string): Promise<void> {
  let output = '';
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${needle}\n${output}`)),
      30_000,
    );
    const capture = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes(needle)) {
        clearTimeout(timeout);
        resolveReady();
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`dev.mjs exited early (${code ?? signal})\n${output}`));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out stopping dev.mjs')),
      15_000,
    );
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
  child.kill('SIGTERM');
  await exited;
}

test('the real dev entry installs the P0.5 content-addressed Prompt', async () => {
  const pairId = 'pair-dev-entry-prompt';
  const dataRoot = await mkdtemp(join(tmpdir(), 'pair-prompt-entry-'));
  const [pairWebPort, dshWebPort, pairHostPort] = await Promise.all([
    reservePort(),
    reservePort(),
    reservePort(),
  ]);
  const child = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: mvpRoot,
    env: {
      ...process.env,
      PAIR_DATA_ROOT: dataRoot,
      PAIR_ID: pairId,
      PAIR_WEB_PORT: String(pairWebPort),
      DSH_WEB_PORT: String(dshWebPort),
      PAIR_HOST_PORT: String(pairHostPort),
      PAIR_OPENAI_BASE_URL: '',
      PAIR_OPENAI_MODEL: '',
      PAIR_OPENAI_API_KEY_ENV: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForStdout(child, 'Pair Agent P0.5 ready');
    const ledgerPath = join(
      dataRoot,
      'pairs',
      encodePairIdForStorage(pairId),
      'pair.jsonl',
    );
    const events = (await readFile(ledgerPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as PairEvent);
    const snapshots = events
      .filter((event) => event.type === 'pair.request_built')
      .map((event) => event.payload.snapshot as { promptVersion: string });
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    expect(
      snapshots.every(
        ({ promptVersion }) =>
          promptVersion === P05_PAIR_PROMPT.commonSystem.version,
      ),
    ).toBe(true);
  } finally {
    try {
      await stopChild(child);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  }
}, 90_000);
