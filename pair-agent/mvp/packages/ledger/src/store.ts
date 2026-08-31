import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  MAX_SESSION_EVENTS_PAGE_SIZE,
  assertJsonObject,
  canonicalJsonStringify,
  isPairEventType,
  parsePairId,
  type PairEvent,
  type PairEventDraft,
  type PairId,
  type JsonObject,
} from '@pair-agent/contracts';

export interface PairEventListOptions {
  afterSeq: number;
  limit: number;
  include?: (event: PairEvent) => boolean;
}

export interface PairEventListPage {
  events: PairEvent[];
  nextAfterSeq: number;
  hasMore: boolean;
  throughLedgerHead: number;
}

export function paginatePairEvents(
  all: readonly PairEvent[],
  options: PairEventListOptions,
): PairEventListPage {
  if (!Number.isSafeInteger(options.afterSeq) || options.afterSeq < 0) {
    throw new RangeError('afterSeq must be a non-negative safe integer');
  }
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > MAX_SESSION_EVENTS_PAGE_SIZE
  ) {
    throw new RangeError(
      `limit must be between 1 and ${MAX_SESSION_EVENTS_PAGE_SIZE}`,
    );
  }

  const events: PairEvent[] = [];
  let nextAfterSeq = options.afterSeq;
  const include = options.include ?? (() => true);
  for (const event of all) {
    if (event.seq <= options.afterSeq) continue;
    nextAfterSeq = event.seq;
    if (include(event)) events.push(structuredClone(event));
    if (events.length === options.limit) break;
  }
  const throughLedgerHead = all.at(-1)?.seq ?? 0;
  return {
    events,
    nextAfterSeq,
    hasMore: throughLedgerHead > nextAfterSeq,
    throughLedgerHead,
  };
}

export class LedgerConflictError extends Error {
  readonly expectedLedgerHead: number;
  readonly actualLedgerHead: number;

  constructor(expectedLedgerHead: number, actualLedgerHead: number) {
    super(
      `Ledger head conflict: expected ${expectedLedgerHead}, actual ${actualLedgerHead}`,
    );
    this.name = 'LedgerConflictError';
    this.expectedLedgerHead = expectedLedgerHead;
    this.actualLedgerHead = actualLedgerHead;
  }
}

export class LedgerCorruptionError extends Error {
  readonly lineNumber: number;

  constructor(lineNumber: number, detail: string, options?: ErrorOptions) {
    super(`Corrupt Pair ledger at line ${lineNumber}: ${detail}`, options);
    this.name = 'LedgerCorruptionError';
    this.lineNumber = lineNumber;
  }
}

export class LedgerPathError extends Error {
  constructor(detail: string, options?: ErrorOptions) {
    super(`Unsafe Pair ledger path: ${detail}`, options);
    this.name = 'LedgerPathError';
  }
}

export interface JsonlPairLedgerStoreOptions {
  clock?: () => Date;
}

export const LEDGER_CONCURRENCY_SCOPE = 'single-process' as const;

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function encodePairIdForStorage(pairIdInput: string): string {
  const pairId = parsePairId(pairIdInput);
  let accumulator = 0;
  let bitCount = 0;
  let encoded = '';
  for (const byte of Buffer.from(pairId, 'utf8')) {
    accumulator = (accumulator << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      encoded += BASE32_ALPHABET[(accumulator >>> bitCount) & 0x1f];
    }
    accumulator &= (1 << bitCount) - 1;
  }
  if (bitCount > 0) {
    encoded += BASE32_ALPHABET[(accumulator << (5 - bitCount)) & 0x1f];
  }
  return `pair-${encoded}`;
}

type Heads = { ledgerHead: number; sharedHead: number };

const LEDGER_APPEND_QUEUES = new Map<string, Promise<void>>();

function serializeLedgerAppend<TResult>(
  ledgerKey: string,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const prior = LEDGER_APPEND_QUEUES.get(ledgerKey) ?? Promise.resolve();
  const result = prior.catch(() => undefined).then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  LEDGER_APPEND_QUEUES.set(ledgerKey, settled);
  void settled.finally(() => {
    if (LEDGER_APPEND_QUEUES.get(ledgerKey) === settled) {
      LEDGER_APPEND_QUEUES.delete(ledgerKey);
    }
  });
  return result;
}

