import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

import { readPhase0DevConfig } from '../dev-config.js';

describe('Phase 0 dev configuration', () => {
  test('defaults persistence outside the repository and capture mode without a key', () => {
    const config = readPhase0DevConfig({});
    expect(config.dataRoot).toBe(join(homedir(), '.pair-agent', 'p0.5'));
    expect(config.provider).toEqual({ kind: 'capture', model: 'capture-model' });
    expect(config.ports).toEqual({ pairWeb: 3070, dshWeb: 3080, pairHost: 3090 });
  });

  test('requires a complete OpenAI-compatible tuple and absolute data root', () => {
    expect(() => readPhase0DevConfig({ PAIR_OPENAI_BASE_URL: 'https://example.test/v1' }))
      .toThrow(/PAIR_OPENAI_MODEL/);
    expect(() => readPhase0DevConfig({ PAIR_DATA_ROOT: './data' }))
      .toThrow(/absolute/);
  });

  test('rejects duplicate, privileged, fractional, and out-of-range ports', () => {
    expect(() => readPhase0DevConfig({ PAIR_WEB_PORT: '3080' })).toThrow(/distinct/);
    expect(() => readPhase0DevConfig({ DSH_WEB_PORT: '80' })).toThrow(/1024/);
    expect(() => readPhase0DevConfig({ PAIR_HOST_PORT: '3090.5' })).toThrow(/integer/);
    expect(() => readPhase0DevConfig({ PAIR_HOST_PORT: '70000' })).toThrow(/65535/);
  });

  test('publishes one offline verify command without an install lifecycle', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(manifest.scripts?.verify).toBe('node scripts/verify.mjs');
    expect(manifest.scripts?.verify).not.toMatch(/install|refresh/);
  });
});
