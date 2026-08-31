import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  JsonObject,
  PairEventDraft,
  Visibility,
} from '@pair-agent/contracts';
import {
  InvalidPairIdError,
  canonicalJsonStringify,
  parsePairId,
} from '@pair-agent/contracts';
import { afterEach, describe, expect, test } from 'vitest';

import {
  JsonlPairLedgerStore,
  LedgerConflictError,
  LedgerCorruptionError,
  LedgerPathError,
  encodePairIdForStorage,
} from '../src/store.js';

const temporaryDirectories = new Set<string>();
let nextDirectory = 0;

function createRoot(): string {
  const root = join(
    tmpdir(),
    `pair-ledger-${process.pid}-${Date.now()}-${nextDirectory++}`,
  );
  temporaryDirectories.add(root);
  return root;
}

function pairDirectoryPath(root: string, pairId = 'pair-01'): string {
  return join(root, encodePairIdForStorage(pairId));
}

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
  temporaryDirectories.clear();
});

function draft(
  visibility: Visibility = 'shared',
  type: PairEventDraft['type'] = 'user.message',
): PairEventDraft {
  return {
    type,
    actor: { kind: 'user' },
    source: 'pair',
    channel: 'navigator',
    visibility,
    authority: 'user',
    refs: {},
    payload: { text: 'hello' },
  };
}

const refsWithSymbolKey = {} as Record<PropertyKey, unknown>;
refsWithSymbolKey[Symbol('hidden')] = 'not durable';

const invalidRefsCases: ReadonlyArray<readonly [string, unknown]> = [
  ['unknown key', { unknown: true }],
  ['null goal', { goal: null }],
  ['empty goal id', { goal: { id: '', version: 1 } }],
  ['zero goal version', { goal: { id: 'goal-1', version: 0 } }],
  ['fractional goal version', { goal: { id: 'goal-1', version: 1.5 } }],
  ['null task', { task: null }],
  ['empty task id', { task: { id: '', revision: 1 } }],
  ['zero task revision', { task: { id: 'task-1', revision: 0 } }],
  ['fractional task revision', { task: { id: 'task-1', revision: 1.5 } }],
  ['missing execution plan id', { executionPlan: { revision: 1 } }],
  ['empty execution plan id', { executionPlan: { id: '', revision: 1 } }],
  ['zero execution plan revision', { executionPlan: { id: 'plan-1', revision: 0 } }],
  [
    'fractional execution plan revision',
    { executionPlan: { id: 'plan-1', revision: 1.5 } },
  ],
  ['non-array source event IDs', { sourceEventIds: 'event-1' }],
  ['non-string source event ID', { sourceEventIds: [1] }],
  ['empty source event ID', { sourceEventIds: [''] }],
];

class NonJsonPayload {
  value = 'class instance';
}

const circularPayload: Record<string, unknown> = {};
circularPayload.self = circularPayload;

const invalidJsonPayloadCases: ReadonlyArray<readonly [string, unknown]> = [
  ['nested undefined', { nested: { value: undefined } }],
  ['nested function', { nested: { value: () => undefined } }],
  ['nested symbol', { nested: { value: Symbol('invalid') } }],
  ['nested bigint', { nested: { value: 1n } }],
  ['nested NaN', { nested: { value: Number.NaN } }],
  ['nested infinity', { nested: { value: Number.POSITIVE_INFINITY } }],
  ['nested Date', { nested: { value: new Date('2026-08-26T00:00:00.000Z') } }],
  ['nested class instance', { nested: new NonJsonPayload() }],
  ['circular object', circularPayload],
];