const STORE_OWNED_FIELDS = ['pairId', 'seq', 'occurredAt'] as const;
const EVENT_KEYS = new Set([
  'pairId',
  'seq',
  'type',
  'actor',
  'source',
  'channel',
  'visibility',
  'authority',
  'refs',
  'payload',
  'occurredAt',
]);
const DRAFT_KEYS = new Set(
  [...EVENT_KEYS].filter(
    (key) => !STORE_OWNED_FIELDS.includes(key as (typeof STORE_OWNED_FIELDS)[number]),
  ),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isActor(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (value.kind === 'agent') {
    return (
      hasOnlyKeys(value, new Set(['kind', 'role'])) &&
      (value.role === 'navigator' || value.role === 'pilot')
    );
  }
  return (
    hasOnlyKeys(value, new Set(['kind'])) &&
    (value.kind === 'user' || value.kind === 'host' || value.kind === 'pair')
  );
}

function isSource(value: unknown): boolean {
  return (
    value === 'pair' ||
    value === 'navigator-session' ||
    value === 'pilot-session'
  );
}

function isChannel(value: unknown): boolean {
  return (
    value === 'navigator' || value === 'pilot' || value === 'shared-control'
  );
}

function isVisibility(value: unknown): boolean {
  return (
    value === 'shared' ||
    value === 'local' ||
    value === 'infrastructure'
  );
}

function isAuthority(value: unknown): boolean {
  return (
    value === 'user' ||
    value === 'user-derived' ||
    value === 'navigator' ||
    value === 'pilot' ||
    value === 'host'
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

const REF_KEYS = new Set(['goal', 'task', 'executionPlan', 'sourceEventIds']);
const GOAL_REF_KEYS = new Set(['id', 'version']);
const TASK_REF_KEYS = new Set(['id', 'revision']);
const EXECUTION_PLAN_REF_KEYS = new Set(['id', 'revision']);

function pairEventRefsProblem(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return 'refs must be a plain object';
  try {
    assertJsonObject(value);
  } catch {
    return 'refs must contain only JSON values';
  }
  if (!hasOnlyKeys(value, REF_KEYS)) return 'refs contains an unknown key';

  if (Object.hasOwn(value, 'goal')) {
    if (!isPlainRecord(value.goal)) return 'refs.goal must be a plain object';
    if (!hasOnlyKeys(value.goal, GOAL_REF_KEYS)) {
      return 'refs.goal contains an unknown key';
    }
    if (!isNonEmptyString(value.goal.id)) return 'refs.goal.id must be non-empty';
    if (!isPositiveInteger(value.goal.version)) {
      return 'refs.goal.version must be a positive integer';
    }
  }

  if (Object.hasOwn(value, 'task')) {
    if (!isPlainRecord(value.task)) return 'refs.task must be a plain object';
    if (!hasOnlyKeys(value.task, TASK_REF_KEYS)) {
      return 'refs.task contains an unknown key';
    }
    if (!isNonEmptyString(value.task.id)) return 'refs.task.id must be non-empty';
    if (!isPositiveInteger(value.task.revision)) {
      return 'refs.task.revision must be a positive integer';
    }
  }

  if (Object.hasOwn(value, 'executionPlan')) {
    if (!isPlainRecord(value.executionPlan)) {
      return 'refs.executionPlan must be a plain object';
    }
    if (!hasOnlyKeys(value.executionPlan, EXECUTION_PLAN_REF_KEYS)) {
      return 'refs.executionPlan contains an unknown key';
    }
    if (!isNonEmptyString(value.executionPlan.id)) {
      return 'refs.executionPlan.id must be non-empty';
    }
    if (!isPositiveInteger(value.executionPlan.revision)) {
      return 'refs.executionPlan.revision must be a positive integer';
    }
  }

  if (Object.hasOwn(value, 'sourceEventIds')) {
    if (
      !Array.isArray(value.sourceEventIds) ||
      !value.sourceEventIds.every(isNonEmptyString)
    ) {
      return 'refs.sourceEventIds must contain only non-empty strings';
    }
  }

  return undefined;
}

function validateStoredEvent(
  value: unknown,
  expectedPairId: PairId,
  expectedSeq: number,
  lineNumber: number,
): PairEvent {
  if (!isRecord(value)) {
    throw new LedgerCorruptionError(lineNumber, 'event must be an object');
  }
  try {
    assertJsonObject(value);
  } catch (error) {
    throw new LedgerCorruptionError(lineNumber, 'event must contain only JSON values', {
      cause: error,
    });
  }
  if (!hasOnlyKeys(value, EVENT_KEYS)) {
    throw new LedgerCorruptionError(lineNumber, 'event contains an unknown field');
  }

  let pairId: PairId;
  try {
    pairId = parsePairId(value.pairId);
  } catch (error) {
    throw new LedgerCorruptionError(lineNumber, 'invalid pairId', {
      cause: error,
    });
  }

  if (pairId !== expectedPairId) {
    throw new LedgerCorruptionError(
      lineNumber,
      `event belongs to ${pairId}, expected ${expectedPairId}`,
    );
  }
  if (!Number.isSafeInteger(value.seq) || value.seq !== expectedSeq) {
    throw new LedgerCorruptionError(
      lineNumber,
      `expected seq ${expectedSeq}, found ${String(value.seq)}`,
    );
  }
  if (!isCanonicalTimestamp(value.occurredAt)) {
    throw new LedgerCorruptionError(
      lineNumber,
      'occurredAt must be a canonical ISO timestamp',
    );
  }
  if (!isPairEventType(value.type)) {
    throw new LedgerCorruptionError(lineNumber, 'invalid event type');
  }
  if (!isActor(value.actor)) {
    throw new LedgerCorruptionError(lineNumber, 'invalid actor');
  }
  if (!isSource(value.source)) {
    throw new LedgerCorruptionError(lineNumber, 'invalid source');
  }
  if (!isChannel(value.channel)) {
    throw new LedgerCorruptionError(lineNumber, 'invalid channel');
  }
  if (!isVisibility(value.visibility)) {
    throw new LedgerCorruptionError(lineNumber, 'invalid visibility');
  }
  if (!isAuthority(value.authority)) {
    throw new LedgerCorruptionError(lineNumber, 'invalid authority');
  }
  const refsProblem = pairEventRefsProblem(value.refs);
  if (refsProblem !== undefined) {
    throw new LedgerCorruptionError(lineNumber, refsProblem);
  }
  try {
    assertJsonObject(value.payload);
  } catch (error) {
    throw new LedgerCorruptionError(lineNumber, 'payload must be valid JSON object', {
      cause: error,
    });
  }

  return value as unknown as PairEvent;
}

export class JsonlPairLedgerStore {
  readonly root: string;

  readonly #clock: () => Date;

  constructor(root: string, options: JsonlPairLedgerStoreOptions = {}) {
    if (!isAbsolute(root)) {
      throw new TypeError('Pair ledger root must be an explicit absolute path');
    }
    this.root = resolve(root);
    this.#clock = options.clock ?? (() => new Date());
  }

  async append<TPayload extends JsonObject>(
    pairIdInput: string,
    draft: PairEventDraft<TPayload>,
    expectedLedgerHead: number,
  ): Promise<PairEvent<TPayload>> {
    const pairId = parsePairId(pairIdInput);
    this.#validateDraft(draft);
    const draftSnapshot = JSON.parse(
      canonicalJsonStringify(draft),
    ) as PairEventDraft<TPayload>;
    if (!Number.isSafeInteger(expectedLedgerHead) || expectedLedgerHead < 0) {
      throw new RangeError('expectedLedgerHead must be a non-negative integer');
    }

    await mkdir(this.root, { recursive: true });
    const rootRealPath = await realpath(this.root);
    const storageName = encodePairIdForStorage(pairId);
    const ledgerKey = `${rootRealPath}\0${storageName}`;

    return serializeLedgerAppend(ledgerKey, async () => {
      const pairDirectory = await this.#resolvePairDirectory(
        rootRealPath,
        storageName,
        true,
      );
      let handle = await this.#openLedger(pairDirectory!, false, true);
      try {
        const bytes = handle === undefined ? Buffer.alloc(0) : await handle.readFile();
        const events = this.#parseLedger(bytes.toString('utf8'), pairId);
        const actualLedgerHead = events.at(-1)?.seq ?? 0;
        if (actualLedgerHead !== expectedLedgerHead) {
          throw new LedgerConflictError(expectedLedgerHead, actualLedgerHead);
        }

        if (handle === undefined) {
          handle = await this.#openLedger(pairDirectory!, true, true);
        }
        if (handle === undefined) {
          throw new LedgerPathError('failed to create pair.jsonl');
        }

        if (bytes.length > 0 && bytes.at(-1) !== 0x0a) {
          const lastNewline = bytes.lastIndexOf(0x0a);
          await this.#assertOpenLedgerIdentity(pairDirectory!, handle);
          await handle.truncate(lastNewline + 1);
        }

        const event: PairEvent<TPayload> = {
          pairId,
          seq: expectedLedgerHead + 1,
          type: draftSnapshot.type,
          actor: draftSnapshot.actor,
          source: draftSnapshot.source,
          channel: draftSnapshot.channel,
          visibility: draftSnapshot.visibility,
          authority: draftSnapshot.authority,
          refs: draftSnapshot.refs,
          payload: draftSnapshot.payload,
          occurredAt: this.#clock().toISOString(),
        };
        const serializedEvent = canonicalJsonStringify(event);
        await this.#assertOpenLedgerIdentity(pairDirectory!, handle);
        await handle.writeFile(`${serializedEvent}\n`, 'utf8');
        await handle.sync();
        return JSON.parse(serializedEvent) as PairEvent<TPayload>;
      } finally {
        await handle?.close();
      }
    });
  }

  async read(pairIdInput: string): Promise<PairEvent[]> {
    return this.#readValidated(parsePairId(pairIdInput));
  }

  async replay(pairIdInput: string): Promise<PairEvent[]> {
    return this.read(pairIdInput);
  }

  async list(
    pairIdInput: string,
    options: PairEventListOptions,
  ): Promise<PairEventListPage> {
    return paginatePairEvents(await this.read(pairIdInput), options);
  }

  async heads(pairIdInput: string): Promise<Heads> {
    const events = await this.read(pairIdInput);
    let sharedHead = 0;
    for (const event of events) {
      if (event.visibility === 'shared') {
        sharedHead = event.seq;
      }
    }
    return {
      ledgerHead: events.at(-1)?.seq ?? 0,
      sharedHead,
    };
  }

  #validateDraft(draft: PairEventDraft): void {
    if (!isPlainRecord(draft)) {
      throw new TypeError('Pair event draft must be an object');
    }
    assertJsonObject(draft);
    for (const field of STORE_OWNED_FIELDS) {
      if (Object.hasOwn(draft, field)) {
        throw new TypeError(`Pair event draft contains store-owned field ${field}`);
      }
    }
    if (!hasOnlyKeys(draft, DRAFT_KEYS)) {
      throw new TypeError('Pair event draft contains an unknown field');
    }
    if (!isPairEventType(draft.type)) {
      throw new TypeError('Pair event draft has invalid event type');
    }
    if (!isActor(draft.actor)) {
      throw new TypeError('Pair event draft has invalid actor');
    }
    if (!isSource(draft.source)) {
      throw new TypeError('Pair event draft has invalid source');
    }
    if (!isChannel(draft.channel)) {
      throw new TypeError('Pair event draft has invalid channel');
    }
    if (!isVisibility(draft.visibility)) {
      throw new TypeError('Pair event draft has invalid visibility');
    }
    if (!isAuthority(draft.authority)) {
      throw new TypeError('Pair event draft has invalid authority');
    }
    const refsProblem = pairEventRefsProblem(draft.refs);
    if (refsProblem !== undefined) {
      throw new TypeError(`Pair event draft ${refsProblem}`);
    }
    assertJsonObject(draft.payload);
  }

  async #readValidated(pairId: PairId): Promise<PairEvent[]> {
    let rootRealPath: string;
    try {
      rootRealPath = await realpath(this.root);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const pairDirectory = await this.#resolvePairDirectory(
      rootRealPath,
      encodePairIdForStorage(pairId),
      false,
    );
    if (pairDirectory === undefined) return [];
    const handle = await this.#openLedger(pairDirectory, false, false);
    if (handle === undefined) return [];
    try {
      return this.#parseLedger(await handle.readFile('utf8'), pairId);
    } finally {
      await handle.close();
    }
  }

  #parseLedger(content: string, pairId: PairId): PairEvent[] {
    if (content.length === 0) {
      return [];
    }

    const lines = content.split('\n');
    // A ledger record is committed only when its terminating LF exists.
    // The final split segment is therefore either the normal empty suffix or
    // an uncommitted crash tail; neither is replayed.
    lines.pop();

    const events: PairEvent[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.length === 0) {
        throw new LedgerCorruptionError(index + 1, 'empty event line');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new LedgerCorruptionError(index + 1, 'invalid JSON', {
          cause: error,
        });
      }

      events.push(
        validateStoredEvent(parsed, pairId, events.length + 1, index + 1),
      );
    }
    return events;
  }

  async #resolvePairDirectory(
    rootRealPath: string,
    storageName: string,
    create: boolean,
  ): Promise<string | undefined> {
    const pairDirectory = join(rootRealPath, storageName);
    try {
      const status = await lstat(pairDirectory);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new LedgerPathError(`${pairDirectory} must be a non-symlink directory`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!create) return undefined;
      try {
        await mkdir(pairDirectory);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw mkdirError;
        }
      }
      const status = await lstat(pairDirectory);
      if (status.isSymbolicLink() || !status.isDirectory()) {
        throw new LedgerPathError(`${pairDirectory} must be a non-symlink directory`);
      }
    }

    const pairRealPath = await realpath(pairDirectory);
    const relativePath = relative(rootRealPath, pairRealPath);
    if (
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(relativePath)
    ) {
      throw new LedgerPathError(`${pairDirectory} escapes the ledger root`);
    }
    return pairRealPath;
  }

  async #openLedger(
    pairDirectory: string,
    create: boolean,
    writable: boolean,
  ): Promise<FileHandle | undefined> {
    const ledgerPath = join(pairDirectory, 'pair.jsonl');
    try {
      const status = await lstat(ledgerPath);
      if (status.isSymbolicLink() || !status.isFile()) {
        throw new LedgerPathError(`${ledgerPath} must be a regular non-symlink file`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (!create) return undefined;
    }

    const noFollow =
      typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    const flags = writable
      ? constants.O_RDWR |
        constants.O_APPEND |
        (create ? constants.O_CREAT : 0) |
        noFollow
      : constants.O_RDONLY | noFollow;
    let handle: FileHandle;
    try {
      handle = await open(ledgerPath, flags, 0o600);
    } catch (error) {
      if (!create && isMissing(error)) return undefined;
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new LedgerPathError(`${ledgerPath} may not be a symlink`, {
          cause: error,
        });
      }
      throw error;
    }

    try {
      await this.#assertOpenLedgerIdentity(pairDirectory, handle);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #assertOpenLedgerIdentity(
    pairDirectory: string,
    handle: FileHandle,
  ): Promise<void> {
    const ledgerPath = join(pairDirectory, 'pair.jsonl');
    const [openedStatus, pathStatus] = await Promise.all([
      handle.stat(),
      lstat(ledgerPath),
    ]);
    if (
      !openedStatus.isFile() ||
      pathStatus.isSymbolicLink() ||
      !pathStatus.isFile() ||
      openedStatus.dev !== pathStatus.dev ||
      openedStatus.ino !== pathStatus.ino
    ) {
      throw new LedgerPathError(`${ledgerPath} changed during ledger access`);
    }
  }
}