describe('JsonlPairLedgerStore append', () => {
  test('requires an explicit absolute root', () => {
    expect(() => new JsonlPairLedgerStore('relative/data')).toThrow(
      /absolute/i,
    );
  });

  test('rejects unsafe PairIds before constructing a path', async () => {
    const root = createRoot();
    const store = new JsonlPairLedgerStore(root);

    await expect(store.append('../escape', draft(), 0)).rejects.toBeInstanceOf(
      InvalidPairIdError,
    );
    await expect(store.read('a/b')).rejects.toBeInstanceOf(InvalidPairIdError);
  });

  test('rejects a pair directory symlink without writing outside the root', async () => {
    const root = createRoot();
    const outside = createRoot();
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await symlink(
      outside,
      pairDirectoryPath(root),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const store = new JsonlPairLedgerStore(root);
    await expect(store.append('pair-01', draft(), 0)).rejects.toBeInstanceOf(
      LedgerPathError,
    );
    await expect(readFile(join(outside, 'pair.jsonl'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  test('rejects a ledger file symlink without modifying its target', async () => {
    const root = createRoot();
    const outside = createRoot();
    const pairDirectory = pairDirectoryPath(root);
    const outsideFile = join(outside, 'outside.jsonl');
    await Promise.all([
      mkdir(pairDirectory, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    await writeFile(outsideFile, 'sentinel', 'utf8');
    await symlink(outsideFile, join(pairDirectory, 'pair.jsonl'), 'file');

    const store = new JsonlPairLedgerStore(root);
    await expect(store.append('pair-01', draft(), 0)).rejects.toBeInstanceOf(
      LedgerPathError,
    );
    await expect(store.read('pair-01')).rejects.toBeInstanceOf(LedgerPathError);
    expect(await readFile(outsideFile, 'utf8')).toBe('sentinel');
  });

  test('allocates identity and persists one complete canonical line before resolving', async () => {
    const root = createRoot();
    const store = new JsonlPairLedgerStore(root, {
      clock: () => new Date('2026-08-26T01:02:03.000Z'),
    });

    const event = await store.append('pair-01', draft(), 0);
    const content = await readFile(join(pairDirectoryPath(root), 'pair.jsonl'), 'utf8');

    expect(event).toMatchObject({
      pairId: parsePairId('pair-01'),
      seq: 1,
      occurredAt: '2026-08-26T01:02:03.000Z',
    });
    expect(content).toBe(`${canonicalJsonStringify(event)}\n`);
  });

  test('round-trips an own __proto__ payload key', async () => {
    const payload = Object.create(null) as JsonObject & Record<string, unknown>;
    payload.__proto__ = { retained: true };
    const store = new JsonlPairLedgerStore(createRoot());

    await store.append('pair-01', { ...draft(), payload }, 0);
    const [replayed] = await store.read('pair-01');

    expect(Object.hasOwn(replayed!.payload as object, '__proto__')).toBe(true);
    expect((replayed!.payload as Record<string, unknown>).__proto__).toEqual({
      retained: true,
    });
  });

  test.each(invalidJsonPayloadCases)(
    'rejects a non-JSON payload before writing: %s',
    async (_label, payload) => {
      const store = new JsonlPairLedgerStore(createRoot());
      const invalid = { ...draft(), payload } as unknown as PairEventDraft;

      await expect(store.append('pair-01', invalid, 0)).rejects.toThrow(
        /JSON|circular/i,
      );
      expect(await store.read('pair-01')).toEqual([]);
    },
  );

  test('returns the exact recursively durable JSON event', async () => {
    const store = new JsonlPairLedgerStore(createRoot());
    const nested = {
      matrix: [[1, 2], [3, null]],
      object: { enabled: true, label: 'durable' },
    };

    const appended = await store.append(
      'pair-01',
      { ...draft(), payload: nested },
      0,
    );

    expect(await store.read('pair-01')).toEqual([appended]);
  });

  test('snapshots the complete draft before append yields to concurrent mutation', async () => {
    const store = new JsonlPairLedgerStore(createRoot());
    const actor: {
      kind: 'agent';
      role: 'navigator' | 'pilot';
    } = { kind: 'agent', role: 'navigator' };
    const refs = { sourceEventIds: ['before-event'] };
    const payload = { nested: { text: 'before' } };
    const pending = store.append(
      'pair-01',
      {
        ...draft(),
        actor,
        refs,
        payload,
      },
      0,
    );

    actor.role = 'pilot';
    refs.sourceEventIds[0] = 'after-event';
    payload.nested.text = 'after';

    const appended = await pending;
    expect(appended).toMatchObject({
      actor: { kind: 'agent', role: 'navigator' },
      refs: { sourceEventIds: ['before-event'] },
      payload: { nested: { text: 'before' } },
    });
    expect(await store.read('pair-01')).toEqual([appended]);
  });

  test('allows exactly one concurrent append at the same expected head', async () => {
    const root = createRoot();
    const store = new JsonlPairLedgerStore(root);

    const results = await Promise.allSettled([
      store.append('pair-01', draft(), 0),
      store.append('pair-01', draft(), 0),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(LedgerConflictError) });
    expect(await store.read('pair-01')).toHaveLength(1);
  });

  test('allows exactly one concurrent append across store instances', async () => {
    const root = createRoot();
    const firstStore = new JsonlPairLedgerStore(root);
    const secondStore = new JsonlPairLedgerStore(root);

    const results = await Promise.allSettled([
      firstStore.append('pair-01', draft(), 0),
      secondStore.append('pair-01', draft(), 0),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(LedgerConflictError),
    });
    expect(await firstStore.read('pair-01')).toHaveLength(1);

    await expect(firstStore.append('pair-01', draft(), 1)).resolves.toMatchObject({
      seq: 2,
    });
  });

  test('serializes stores opened through real and symlink-alias roots', async () => {
    const root = createRoot();
    const aliasParent = createRoot();
    const aliasRoot = join(aliasParent, 'ledger-alias');
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(aliasParent, { recursive: true }),
    ]);
    await symlink(
      root,
      aliasRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const directStore = new JsonlPairLedgerStore(root);
    const aliasStore = new JsonlPairLedgerStore(aliasRoot);

    const results = await Promise.allSettled([
      directStore.append('pair-01', draft(), 0),
      aliasStore.append('pair-01', draft(), 0),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(LedgerConflictError),
    });
    expect(await directStore.read('pair-01')).toHaveLength(1);
  });

  test('stores differently cased PairIds under independent lowercase encoded identities', async () => {
    const root = createRoot();
    const store = new JsonlPairLedgerStore(root);
    expect(encodePairIdForStorage('CasePair')).not.toBe(
      encodePairIdForStorage('casepair'),
    );
    const longestStorageName = encodePairIdForStorage('x'.repeat(128));
    expect(longestStorageName).toMatch(/^pair-[a-z2-7]+$/);
    expect(Buffer.byteLength(longestStorageName)).toBeLessThanOrEqual(255);

    await Promise.all([
      store.append(
        'CasePair',
        { ...draft(), payload: { text: 'upper' } },
        0,
      ),
      store.append(
        'casepair',
        { ...draft(), payload: { text: 'lower' } },
        0,
      ),
    ]);

    expect(await store.read('CasePair')).toMatchObject([
      { pairId: 'CasePair', payload: { text: 'upper' } },
    ]);
    expect(await store.read('casepair')).toMatchObject([
      { pairId: 'casepair', payload: { text: 'lower' } },
    ]);
    const entries = await readdir(root);
    expect(entries).toHaveLength(2);
    expect(entries).not.toContain('CasePair');
    expect(entries).not.toContain('casepair');
    expect(entries.every((entry) => /^pair-[a-z2-7]+$/.test(entry))).toBe(true);
  });

  test.each(['CON', 'NUL', 'COM1'])(
    'uses a safe encoded directory for device-like PairId %s',
    async (pairId) => {
      const root = createRoot();
      const store = new JsonlPairLedgerStore(root);

      const appended = await store.append(pairId, draft(), 0);

      expect(await store.read(pairId)).toEqual([appended]);
      const entries = await readdir(root);
      expect(entries).toHaveLength(1);
      expect(entries[0]).not.toBe(pairId);
      expect(entries[0]).toMatch(/^pair-[a-z2-7]+$/);
    },
  );

  test('does not write when the expected ledger head is stale', async () => {
    const root = createRoot();
    const store = new JsonlPairLedgerStore(root);
    await store.append('pair-01', draft(), 0);

    await expect(store.append('pair-01', draft(), 0)).rejects.toBeInstanceOf(
      LedgerConflictError,
    );

    expect(await store.read('pair-01')).toHaveLength(1);
  });

  test('rejects drafts that try to provide store-owned fields', async () => {
    const store = new JsonlPairLedgerStore(createRoot());
    const forged = { ...draft(), seq: 99, pairId: 'other' } as PairEventDraft;

    await expect(store.append('pair-01', forged, 0)).rejects.toThrow(
      /store-owned/i,
    );
  });

  test.each(['pair', 'navigator-session', 'pilot-session'] as const)(
    'round-trips event source %s',
    async (source) => {
      const store = new JsonlPairLedgerStore(createRoot());
      const sourcedDraft = { ...draft(), source };

      const appended = await store.append('pair-01', sourcedDraft, 0);

      expect(appended).toMatchObject({ source });
      expect(await store.read('pair-01')).toMatchObject([{ source }]);
    },
  );

  test('rejects an invalid event source before writing', async () => {
    const store = new JsonlPairLedgerStore(createRoot());
    const invalid = {
      ...draft(),
      source: 'other-session',
    } as unknown as PairEventDraft;

    await expect(store.append('pair-01', invalid, 0)).rejects.toThrow(/source/i);
    expect(await store.read('pair-01')).toEqual([]);
  });

  test('rejects an unknown event type before writing', async () => {
    const store = new JsonlPairLedgerStore(createRoot());
    const invalid = {
      ...draft(),
      type: 'unknown.event',
    } as unknown as PairEventDraft;

    await expect(store.append('pair-01', invalid, 0)).rejects.toThrow(/type/i);
    expect(await store.read('pair-01')).toEqual([]);
  });

  test.each(invalidRefsCases)(
    'rejects invalid refs before writing: %s',
    async (_label, refs) => {
      const store = new JsonlPairLedgerStore(createRoot());
      const invalid = {
        ...draft(),
        refs,
      } as unknown as PairEventDraft;

      await expect(store.append('pair-01', invalid, 0)).rejects.toThrow(/refs/i);
      expect(await store.read('pair-01')).toEqual([]);
    },
  );

  test('rejects symbol-keyed refs instead of silently omitting them', async () => {
    const store = new JsonlPairLedgerStore(createRoot());
    const invalid = {
      ...draft(),
      refs: refsWithSymbolKey,
    } as unknown as PairEventDraft;

    await expect(store.append('pair-01', invalid, 0)).rejects.toThrow(/refs/i);
    expect(await store.read('pair-01')).toEqual([]);
  });
});

describe('JsonlPairLedgerStore replay', () => {
  const completeEnvelope = {
    pairId: 'pair-01',
    seq: 1,
    type: 'user.message',
    actor: { kind: 'user' },
    source: 'pair',
    channel: 'navigator',
    visibility: 'shared',
    authority: 'user',
    refs: {},
    payload: { text: 'hello' },
    occurredAt: '2026-08-26T01:02:03.000Z',
  };

  test('tracks sharedHead as the latest shared event sequence', async () => {
    const store = new JsonlPairLedgerStore(createRoot());
    await store.append('pair-01', draft('shared'), 0);
    await store.append('pair-01', draft('local', 'agent.message'), 1);
    await store.append('pair-01', draft('shared', 'goal.committed'), 2);
    await store.append(
      'pair-01',
      draft('infrastructure', 'pair.request_built'),
      3,
    );

    expect(await store.heads('pair-01')).toEqual({
      ledgerHead: 4,
      sharedHead: 3,
    });
  });

  test('ignores an incomplete final line left by a crash', async () => {
    const root = createRoot();
    const store = new JsonlPairLedgerStore(root);
    const first = await store.append('pair-01', draft(), 0);
    await appendFile(join(pairDirectoryPath(root), 'pair.jsonl'), '{"pairId":');

    expect(await store.replay('pair-01')).toEqual([first]);
  });

  test('removes an incomplete crash tail before the next append', async () => {
    const root = createRoot();
    const store = new JsonlPairLedgerStore(root);
    const first = await store.append('pair-01', draft(), 0);
    const ledgerPath = join(pairDirectoryPath(root), 'pair.jsonl');
    await appendFile(ledgerPath, '{"pairId":');

    const second = await store.append('pair-01', draft(), 1);

    expect(await store.read('pair-01')).toEqual([first, second]);
    expect(await readFile(ledgerPath, 'utf8')).toBe(
      `${canonicalJsonStringify(first)}\n${canonicalJsonStringify(second)}\n`,
    );
  });

  test('rejects malformed complete lines in the middle', async () => {
    const root = createRoot();
    const store = new JsonlPairLedgerStore(root);
    const first = await store.append('pair-01', draft(), 0);
    const validSecond = { ...first, seq: 2 };
    await appendFile(
      join(pairDirectoryPath(root), 'pair.jsonl'),
      `not-json\n${canonicalJsonStringify(validSecond)}\n`,
    );

    await expect(store.read('pair-01')).rejects.toBeInstanceOf(
      LedgerCorruptionError,
    );
  });

  test('rejects an empty event line', async () => {
    const root = createRoot();
    const pairDirectory = pairDirectoryPath(root);
    await mkdir(pairDirectory, { recursive: true });
    await appendFile(join(pairDirectory, 'pair.jsonl'), '\n');

    await expect(
      new JsonlPairLedgerStore(root).read('pair-01'),
    ).rejects.toBeInstanceOf(LedgerCorruptionError);
  });

  test.each([
    ['missing pairId', { ...completeEnvelope, pairId: undefined }],
    ['invalid pairId', { ...completeEnvelope, pairId: '../escape' }],
    ['invalid seq', { ...completeEnvelope, seq: 0 }],
    ['unknown event type', { ...completeEnvelope, type: 'unknown.event' }],
    ['missing type', { ...completeEnvelope, type: undefined }],
    ['missing actor', { ...completeEnvelope, actor: undefined }],
    ['invalid actor', { ...completeEnvelope, actor: { kind: 'agent', role: 'observer' } }],
    ['missing source', { ...completeEnvelope, source: undefined }],
    ['invalid source', { ...completeEnvelope, source: 'other-session' }],
    ['missing channel', { ...completeEnvelope, channel: undefined }],
    ['missing visibility', { ...completeEnvelope, visibility: undefined }],
    ['missing authority', { ...completeEnvelope, authority: undefined }],
    ['missing refs', { ...completeEnvelope, refs: undefined }],
    ['non-object refs', { ...completeEnvelope, refs: [] }],
    ['missing payload', { ...completeEnvelope, payload: undefined }],
    ['non-object payload', { ...completeEnvelope, payload: 'text' }],
    ['missing occurredAt', { ...completeEnvelope, occurredAt: undefined }],
    ['non-canonical occurredAt', { ...completeEnvelope, occurredAt: 'today' }],
  ])('rejects a complete JSON event with %s', async (_label, candidate) => {
    const root = createRoot();
    const pairDirectory = pairDirectoryPath(root);
    await mkdir(pairDirectory, { recursive: true });
    await appendFile(
      join(pairDirectory, 'pair.jsonl'),
      `${JSON.stringify(candidate)}\n`,
    );

    await expect(
      new JsonlPairLedgerStore(root).read('pair-01'),
    ).rejects.toBeInstanceOf(LedgerCorruptionError);
  });

  test.each(invalidRefsCases)(
    'rejects persisted invalid refs: %s',
    async (_label, refs) => {
      const root = createRoot();
      const pairDirectory = pairDirectoryPath(root);
      await mkdir(pairDirectory, { recursive: true });
      await appendFile(
        join(pairDirectory, 'pair.jsonl'),
        `${canonicalJsonStringify({ ...completeEnvelope, refs })}\n`,
      );

      await expect(
        new JsonlPairLedgerStore(root).read('pair-01'),
      ).rejects.toBeInstanceOf(LedgerCorruptionError);
    },
  );

  test('rejects recursively non-finite JSON numbers during read', async () => {
    const root = createRoot();
    const pairDirectory = pairDirectoryPath(root);
    await mkdir(pairDirectory, { recursive: true });
    const line = JSON.stringify(completeEnvelope).replace(
      '{"text":"hello"}',
      '{"nested":{"value":1e400}}',
    );
    await appendFile(join(pairDirectory, 'pair.jsonl'), `${line}\n`);

    await expect(
      new JsonlPairLedgerStore(root).read('pair-01'),
    ).rejects.toBeInstanceOf(LedgerCorruptionError);
  });
});
