import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  canonicalJsonStringify,
  createPairSessionIds,
  parsePairId,
  type DshBuildRef,
  type JsonObject,
  type PairEvent,
  type PairId,
  type PairRole,
} from '@pair-agent/contracts';
import type { CommonSystemDefinition } from '@pair-agent/context';
import { JsonlPairLedgerStore } from '@pair-agent/ledger';

import {
  PairRequestBindingError,
  PairRequestPlugin,
  createPairDeliveryMessageInput,
  type PersistedPairRequest,
} from './pair-request-plugin.js';
import {
  ImmutablePairRequestMaterialRegistry,
  type PairRequestMaterialEntry,
} from './request-material-registry.js';
import { PairDerivedEventWriter } from './pair-derived-event-writer.js';
import type {
  PeerMessageExecutionPort,
  PeerMessageServiceContext,
  PeerMessageToolExecutionContext,
  PeerMessageTurnProvenance,
} from './peer-message.js';
import type { DshSessionEvent } from './session-event-derive.js';
import {
  SessionToPairBridge,
  type PairSessionBridgePort,
} from './session-to-pair-bridge.js';
import type {
  AgentAdapter,
  AgentHandle as PairAgentHandle,
  FollowupInput,
  PreparePairAgentInput,
  PreparedPairAgent,
  DshRuntimeAttestation,
  PairRegistry,
} from './pair-registry.js';

const execFile = promisify(execFileCallback);

interface DshMessage {
  readonly id: string;
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: readonly JsonObject[];
  readonly source: JsonObject;
}

interface DshSession {
  readonly id: string;
  readonly header: JsonObject;
  readonly events: readonly JsonObject[];
}

interface DshAgent {
  readonly id: string;
  readonly session: DshSession;
  followup(message: DshMessage): void;
  inject(message: DshMessage): void;
  whenIdle(): Promise<void>;
}

interface DshOwnedAgentHandle {
  readonly agent: DshAgent;
  dispose(): Promise<void>;
}

interface DshObservedPairSession {
  readonly pairId: PairId;
  readonly role: PairRole;
  readonly sessionId: string;
  live?: DshSession;
  pending: boolean;
  pendingSession?: DshSession;
  fault?: Error;
}

interface DshRegisteredToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
}

interface DshContext {
  baseUrl?: string;
  get(name: string): unknown;
  plugin(plugin: unknown, config?: unknown): Promise<unknown>;
  readonly fiber: { dispose(): Promise<void> };
  on(
    name: 'session/event',
    listener: (session: DshSession, event: JsonObject) => void,
  ): () => void;
  readonly agents: {
    create(input: {
      sessionId: string;
      agentOptions: {
        provider: string;
        model: string;
        maxTokens?: number;
        reasoningEffort?: string;
      };
      setup(context: unknown): void;
    }): Promise<DshOwnedAgentHandle>;
    resume(input: {
      resumeSessionId: string;
      agentOptions: {
        provider: string;
        model: string;
        maxTokens?: number;
        reasoningEffort?: string;
      };
      setup(context: unknown): void;
    }): Promise<DshOwnedAgentHandle>;
  };
  readonly sessions: {
    flush(session: DshSession): Promise<boolean>;
  };
  readonly llm: {
    registerAdapter(routes: readonly string[], adapter: object): () => void;
    prepareCall(config: {
      provider: string;
      model: string;
    }): Promise<{ readonly config: JsonObject }>;
  };
  readonly sessionPersistence: {
    locate(header: JsonObject): { kind: string; path: string } | undefined;
    readFrom(
      sessionId: string,
      fromSeq: number,
    ): Promise<{ meta: JsonObject; events: JsonObject[] }>;
  };
  readonly tools: {
    register(tool: object): () => void;
    schemas(scope?: unknown): readonly JsonObject[];
  };
  readonly systemPrompt: {
    assemble(): Promise<{ readonly tools: readonly JsonObject[] }>;
  };
}

interface DshLlmAdapterBase {
  resolveModel?(provider: string, model: string): Promise<JsonObject>;
}

type DshLlmAdapterConstructor = new () => DshLlmAdapterBase;

interface VerifiedDshModules {
  readonly sourceRoot: string;
  readonly sourceCommit: string;
  readonly attestation: DshRuntimeAttestation;
  readonly Context: new () => DshContext;
  readonly LlmRuntime: unknown;
  readonly SessionStore: unknown;
  readonly foldSurface: (
    events: readonly JsonObject[],
  ) => { readonly nodes: readonly number[] };
  readonly deriveEventMessage: (event: JsonObject) => DshMessage | null;
  readonly SystemPrompt: unknown;
  readonly ToolRuntime: unknown;
  readonly AgentRegistry: unknown;
  readonly AgentLoop: unknown;
  readonly JsonlSessionPersistence: unknown;
  readonly PiAiProvider: unknown;
  readonly defineContentToolFixture: (input: {
    name: string;
    description: string;
    parameters: JsonObject;
    execute(
      args: JsonObject,
      context: {
        readonly agent?: { readonly id: string };
        readonly callId: string;
        readonly rootCallId: string;
        readonly signal: AbortSignal;
      },
    ): Promise<readonly JsonObject[]>;
  }) => DshRegisteredToolDefinition;
  readonly LlmAdapter: DshLlmAdapterConstructor;
  readonly createUserMessage: (input: {
    content: readonly JsonObject[];
    source: JsonObject;
  }) => DshMessage;
  readonly boot: (
    binName: string,
    absoluteConfigPath: string,
    patches: readonly unknown[],
    prepare: (context: DshContext) => void,
    bareModuleBaseUrl?: string,
  ) => Promise<DshContext>;
  readonly loadOverlayPatches: (binName: string, path: string) => readonly unknown[];
  readonly healProfilesModuleFallback: (installAnchor: string, home: string) => void;
  readonly provideCmdline: (
    context: DshContext,
    input: { readonly args: readonly string[]; exit(code: number): void },
  ) => void;
}

interface DshLock {
  readonly upstreamRepository: string;
  readonly upstreamCommit: string;
  readonly sourceRepository: string;
  readonly expectedDerivedCommit: string;
  readonly requestLayoutSeamVersion: 1;
  readonly runtimeArtifacts: DshRuntimeArtifactLock;
}

export interface DshRuntimeArtifactLock {
  readonly schemaVersion: 1;
  readonly buildProfile: 'official';
  readonly roots: readonly ['apps', 'native', 'packages', 'vendor'];
  readonly include: 'lib/**/*.{js,cjs,mjs}';
  readonly fileCount: number;
  readonly digest: string;
}

export interface RuntimeArtifactVerificationLimits {
  readonly maxTraversalEntries: number;
  readonly maxDepth: number;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

const DEFAULT_ARTIFACT_LIMITS: RuntimeArtifactVerificationLimits = {
  maxTraversalEntries: 100_000,
  maxDepth: 64,
  maxFiles: 10_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

export interface DshSourceOptions {
  readonly derivedRoot: string;
  readonly lockPath: string;
}

export type CaptureProviderOptions =
  | {
      readonly responses: readonly CaptureProviderResponse[];
      readonly responsesBySession?: never;
      readonly retryFailures?: boolean;
    }
  | {
      readonly responses?: never;
      readonly responsesBySession: Readonly<
        Record<string, readonly CaptureProviderResponse[]>
      >;
      readonly retryFailures?: boolean;
    };

export type CaptureProviderResponse =
  | string
  | {
      readonly failure: {
        readonly message: string;
        readonly code: string;
      };
    }
  | {
      readonly toolCall: {
        readonly id: string;
        readonly name: string;
        readonly arguments: JsonObject;
      };
    };

interface CaptureProviderQueues {
  readonly global?: CaptureProviderResponse[];
  readonly bySession?: ReadonlyMap<string, CaptureProviderResponse[]>;
}

function captureProviderQueues(
  capture: CaptureProviderOptions | undefined,
): CaptureProviderQueues {
  if (capture === undefined) return {};
  if (capture.responsesBySession === undefined) {
    return { global: [...capture.responses] };
  }
  const prototype = Object.getPrototypeOf(capture.responsesBySession);
  if (
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new TypeError('capture.responsesBySession must be a plain object');
  }
  const bySession = new Map<string, CaptureProviderResponse[]>();
  for (const [sessionId, responses] of Object.entries(capture.responsesBySession)) {
    if (sessionId.length === 0 || !Array.isArray(responses)) {
      throw new TypeError(
        'capture.responsesBySession requires non-empty Session IDs and response arrays',
      );
    }
    bySession.set(sessionId, [...responses]);
  }
  return { bySession };
}

export interface DshPairToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  execute(
    args: JsonObject,
    context: DshPairToolExecutionContext,
  ): Promise<readonly JsonObject[]>;
}

export interface DshPairToolExecutionContext {
  readonly agentId?: string;
  readonly callId: string;
  readonly rootCallId: string;
  readonly signal: AbortSignal;
}

export interface OpenAiCompletionsProviderOptions {
  readonly baseURL: string;
  readonly apiKeyEnv: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  /** Explicit wire-compatibility contract for a private Chat Completions endpoint. */
  readonly compatibility?: 'openai' | 'deepseek';
}

export interface DshPairAgentAdapterOptions {
  readonly source: DshSourceOptions;
  readonly store: JsonlPairLedgerStore;
  readonly sessionRoot: string;
  readonly commonSystem: CommonSystemDefinition;
  readonly provider: 'openai-completions';
  readonly model: string;
  readonly capture?: CaptureProviderOptions;
  readonly openai?: OpenAiCompletionsProviderOptions;
  readonly tools?: readonly DshPairToolDefinition[];
  readonly requestDefaults?: {
    readonly maxTokens?: number;
    readonly reasoningEffort?: string;
  };
  readonly roleToolGuidance?: Readonly<Record<PairRole, string>>;
  readonly historicalRequestMaterials?: readonly PairRequestMaterialEntry[];
  readonly onLedgerAdvanced?: (pairId: PairId) => Promise<void> | void;
  /** Capture-mode fault injection for lifecycle rollback contract tests only. */
  readonly lifecycleFaults?: {
    afterAgentOpened?(): void;
    beforeBridgeRead?(sessionId: string, fromSeq: number): Promise<void> | void;
    beforeDispose?(reason: 'rollback' | 'release' | 'close'): Promise<void> | void;
    /** Hosted capture-runtime fault injection only. */
    beforeHostedContextDispose?(): void;
    /** Hosted capture-runtime concurrency probe only. */
    afterHostedHomeSet?(home: string): Promise<void> | void;
    /** Simulates an unexpected future global DSH tool in capture tests. */
    readonly hostedExtraTool?: DshPairToolDefinition;
  };
}

export interface DshPairWebRuntimeOptions
  extends Omit<DshPairAgentAdapterOptions, 'sessionRoot'> {
  readonly dataRoot: string;
  readonly web: {
    readonly host: '127.0.0.1';
    readonly port: number;
  };
}

export interface DshPairWebRuntime {
  readonly adapter: DshPairAgentAdapter;
  readonly context: DshContext;
  readonly origin: string;
  readonly paths: {
    readonly dataRoot: string;
    readonly sessionRoot: string;
    readonly storageRoot: string;
    readonly harnessHome: string;
  };
  close(): Promise<void>;
}

export interface CapturedProviderRequest {
  readonly provider: string;
  readonly model: string;
  readonly sessionId: string;
  readonly system?: string;
  readonly messages: readonly DshMessage[];
  readonly tools?: readonly JsonObject[];
  readonly fullRequestDigest: string;
  readonly snapshotLedgerSeq: number;
  readonly providerStartedAtLedgerHead: number;
}

export interface DshSessionArtifact {
  readonly path: string;
  readonly compression: 'none';
  readonly packChunks: false;
}

export class DshSourceVerificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DshSourceVerificationError';
  }
}

export class DshAdapterClosedError extends Error {
  constructor() {
    super('DSH Pair adapter is closed');
    this.name = 'DshAdapterClosedError';
  }
}

function canonicalToolCatalog(tools: readonly JsonObject[]): string {
  return canonicalJsonStringify(
    [...tools].sort((left, right) =>
      String(left.name).localeCompare(String(right.name)),
    ),
  );
}

function assertExactToolCatalog(
  actual: readonly JsonObject[],
  expected: readonly JsonObject[],
  boundary: string,
): void {
  if (canonicalToolCatalog(actual) === canonicalToolCatalog(expected)) return;
  throw new PairRequestBindingError(
    `DSH ${boundary} tool catalog must exactly equal the Pair allowlist`,
  );
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function requireAbsolute(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new DshSourceVerificationError(`${label} must be an absolute path`);
  }
  return resolve(path);
}

function lockDocument(value: unknown): DshLock {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DshSourceVerificationError('dsh.lock.json must contain an object');
  }
  const commit = (value as Record<string, unknown>).expectedDerivedCommit;
  const upstreamRepository = (value as Record<string, unknown>).upstreamRepository;
  const upstreamCommit = (value as Record<string, unknown>).upstreamCommit;
  const sourceRepository = (value as Record<string, unknown>).sourceRepository;
  const requestLayoutSeamVersion = (value as Record<string, unknown>)
    .requestLayoutSeamVersion;
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new DshSourceVerificationError(
      'dsh.lock.json expectedDerivedCommit must be a lowercase full commit',
    );
  }
  if (
    typeof upstreamRepository !== 'string' ||
    upstreamRepository.length === 0 ||
    typeof upstreamCommit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(upstreamCommit) ||
    typeof sourceRepository !== 'string' ||
    sourceRepository.length === 0 ||
    requestLayoutSeamVersion !== 1
  ) {
    throw new DshSourceVerificationError(
      'dsh.lock.json build attestation fields are invalid',
    );
  }
  const artifactValue = (value as Record<string, unknown>).runtimeArtifacts;
  if (
    typeof artifactValue !== 'object' ||
    artifactValue === null ||
    Array.isArray(artifactValue)
  ) {
    throw new DshSourceVerificationError(
      'dsh.lock.json requires a runtime artifacts lock',
    );
  }
  const artifact = artifactValue as Record<string, unknown>;
  const roots = artifact.roots;
  const expectedRoots = ['apps', 'native', 'packages', 'vendor'] as const;
  if (
    artifact.schemaVersion !== 1 ||
    artifact.buildProfile !== 'official' ||
    artifact.include !== 'lib/**/*.{js,cjs,mjs}' ||
    !Number.isSafeInteger(artifact.fileCount) ||
    (artifact.fileCount as number) <= 0 ||
    typeof artifact.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
    !Array.isArray(roots) ||
    roots.length !== expectedRoots.length ||
    roots.some((entry, index) => entry !== expectedRoots[index])
  ) {
    throw new DshSourceVerificationError(
      'dsh.lock.json runtime artifacts lock is invalid',
    );
  }
  return {
    upstreamRepository,
    upstreamCommit,
    sourceRepository,
    expectedDerivedCommit: commit,
    requestLayoutSeamVersion,
    runtimeArtifacts: {
      schemaVersion: 1,
      buildProfile: 'official',
      roots: expectedRoots,
      include: 'lib/**/*.{js,cjs,mjs}',
      fileCount: artifact.fileCount as number,
      digest: artifact.digest,
    },
  };
}

async function runtimeArtifactPaths(
  root: string,
  artifactLock: DshRuntimeArtifactLock,
  limits: RuntimeArtifactVerificationLimits,
): Promise<readonly string[]> {
  const paths: string[] = [];
  let traversalEntries = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth) {
      throw new DshSourceVerificationError('DSH runtime artifact tree exceeds depth limit');
    }
    const entries = await readdir(directory, { withFileTypes: true });
    traversalEntries += entries.length;
    if (traversalEntries > limits.maxTraversalEntries) {
      throw new DshSourceVerificationError('DSH runtime artifact tree exceeds traversal limit');
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      const isRuntimeArtifact =
        relativePath.split('/').includes('lib') &&
        /\.(?:js|cjs|mjs)$/.test(relativePath);
      if (entry.isSymbolicLink()) {
        if (isRuntimeArtifact) {
          throw new DshSourceVerificationError(
            `DSH runtime artifact ${relativePath} must not be a symlink`,
          );
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (entry.isFile() && isRuntimeArtifact) {
        paths.push(relativePath);
        if (paths.length > limits.maxFiles) {
          throw new DshSourceVerificationError('DSH runtime artifact tree exceeds file limit');
        }
      }
    }
  };
  for (const artifactRoot of artifactLock.roots) {
    const configured = join(root, artifactRoot);
    const actual = await realpath(configured).catch((error: unknown) => {
      throw new DshSourceVerificationError(
        `DSH runtime artifact root ${artifactRoot} is unavailable`,
        { cause: error },
      );
    });
    if (actual !== configured || !isWithin(root, actual)) {
      throw new DshSourceVerificationError(
        `DSH runtime artifact root ${artifactRoot} escaped the checkout`,
      );
    }
    await walk(actual, 0);
  }
  return paths.sort();
}

export async function measureRuntimeArtifacts(
  root: string,
  derivedCommit: string,
  artifactLock: DshRuntimeArtifactLock,
  limits: RuntimeArtifactVerificationLimits = DEFAULT_ARTIFACT_LIMITS,
): Promise<{ readonly fileCount: number; readonly digest: string }> {
  const paths = await runtimeArtifactPaths(root, artifactLock, limits);
  const files = new Array<{ path: string; sha256: string }>(paths.length);
  let nextIndex = 0;
  let totalBytes = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      const path = paths[index];
      if (path === undefined) return;
      const absolutePath = join(root, ...path.split('/'));
      const actualPath = await realpath(absolutePath).catch((error: unknown) => {
        throw new DshSourceVerificationError(
          `DSH runtime artifact ${path} is unavailable`,
          { cause: error },
        );
      });
      if (actualPath !== absolutePath || !isWithin(root, actualPath)) {
        throw new DshSourceVerificationError(
          `DSH runtime artifact ${path} escaped the checkout`,
        );
      }
      const metadata = await stat(actualPath);
      if (!metadata.isFile() || metadata.size > limits.maxFileBytes) {
        throw new DshSourceVerificationError(
          `DSH runtime artifact ${path} exceeds the per-file size limit`,
        );
      }
      const content = await readFile(actualPath);
      if (content.byteLength > limits.maxFileBytes) {
        throw new DshSourceVerificationError(
          `DSH runtime artifact ${path} exceeds the per-file size limit`,
        );
      }
      totalBytes += content.byteLength;
      if (totalBytes > limits.maxTotalBytes) {
        throw new DshSourceVerificationError(
          'DSH runtime artifacts exceed the total byte limit',
        );
      }
      files[index] = {
        path,
        sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(32, paths.length) }, () => worker()),
  );
  const digest = `sha256:${createHash('sha256')
    .update(
      canonicalJsonStringify({
        schemaVersion: artifactLock.schemaVersion,
        derivedCommit,
        buildProfile: artifactLock.buildProfile,
        roots: artifactLock.roots,
        files,
      }),
      'utf8',
    )
    .digest('hex')}`;
  return { fileCount: paths.length, digest };
}

export async function verifyRuntimeArtifacts(
  root: string,
  derivedCommit: string,
  artifactLock: DshRuntimeArtifactLock,
  limits: RuntimeArtifactVerificationLimits = DEFAULT_ARTIFACT_LIMITS,
): Promise<void> {
  const measured = await measureRuntimeArtifacts(
    root,
    derivedCommit,
    artifactLock,
    limits,
  );
  if (
    measured.fileCount !== artifactLock.fileCount ||
    measured.digest !== artifactLock.digest
  ) {
    throw new DshSourceVerificationError(
      `DSH runtime artifact integrity mismatch: expected ${artifactLock.fileCount} files and ${artifactLock.digest}, received ${measured.fileCount} files and ${measured.digest}`,
    );
  }
}

async function importDefault(
  requireFromDsh: NodeJS.Require,
  specifier: string,
  root: string,
): Promise<Record<string, unknown>> {
  let entry: string;
  try {
    entry = await realpath(requireFromDsh.resolve(specifier));
  } catch (error) {
    throw new DshSourceVerificationError(
      `Cannot resolve ${specifier} from the verified DSH checkout`,
      { cause: error },
    );
  }
  if (!isWithin(root, entry)) {
    throw new DshSourceVerificationError(
      `${specifier} resolved outside the verified DSH checkout`,
    );
  }
  return import(pathToFileURL(entry).href) as Promise<Record<string, unknown>>;
}

async function loadVerifiedDshModules(
  source: DshSourceOptions,
): Promise<VerifiedDshModules> {
  const configuredRoot = requireAbsolute(source.derivedRoot, 'derivedRoot');
  const lockPath = requireAbsolute(source.lockPath, 'lockPath');
  let root: string;
  let lock: DshLock;
  try {
    [root, lock] = await Promise.all([
      realpath(configuredRoot),
      readFile(lockPath, 'utf8').then((text) => lockDocument(JSON.parse(text))),
    ]);
  } catch (error) {
    if (error instanceof DshSourceVerificationError) throw error;
    throw new DshSourceVerificationError('Unable to read the locked DSH source', {
      cause: error,
    });
  }
  const [{ stdout: head }, { stdout: status }] = await Promise.all([
    execFile('git', ['-C', root, 'rev-parse', 'HEAD']),
    execFile('git', ['-C', root, 'status', '--porcelain']),
  ]).catch((error: unknown) => {
    throw new DshSourceVerificationError('Unable to verify the DSH git checkout', {
      cause: error,
    });
  });
  const commit = head.trim();
  if (commit !== lock.expectedDerivedCommit) {
    throw new DshSourceVerificationError(
      `DSH checkout HEAD ${commit} does not match locked commit ${lock.expectedDerivedCommit}`,
    );
  }
  if (status.trim().length > 0) {
    throw new DshSourceVerificationError(
      'DSH checkout has uncommitted changes and is not a verified build',
    );
  }
  await verifyRuntimeArtifacts(root, commit, lock.runtimeArtifacts);

  const anchor = join(root, 'packages/core/agent-loop/package.json');
  const anchorRealPath = await realpath(anchor).catch((error: unknown) => {
    throw new DshSourceVerificationError('Verified DSH agent-loop package is absent', {
      cause: error,
    });
  });
  if (!isWithin(root, anchorRealPath)) {
    throw new DshSourceVerificationError('DSH module resolution anchor escaped the checkout');
  }
  const requireFromDsh = createRequire(anchorRealPath);
  const cliAnchor = await realpath(join(root, 'apps/cli/package.json')).catch(
    (error: unknown) => {
      throw new DshSourceVerificationError('Verified DSH CLI package is absent', {
        cause: error,
      });
    },
  );
  if (!isWithin(root, cliAnchor)) {
    throw new DshSourceVerificationError('DSH CLI module resolution anchor escaped the checkout');
  }
  const requireFromCli = createRequire(cliAnchor);
  const piAiAnchor = await realpath(
    join(root, 'packages/llm/llm-pi-ai/package.json'),
  ).catch((error: unknown) => {
    throw new DshSourceVerificationError(
      'Verified DSH llm-pi-ai package is absent',
      { cause: error },
    );
  });
  if (!isWithin(root, piAiAnchor)) {
    throw new DshSourceVerificationError(
      'DSH llm-pi-ai module resolution anchor escaped the checkout',
    );
  }
  const requireFromPiAi = createRequire(piAiAnchor);
  const [
    cordis,
    llm,
    session,
    systemPrompt,
    tools,
    agent,
    agentLoop,
    persistence,
    piAi,
    appBoot,
    cmdline,
  ] = await Promise.all([
    importDefault(requireFromDsh, '@deepseek-ai/cordis', root),
    importDefault(requireFromDsh, '@deepseek-ai/dsh-llm', root),
    importDefault(requireFromDsh, '@deepseek-ai/dsh-session', root),
    importDefault(requireFromDsh, '@deepseek-ai/dsh-system-prompt', root),
    importDefault(requireFromDsh, '@deepseek-ai/dsh-tools', root),
    importDefault(requireFromDsh, '@deepseek-ai/dsh-agent', root),
    importDefault(requireFromDsh, '@deepseek-ai/dsh-agent-loop', root),
    importDefault(
      requireFromDsh,
      '@deepseek-ai/dsh-session-persistence-jsonl',
      root,
    ),
    importDefault(requireFromPiAi, '@deepseek-ai/dsh-llm-pi-ai', root),
    importDefault(requireFromCli, '@deepseek-ai/dsh-app-boot', root),
    importDefault(requireFromCli, '@deepseek-ai/dsh-cmdline', root),
  ]);
  // Recheck after module evaluation to narrow accidental build drift in the
  // hash-to-import window. This is not a security lock against a malicious
  // local process that can race both checks.
  await verifyRuntimeArtifacts(root, commit, lock.runtimeArtifacts);

  return {
    sourceRoot: root,
    sourceCommit: commit,
    attestation: {
      dshBuild: {
        upstreamRepository: lock.upstreamRepository,
        upstreamCommit: lock.upstreamCommit,
        sourceRepository: lock.sourceRepository,
        sourceCommit: commit,
        requestLayoutSeamVersion: lock.requestLayoutSeamVersion,
      } satisfies DshBuildRef,
      runtimeArtifacts: {
        schemaVersion: lock.runtimeArtifacts.schemaVersion,
        buildProfile: lock.runtimeArtifacts.buildProfile,
        roots: lock.runtimeArtifacts.roots,
        fileCount: lock.runtimeArtifacts.fileCount,
        digest: lock.runtimeArtifacts.digest,
      },
    },
    Context: cordis.Context as VerifiedDshModules['Context'],
    LlmRuntime: llm.default,
    SessionStore: session.default,
    foldSurface: session.foldSurface as VerifiedDshModules['foldSurface'],
    deriveEventMessage:
      session.deriveEventMessage as VerifiedDshModules['deriveEventMessage'],
    SystemPrompt: systemPrompt.default,
    ToolRuntime: tools.default,
    defineContentToolFixture:
      tools.defineContentToolFixture as VerifiedDshModules['defineContentToolFixture'],
    AgentRegistry: agent.default,
    AgentLoop: agentLoop.default,
    JsonlSessionPersistence: persistence.default,
    PiAiProvider: piAi,
    LlmAdapter: llm.LlmAdapter as DshLlmAdapterConstructor,
    createUserMessage:
      llm.createUserMessage as VerifiedDshModules['createUserMessage'],
    boot: appBoot.boot as VerifiedDshModules['boot'],
    loadOverlayPatches:
      appBoot.loadOverlayPatches as VerifiedDshModules['loadOverlayPatches'],
    healProfilesModuleFallback:
      appBoot.healProfilesModuleFallback as VerifiedDshModules['healProfilesModuleFallback'],
    provideCmdline: cmdline.provideCmdline as VerifiedDshModules['provideCmdline'],
  };
}

function requestConfig(request: Record<string, unknown>): JsonObject {
  return {
    provider: request.provider as string,
    model: request.model as string,
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: request.reasoningEffort as string }),
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature as number }),
    ...(request.maxTokens === undefined
      ? {}
      : { maxTokens: request.maxTokens as number }),
    ...(request.stop === undefined
      ? {}
      : { stop: request.stop as readonly string[] }),
  };
}

function textResponse(text: string): readonly JsonObject[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

function sessionSource(sessionId: string): 'navigator-session' | 'pilot-session' {
  return sessionId.endsWith(':navigator') ? 'navigator-session' : 'pilot-session';
}

function jsonRecord(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function durableRequestSnapshot(event: PairEvent): JsonObject {
  const payload = jsonRecord(event.payload);
  const snapshot = jsonRecord(payload?.snapshot);
  if (
    event.type !== 'pair.request_built' ||
    snapshot === undefined ||
    typeof snapshot.fullRequestDigest !== 'string'
  ) {
    throw new PairRequestBindingError(
      `Pair request snapshot at ledger seq ${event.seq} is invalid`,
    );
  }
  return snapshot;
}

export function validatePairRequestCoordinates(
  pairIdInput: string,
  events: readonly PairEvent[],
): readonly PairEvent[] {
  const pairId = parsePairId(pairIdInput);
  const expected = createPairSessionIds(pairId);
  const authoritative = new Map<string, PairRole>([
    [expected.navigatorSessionId, 'navigator'],
    [expected.pilotSessionId, 'pilot'],
  ]);
  const requests = events.filter((event) => event.type === 'pair.request_built');
  const requestIds = new Set<string>();
  for (const event of requests) {
    const payload = jsonRecord(event.payload);
    const snapshot = durableRequestSnapshot(event);
    const sessionId = snapshot.sessionId;
    const role = snapshot.role;
    const requestId = payload?.requestId;
    const expectedRole =
      typeof sessionId === 'string' ? authoritative.get(sessionId) : undefined;
    if (
      expectedRole === undefined ||
      role !== expectedRole ||
      typeof requestId !== 'string' ||
      snapshot.requestId !== requestId ||
      typeof snapshot.turn !== 'number' ||
      typeof snapshot.step !== 'number' ||
      typeof snapshot.attempt !== 'number' ||
      requestId !== `${sessionId}:${snapshot.turn}:${snapshot.step}:${snapshot.attempt}`
    ) {
      throw new PairRequestBindingError(
        `Pair request snapshot at ledger seq ${event.seq} has invalid authoritative coordinates`,
      );
    }
    if (requestIds.has(requestId)) {
      throw new PairRequestBindingError(`Duplicate Pair requestId ${requestId}`);
    }
    requestIds.add(requestId);
  }
  return requests;
}

export class DshPairAgentAdapter implements AgentAdapter, PeerMessageExecutionPort {
  readonly closeOwnsHandles = true as const;
  readonly #handles = new Map<string, DshOwnedAgentHandle>();
  readonly #pairHandles = new WeakMap<PairAgentHandle, DshOwnedAgentHandle>();
  readonly #bindings = new Map<
    string,
    { pairId: PairId; role: PairRole }
  >();
  readonly #preparing = new Map<string, Promise<PreparedPairAgent>>();
  readonly #prepared = new Map<string, PreparedPairAgent>();
  readonly #deliveries = new Map<string, Set<string>>();
  readonly #artifacts = new Map<string, DshSessionArtifact>();
  readonly #captures: CapturedProviderRequest[] = [];
  readonly #requestHandoffs = new PendingRequestHandoffs();
  readonly #orphans = new Set<DshOwnedAgentHandle>();
  readonly #disposedHandles = new WeakSet<DshOwnedAgentHandle>();
  readonly #failedCleanupPairs = new Set<PairId>();
  readonly #observedSessions = new Map<string, DshObservedPairSession>();
  readonly #sessionEventListeners = new Set<
    (sessionId: string, event: DshSessionEvent) => void
  >();
  #observationOff?: () => void;
  #bridge?: SessionToPairBridge;
  #closed = false;
  #closeDrainSuspended = false;
  #closeAgentsDisposed = false;
  #closePromise?: Promise<void>;

  private constructor(
    readonly options: DshPairAgentAdapterOptions,
    readonly modules: VerifiedDshModules,
    readonly context: DshContext,
    readonly requestMaterials: ImmutablePairRequestMaterialRegistry,
    private readonly captureQueues: CaptureProviderQueues,
    private readonly ownsContext: boolean,
    private readonly expectedToolSchemas: readonly JsonObject[],
  ) {}

  static async create(
    options: DshPairAgentAdapterOptions,
  ): Promise<DshPairAgentAdapter> {
    if (!isAbsolute(options.sessionRoot)) {
      throw new TypeError('DSH sessionRoot must be an explicit absolute path');
    }
    if ((options.capture === undefined) === (options.openai === undefined)) {
      throw new TypeError(
        'Exactly one DSH Provider mode must be configured: capture or openai',
      );
    }
    if (options.lifecycleFaults !== undefined && options.capture === undefined) {
      throw new TypeError('lifecycleFaults are allowed only with the capture Provider');
    }
    canonicalJsonStringify(options.commonSystem);
    const modules = await loadVerifiedDshModules(options.source);
    const context = new modules.Context();
    await context.plugin(modules.LlmRuntime);
    await context.plugin(modules.SessionStore);
    await context.plugin(modules.SystemPrompt, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      persona: '',
    });
    await context.plugin(modules.ToolRuntime);
    await context.plugin(modules.AgentRegistry);
    await context.plugin(modules.AgentLoop, { agents: [] });
    await context.plugin(modules.JsonlSessionPersistence, {
      root: resolve(options.sessionRoot),
      compression: 'none',
      packChunks: false,
    });
    return DshPairAgentAdapter.createOnContext(options, modules, context, true);
  }

  private static async createOnContext(
    options: DshPairAgentAdapterOptions,
    modules: VerifiedDshModules,
    context: DshContext,
    ownsContext: boolean,
  ): Promise<DshPairAgentAdapter> {
    assertExactToolCatalog(context.tools.schemas(), [], 'pre-registration');
    const definitions = (options.tools ?? []).map((tool) => {
      const properties = jsonRecord(tool.parameters.properties);
      const required = Array.isArray(tool.parameters.required)
        ? new Set(tool.parameters.required)
        : undefined;
      const fixtureParameters =
        tool.parameters.type === 'object' && properties !== undefined
          ? Object.fromEntries(
              Object.entries(properties).map(([name, value]) => {
                const schema = jsonRecord(value) ?? {};
                const {
                  minLength: _minLength,
                  maxLength: _maxLength,
                  ...fixtureSchema
                } = schema;
                return [
                  name,
                  {
                    ...fixtureSchema,
                    ...(required?.has(name) === true ? { required: true } : {}),
                  },
                ];
              }),
            ) as JsonObject
          : tool.parameters;
      const definition = modules.defineContentToolFixture({
        name: tool.name,
        description: tool.description,
        parameters: fixtureParameters,
        execute: (args, execution) => tool.execute(args, {
          ...(execution.agent === undefined
            ? {}
            : { agentId: execution.agent.id }),
          callId: execution.callId,
          rootCallId: execution.rootCallId,
          signal: execution.signal,
        }),
      });
      return tool.parameters.type === 'object' && properties !== undefined
        ? Object.assign(definition, {
            parameters: structuredClone(tool.parameters),
          })
        : definition;
    });
    const expectedToolSchemas = definitions.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
    for (const definition of definitions) context.tools.register(definition);
    const registeredTools = context.tools.schemas();
    assertExactToolCatalog(registeredTools, expectedToolSchemas, 'global');
    const tools = (await context.systemPrompt.assemble()).tools;
    assertExactToolCatalog(tools, expectedToolSchemas, 'assembled Provider boundary');
    if (options.openai !== undefined) {
      await context.plugin(modules.PiAiProvider, {
        providers: {
          [options.provider]: {
            displayName: 'OpenAI Chat Completions',
            api: 'openai-completions',
            baseURL: options.openai.baseURL,
            apiKeyEnv: options.openai.apiKeyEnv,
            models: [
              {
                id: options.model,
                name: options.model,
                contextWindow: options.openai.contextWindow,
                maxTokens: options.openai.maxTokens,
                input: ['text'],
                ...(options.openai.compatibility === 'deepseek'
                  ? {
                      reasoningEfforts: { high: 'high', max: 'max' },
                      compat: {
                        supportsStore: false,
                        supportsDeveloperRole: false,
                        supportsReasoningEffort: false,
                        requiresReasoningContentOnAssistantMessages: true,
                        thinkingFormat: 'deepseek',
                      },
                    }
                  : { reasoningEfforts: false }),
              },
            ],
          },
        },
      });
    }
    const roleToolGuidance =
      options.roleToolGuidance ?? {
        navigator: 'Clarify and govern the Pair goal; do not perform Pilot work.',
        pilot: 'Execute the delegated task; escalate goal-changing decisions.',
      };
    const proposedConfig = {
      provider: options.provider,
      model: options.model,
      ...options.requestDefaults,
    };
    const config = options.openai === undefined
      ? proposedConfig
      : structuredClone((await context.llm.prepareCall(proposedConfig)).config);
    const activeMaterials: PairRequestMaterialEntry = {
      promptVersion: options.commonSystem.version,
      commonSystem: options.commonSystem,
      roleToolGuidance,
      toolSetVersion: `pair-tools/v1:${sha256Request(tools)}`,
      tools,
      requestConfigVersion: `pair-config/v1:${sha256Request(config)}`,
      config,
    };
    const requestMaterials = new ImmutablePairRequestMaterialRegistry(
      activeMaterials,
      options.historicalRequestMaterials,
    );
    const adapter = new DshPairAgentAdapter(
      options,
      modules,
      context,
      requestMaterials,
      captureProviderQueues(options.capture),
      ownsContext,
      structuredClone(expectedToolSchemas),
    );
    if (options.capture !== undefined) {
      context.llm.registerAdapter(
        [options.provider],
        adapter.#createCaptureProvider(),
      );
    }
    adapter.#installObservationHook();
    return adapter;
  }

  static createOnHostedContext(
    options: DshPairAgentAdapterOptions,
    modules: VerifiedDshModules,
    context: DshContext,
  ): Promise<DshPairAgentAdapter> {
    if (!isAbsolute(options.sessionRoot)) {
      throw new TypeError('DSH sessionRoot must be an explicit absolute path');
    }
    if ((options.capture === undefined) === (options.openai === undefined)) {
      throw new TypeError(
        'Exactly one DSH Provider mode must be configured: capture or openai',
      );
    }
    if (options.lifecycleFaults !== undefined && options.capture === undefined) {
      throw new TypeError('lifecycleFaults are allowed only with the capture Provider');
    }
    canonicalJsonStringify(options.commonSystem);
    return DshPairAgentAdapter.createOnContext(options, modules, context, false);
  }

  attachPairRegistry(registry: PairRegistry): void {
    if (this.#bridge !== undefined) {
      throw new PairRequestBindingError('Pair Bridge is already attached');
    }
    if (this.#observationOff === undefined) {
      throw new PairRequestBindingError('DSH Session observation hook is not installed');
    }
    this.#bridge = new SessionToPairBridge(
      this.observationPort(),
      new PairDerivedEventWriter(registry),
    );
  }

  observationPort(): PairSessionBridgePort {
    return {
      onSessionEvent: (listener) => {
        this.#sessionEventListeners.add(listener);
        return () => this.#sessionEventListeners.delete(listener);
      },
      flushSession: async (sessionId) => {
        const observed = this.#requireObservedSession(sessionId);
        if (observed.fault !== undefined) throw observed.fault;
        if (observed.live === undefined) {
          throw new PairRequestBindingError(
            `DSH Pair Session ${sessionId} has no verified live identity`,
          );
        }
        const accepted = await this.context.sessions.flush(observed.live);
        if (!accepted) {
          throw new PairRequestBindingError(
            `DSH persistence refused to flush Pair Session ${sessionId}`,
          );
        }
      },
      readDurableFrom: async (sessionId, fromSeq) => {
        const observed = this.#requireObservedSession(sessionId);
        if (observed.fault !== undefined) throw observed.fault;
        await this.options.lifecycleFaults?.beforeBridgeRead?.(sessionId, fromSeq);
        const snapshot = await this.context.sessionPersistence.readFrom(
          sessionId,
          fromSeq,
        );
        return structuredClone(snapshot.events) as unknown as DshSessionEvent[];
      },
      whenAgentIdle: async (sessionId) => {
        const handle = this.#handles.get(sessionId);
        if (handle === undefined) {
          throw new PairRequestBindingError(`Unknown DSH Pair session ${sessionId}`);
        }
        await handle.agent.whenIdle();
      },
    };
  }

  preparePairAgent(input: PreparePairAgentInput): Promise<PreparedPairAgent> {
    return this.#prepare(input, false);
  }

  activeContext(
    execution: PeerMessageToolExecutionContext,
  ): PeerMessageServiceContext {
    const agentId = execution.agentId;
    if (agentId === undefined || agentId.length === 0) {
      throw new PairRequestBindingError(
        'Peer Message tool execution lacks an active DSH Agent identity',
      );
    }
    const binding = this.#bindings.get(agentId);
    const handle = this.#handles.get(agentId);
    if (
      binding === undefined ||
      handle === undefined ||
      handle.agent.id !== agentId ||
      handle.agent.session.id !== agentId
    ) {
      throw new PairRequestBindingError(
        'Peer Message tool Agent does not match an active Pair Session binding',
      );
    }
    const turn = this.#openTurn(handle.agent.session);
    return { agentId, sessionId: handle.agent.session.id, turn };
  }

  async turnProvenance(
    context: PeerMessageServiceContext,
  ): Promise<PeerMessageTurnProvenance> {
    if (context.agentId !== context.sessionId) {
      throw new PairRequestBindingError(
        'Peer Message Agent and Session identities diverged',
      );
    }
    const binding = this.#bindings.get(context.sessionId);
    const handle = this.#handles.get(context.sessionId);
    if (
      binding === undefined ||
      handle === undefined ||
      handle.agent.id !== context.agentId ||
      handle.agent.session.id !== context.sessionId ||
      this.#openTurn(handle.agent.session) !== context.turn
    ) {
      throw new PairRequestBindingError(
        'Peer Message context is not the active open Pair Session Turn',
      );
    }
    await this.#requireBridge().whenCaughtUp([context.sessionId]);
    const caughtUpBinding = this.#bindings.get(context.sessionId);
    const caughtUpHandle = this.#handles.get(context.sessionId);
    if (
      caughtUpBinding === undefined ||
      caughtUpHandle === undefined ||
      caughtUpBinding.pairId !== binding.pairId ||
      caughtUpBinding.role !== binding.role ||
      caughtUpHandle !== handle ||
      caughtUpHandle.agent.id !== context.agentId ||
      caughtUpHandle.agent.session.id !== context.sessionId ||
      this.#openTurn(caughtUpHandle.agent.session) !== context.turn
    ) {
      throw new PairRequestBindingError(
        'Peer Message context changed while awaiting durable Pair provenance',
      );
    }
    const pairEvents = await this.options.store.read(binding.pairId);
    const byId = new Map<string, PairEvent>(
      pairEvents.map((event) => [`${event.pairId}:${String(event.seq)}`, event] as const),
    );
    const startIndex = handle.agent.session.events.findLastIndex((event) => {
      const data = jsonRecord(event.data);
      return event.type === 'turn/start' && data?.turn === context.turn;
    });
    if (startIndex < 0) {
      throw new PairRequestBindingError('Peer Message open Turn start is not durable');
    }
    const pairEventIds = new Set<string>();
    for (const event of handle.agent.session.events.slice(startIndex + 1)) {
      if (event.type !== 'user/message') continue;
      const data = jsonRecord(event.data);
      const source = jsonRecord(data?.source);
      if (
        source?.kind === 'plugin' &&
        source.plugin === 'pair-agent:delivery' &&
        typeof source.pairEventId === 'string'
      ) {
        pairEventIds.add(source.pairEventId);
      }
    }
    for (const event of pairEvents) {
      if (event.type !== 'user.message') continue;
      const payload = jsonRecord(event.payload);
      const origin = jsonRecord(payload?.origin);
      if (
        origin?.sessionId === context.sessionId &&
        origin.turn === context.turn &&
        event.channel === binding.role
      ) {
        pairEventIds.add(`${event.pairId}:${String(event.seq)}`);
      }
    }
    const inputEvents = [...pairEventIds].map((id) => {
      const event = byId.get(id);
      if (event === undefined) {
        throw new PairRequestBindingError(
          `Peer Message Turn input ${id} is absent from the durable Pair Ledger`,
        );
      }
      return event;
    });
    if (inputEvents.length === 0) {
      throw new PairRequestBindingError(
        'Peer Message open Turn has no durable Pair input provenance',
      );
    }
    return {
      pairId: binding.pairId,
      senderRole: binding.role,
      inputEvents,
    };
  }

  resumePairAgent(input: PreparePairAgentInput): Promise<PreparedPairAgent> {
    return this.#prepare(input, true);
  }

  getDshRuntimeAttestation(): DshRuntimeAttestation {
    return structuredClone(this.modules.attestation);
  }

  async prepareProviderCall(): Promise<JsonObject> {
    const prepared = await this.context.llm.prepareCall({
      provider: this.options.provider,
      model: this.options.model,
      ...this.options.requestDefaults,
    });
    return structuredClone(prepared.config);
  }

  async #prepare(
    input: PreparePairAgentInput,
    resume: boolean,
  ): Promise<PreparedPairAgent> {
    this.#assertOpen();
    const pairId = parsePairId(input.pairId);
    const expected = createPairSessionIds(pairId);
    const expectedSessionId =
      input.role === 'navigator'
        ? expected.navigatorSessionId
        : expected.pilotSessionId;
    if (input.sessionId !== expectedSessionId) {
      throw new PairRequestBindingError(
        `session ${input.sessionId} does not match the ${input.role} session ${expectedSessionId}`,
      );
    }
    const currentBinding = this.#bindings.get(input.sessionId);
    if (currentBinding !== undefined) {
      if (currentBinding.pairId !== pairId || currentBinding.role !== input.role) {
        throw new PairRequestBindingError('DSH session is already bound to another Pair role');
      }
      const live = this.#handles.get(input.sessionId);
      if (live === undefined) {
        throw new PairRequestBindingError('DSH Pair binding has no live Agent');
      }
      const prepared = this.#prepared.get(input.sessionId);
      if (prepared === undefined) {
        throw new PairRequestBindingError('DSH Pair binding has no owned handle');
      }
      return prepared;
    }
    const pending = this.#preparing.get(input.sessionId);
    if (pending !== undefined) return pending;
    const preparation = this.#prepareFresh(input, pairId, resume);
    this.#preparing.set(input.sessionId, preparation);
    try {
      return await preparation;
    } finally {
      if (this.#preparing.get(input.sessionId) === preparation) {
        this.#preparing.delete(input.sessionId);
      }
    }
  }

  async #prepareFresh(
    input: PreparePairAgentInput,
    pairId: PairId,
    resume: boolean,
  ): Promise<PreparedPairAgent> {
    const plugin = new PairRequestPlugin({
      store: this.options.store,
      binding: { pairId, role: input.role, sessionId: input.sessionId },
      materialRegistry: this.requestMaterials,
      onLedgerAdvanced: this.options.onLedgerAdvanced,
      onRequestPersisted: (request, signal) => {
        if (this.options.capture !== undefined) {
          this.#requestHandoffs.enqueue(input.sessionId, request, signal);
        }
      },
    });
    const createOptions = {
      agentOptions: {
        provider: this.options.provider,
        model: this.options.model,
        ...this.options.requestDefaults,
      },
      setup: (scope: unknown) => plugin.install(scope as Parameters<PairRequestPlugin['install']>[0]),
    };
    if (this.options.capture?.retryFailures === true) {
      createOptions.setup = (scope: unknown): void => {
        plugin.install(scope as Parameters<PairRequestPlugin['install']>[0]);
        (scope as {
          on(
            name: 'agent/request-error',
            listener: () => Promise<{ readonly kind: 'retry' }>,
          ): () => void;
        }).on('agent/request-error', async () => ({ kind: 'retry' }));
      };
    }
    this.#bindProvisional(input, pairId);
    let handle: DshOwnedAgentHandle | undefined;
    try {
      handle = resume
        ? await this.context.agents.resume({
            ...createOptions,
            resumeSessionId: input.sessionId,
          })
        : await this.context.agents.create({
            ...createOptions,
            sessionId: input.sessionId,
          });
      this.options.lifecycleFaults?.afterAgentOpened?.();
      if (
        handle.agent.id !== input.sessionId ||
        handle.agent.session.id !== input.sessionId
      ) {
        throw new PairRequestBindingError('DSH Agent and Session identities diverged');
      }
      this.#assertToolCatalog(handle.agent);
      const location = this.context.sessionPersistence.locate(handle.agent.session.header);
      if (location === undefined || location.kind !== 'jsonl') {
        throw new PairRequestBindingError('DSH JSONL persistence did not locate the Session');
      }
      this.#confirmLiveSession(input.sessionId, handle.agent.session);
      if (!resume) {
        handle.agent.inject(
          this.modules.createUserMessage({
            content: [
              {
                type: 'text',
                text: `<pair-local-bootstrap role="${input.role}">This context belongs only to the ${input.role} Session.</pair-local-bootstrap>`,
              },
            ],
            source: { kind: 'plugin', plugin: 'pair-agent:local-bootstrap' },
          }),
        );
      }
      const prepared = this.#makePrepared(input, handle);
      this.#handles.set(input.sessionId, handle);
      this.#bindings.set(input.sessionId, { pairId, role: input.role });
      this.#deliveries.set(input.sessionId, new Set());
      this.#artifacts.set(input.sessionId, {
        path: location.path,
        compression: 'none',
        packChunks: false,
      });
      this.#pairHandles.set(prepared.handle, handle);
      this.#prepared.set(input.sessionId, prepared);
      return prepared;
    } catch (error) {
      if (handle !== undefined) {
        try {
          await this.#disposeOwned(handle, 'rollback');
        } catch {
          this.#orphans.add(handle);
        }
      }
      this.#removeObservedSession(input.sessionId);
      throw error;
    }
  }

  #makePrepared(
    input: PreparePairAgentInput,
    dshHandle: DshOwnedAgentHandle,
  ): PreparedPairAgent {
    const handle: PairAgentHandle = { sessionId: input.sessionId };
    return {
      handle,
      descriptor: {
        role: input.role,
        source: sessionSource(input.sessionId),
        sessionId: input.sessionId,
      },
    };
  }

  async release(handle: PairAgentHandle): Promise<void> {
    const owned = this.#pairHandles.get(handle);
    if (owned === undefined) return;
    if (this.#handles.get(handle.sessionId) !== owned) return;
    await this.#disposeOwned(owned, 'release');
    this.#forgetOwnedPairHandle(handle, owned);
  }

  async auditPairRequests(input: {
    pairId: PairId;
    sessions: Readonly<Record<PairRole, PairAgentHandle>>;
  }): Promise<void> {
    this.#assertOpen();
    const pairId = parsePairId(input.pairId);
    const expected = createPairSessionIds(pairId);
    const owned = new Map<PairRole, DshOwnedAgentHandle>();
    for (const role of ['navigator', 'pilot'] as const) {
      const pairHandle = input.sessions[role];
      const dshHandle = this.#pairHandles.get(pairHandle);
      const expectedSessionId =
        role === 'navigator' ? expected.navigatorSessionId : expected.pilotSessionId;
      if (
        dshHandle === undefined ||
        pairHandle.sessionId !== expectedSessionId ||
        dshHandle.agent.session.id !== expectedSessionId
      ) {
        throw new PairRequestBindingError(
          `Pair-level audit lacks the authoritative ${role} Session`,
        );
      }
      owned.set(role, dshHandle);
    }

    const events = await this.options.store.read(pairId);
    const requests = validatePairRequestCoordinates(pairId, events);

    const consumed = new Set<number>();
    for (const event of requests) {
      const snapshot = durableRequestSnapshot(event);
      const role = snapshot.role as PairRole;
      const session = owned.get(role)!.agent.session;
      const plugin = new PairRequestPlugin({
        store: this.options.store,
        binding: { pairId, role, sessionId: session.id },
        materialRegistry: this.requestMaterials,
      });
      const count = await this.#auditHistoricalRequests(
        pairId,
        role,
        session,
        plugin,
        (event.payload as Record<string, unknown>).requestId as string,
      );
      if (count !== 1 || consumed.has(event.seq)) {
        throw new PairRequestBindingError(
          `Pair request snapshot at ledger seq ${event.seq} was not consumed exactly once`,
        );
      }
      consumed.add(event.seq);
    }
    if (consumed.size !== requests.length) {
      throw new PairRequestBindingError('Pair request audit left unconsumed snapshots');
    }
  }

  async catchUpPair(input: {
    pairId: PairId;
    sessions: Readonly<Record<PairRole, PairAgentHandle>>;
    recovery: boolean;
  }): Promise<void> {
    const bridge = this.#requireBridge();
    for (const role of ['navigator', 'pilot'] as const) {
      const handle = input.sessions[role];
      const owned = this.#pairHandles.get(handle);
      const observed = this.#observedSessions.get(handle.sessionId);
      if (
        owned === undefined ||
        observed === undefined ||
        observed.pairId !== input.pairId ||
        observed.role !== role ||
        observed.live !== owned.agent.session
      ) {
        throw new PairRequestBindingError(
          `Pair Bridge lacks the authoritative ${role} Session identity`,
        );
      }
    }
    if (input.recovery) await bridge.recoverPair(input.pairId);
    else await bridge.catchUpPair(input.pairId);
  }

  async cleanupFailedPair(input: {
    pairId: PairId;
    sessions: readonly PairAgentHandle[];
  }): Promise<void> {
    const bridge = this.#requireBridge();
    this.#failedCleanupPairs.add(input.pairId);
    await bridge.suspendPair(input.pairId);
    const owned = input.sessions.flatMap((handle) => {
      const dshHandle = this.#pairHandles.get(handle);
      return dshHandle === undefined ? [] : [{ pairHandle: handle, dshHandle }];
    });
    const settled = await Promise.allSettled(
      owned.map(({ dshHandle }) => this.#disposeOwned(dshHandle, 'release')),
    );
    const failures = settled.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    try {
      await bridge.drainDisposedPair(input.pairId);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `DSH adapter could not dispose and drain failed Pair ${input.pairId}`,
      );
    }
    for (const { pairHandle, dshHandle } of owned) {
      this.#forgetOwnedPairHandle(pairHandle, dshHandle);
    }
    this.#failedCleanupPairs.delete(input.pairId);
  }

  assertPairHealthy(pairId: PairId): void {
    for (const observed of this.#observedSessions.values()) {
      if (observed.pairId === pairId && observed.fault !== undefined) {
        throw observed.fault;
      }
    }
    this.#requireBridge().assertHealthy(pairId);
  }

  async followup(input: FollowupInput): Promise<void> {
    this.#assertOpen();
    const binding = this.#bindings.get(input.sessionId);
    const handle = this.#handles.get(input.sessionId);
    if (binding === undefined || handle === undefined) {
      throw new PairRequestBindingError(`Unknown DSH Pair session ${input.sessionId}`);
    }
    const accepted = this.#deliveries.get(input.sessionId)!;
    if (accepted.has(input.deliveryId)) return;
    const messageInput = createPairDeliveryMessageInput(
      input.deliveryId,
      input.trigger,
    );
    const message = this.modules.createUserMessage(messageInput);
    accepted.add(input.deliveryId);
    try {
      handle.agent.followup(message);
    } catch (error) {
      accepted.delete(input.deliveryId);
      throw error;
    }
    // Admission is intentionally the Promise boundary. Waiting for Provider
    // completion here would hold PairRegistry's command mutation queue while
    // request-layout performs its own durable CAS append.
  }

  async whenIdle(sessionId: string): Promise<void> {
    const handle = this.#handles.get(sessionId);
    if (handle === undefined) {
      throw new PairRequestBindingError(`Unknown DSH Pair session ${sessionId}`);
    }
    await handle.agent.whenIdle();
    await this.context.sessions.flush(handle.agent.session);
    await this.#bridge?.whenCaughtUp([sessionId]);
  }

  captureRequests(): readonly CapturedProviderRequest[] {
    return structuredClone(this.#captures);
  }

  exportRequestMaterials(): readonly PairRequestMaterialEntry[] {
    return this.requestMaterials.export();
  }

  sessionArtifact(sessionId: string): DshSessionArtifact {
    const artifact = this.#artifacts.get(sessionId);
    if (artifact === undefined) {
      throw new PairRequestBindingError(`Unknown DSH Pair session ${sessionId}`);
    }
    return { ...artifact };
  }

  sessionEvents(sessionId: string): readonly JsonObject[] {
    const handle = this.#handles.get(sessionId);
    if (handle === undefined) {
      throw new PairRequestBindingError(`Unknown DSH Pair session ${sessionId}`);
    }
    return structuredClone(handle.agent.session.events);
  }

  ownedHandleCount(): number {
    return this.#handles.size;
  }

  orphanHandleCount(): number {
    return this.#orphans.size;
  }

  async rebuildRequestDigest(requestId: string): Promise<string> {
    for (const [sessionId, binding] of this.#bindings) {
      const events = await this.options.store.read(binding.pairId);
      const requestEvent = events.find((event) => {
        if (event.type !== 'pair.request_built') return false;
        return (event.payload as Record<string, unknown>).requestId === requestId;
      });
      if (requestEvent === undefined) continue;
      const snapshot = (requestEvent.payload as Record<string, unknown>)
        .snapshot as Record<string, unknown> | undefined;
      if (snapshot?.sessionId !== sessionId) continue;
      const handle = this.#handles.get(sessionId);
      if (handle === undefined) {
        throw new PairRequestBindingError(`Session ${sessionId} is not resumed`);
      }
      const plugin = new PairRequestPlugin({
        store: this.options.store,
        binding: { pairId: binding.pairId, role: binding.role, sessionId },
        materialRegistry: this.requestMaterials,
      });
      await this.#auditHistoricalRequests(
        binding.pairId,
        binding.role,
        handle.agent.session,
        plugin,
        requestId,
      );
      return snapshot.fullRequestDigest as string;
    }
    throw new PairRequestBindingError(`Unknown historical request ${requestId}`);
  }

  async #auditHistoricalRequests(
    pairId: PairId,
    role: PairRole,
    session: DshSession,
    plugin: PairRequestPlugin,
    onlyRequestId?: string,
  ): Promise<number> {
    const pairEvents = await this.options.store.read(pairId);
    let consumed = 0;
    for (const event of pairEvents) {
      if (event.type !== 'pair.request_built') continue;
      const payload = jsonRecord(event.payload)!;
      const snapshot = durableRequestSnapshot(event);
      if (snapshot.sessionId !== session.id) continue;
      if (onlyRequestId !== undefined && payload.requestId !== onlyRequestId) continue;
      if (
        snapshot.role !== role ||
        typeof payload.requestId !== 'string' ||
        typeof snapshot.turn !== 'number' ||
        typeof snapshot.step !== 'number' ||
        typeof snapshot.attempt !== 'number' ||
        typeof snapshot.sourceLedgerHead !== 'number' ||
        typeof snapshot.localSurfaceThroughSeq !== 'number' ||
        typeof snapshot.promptVersion !== 'string' ||
        typeof snapshot.toolSetVersion !== 'string' ||
        typeof snapshot.requestConfigVersion !== 'string'
      ) {
        throw new PairRequestBindingError(
          `Pair request snapshot at ledger seq ${event.seq} has invalid reconstruction coordinates`,
        );
      }
      const materials = this.requestMaterials.resolve({
        promptVersion: snapshot.promptVersion,
        toolSetVersion: snapshot.toolSetVersion,
        requestConfigVersion: snapshot.requestConfigVersion,
      });
      const through = snapshot.localSurfaceThroughSeq;
      const sourceLedgerHead = snapshot.sourceLedgerHead as number;
      const sessionEvents = session.events.filter((candidate) => {
        const seq = candidate.seq;
        return typeof seq === 'number' && seq <= through;
      });
      const surface = this.modules.foldSurface(sessionEvents);
      const messages = surface.nodes.flatMap((seq) => {
        const source = sessionEvents.find((candidate) => candidate.seq === seq);
        if (source === undefined) {
          throw new PairRequestBindingError(
            `DSH Session ${session.id} cannot rebuild surface seq ${seq}`,
          );
        }
        const message = this.modules.deriveEventMessage(source);
        return message === null ? [] : [message];
      });
      const rebuilt = plugin.rebuild(
        {
          agent: {
            id: session.id,
            session: {
              id: session.id,
              events: sessionEvents as never,
              surface: { nodes: surface.nodes },
            },
          },
          sessionId: session.id,
          turn: snapshot.turn,
          step: snapshot.step,
          attempt: snapshot.attempt,
          config: materials.config,
          system: materials.commonSystem.content,
          tools: materials.tools,
          messages,
          signal: new AbortController().signal,
        },
        payload.requestId,
        pairEvents.filter((candidate) => candidate.seq <= sourceLedgerHead),
        materials,
      );
      if (
        canonicalJsonStringify(payload.manifest) !==
          canonicalJsonStringify(rebuilt.manifest) ||
        canonicalJsonStringify(snapshot) !== canonicalJsonStringify(rebuilt.snapshot)
      ) {
        throw new PairRequestBindingError(
          `Pair request snapshot at ledger seq ${event.seq} failed historical reconstruction audit`,
        );
      }
      consumed += 1;
    }
    return consumed;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    let closing!: Promise<void>;
    closing = (async () => {
      this.#requestHandoffs.clear();
      const bridge = this.#bridge;
      const pairIds = new Set(
        [...this.#observedSessions.values()].map((binding) => binding.pairId),
      );
      if (bridge !== undefined && !this.#closeDrainSuspended) {
        await Promise.all(
          [...this.#handles.values()]
            .filter((handle) => !this.#disposedHandles.has(handle))
            .map((handle) => handle.agent.whenIdle()),
        );
        for (const pairId of pairIds) {
          if (this.#failedCleanupPairs.has(pairId)) continue;
          await bridge.drainPair(pairId);
          await bridge.suspendPair(pairId);
        }
        this.#closeDrainSuspended = true;
      }
      if (!this.#closeAgentsDisposed) {
        const handles = [...new Set([...this.#handles.values(), ...this.#orphans])];
        const settled = await Promise.allSettled(
          handles.map((handle) => this.#disposeOwned(handle, 'close')),
        );
        const failures = settled.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        for (let index = 0; index < handles.length; index += 1) {
          if (settled[index]?.status !== 'fulfilled') continue;
          const handle = handles[index]!;
          this.#orphans.delete(handle);
          for (const [sessionId, live] of this.#handles) {
            if (live !== handle) continue;
            this.#handles.delete(sessionId);
            this.#prepared.delete(sessionId);
            this.#bindings.delete(sessionId);
            this.#deliveries.delete(sessionId);
            this.#artifacts.delete(sessionId);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'DSH adapter could not dispose every owned Agent during close',
          );
        }
        this.#closeAgentsDisposed = true;
      }
      if (bridge !== undefined) {
        for (const pairId of pairIds) {
          await bridge.drainDisposedPair(pairId);
          this.#failedCleanupPairs.delete(pairId);
        }
        await bridge.close();
        this.#bridge = undefined;
      }
      this.#observationOff?.();
      this.#observationOff = undefined;
      this.#observedSessions.clear();
      this.#sessionEventListeners.clear();
      if (this.ownsContext) await this.context.fiber.dispose();
    })().catch((error: unknown) => {
      if (this.#closePromise === closing) this.#closePromise = undefined;
      throw error;
    });
    this.#closePromise = closing;
    return closing;
  }

  #createCaptureProvider(): object {
    const owner = this;
    const Base = this.modules.LlmAdapter;
    return new (class extends Base {
      override resolveModel(provider: string, model: string): Promise<JsonObject> {
        return Promise.resolve({ provider, id: model, name: model });
      }

      async *stream(request: Record<string, unknown>): AsyncIterable<JsonObject> {
        if ('attempt' in request) {
          throw new PairRequestBindingError(
            'DSH unexpectedly exposed an attempt field; exact handoff assumptions must be re-audited',
          );
        }
        const sessionId = request.sessionId;
        if (typeof sessionId !== 'string') {
          throw new PairRequestBindingError('Capture Provider request lacks sessionId');
        }
        const binding = owner.#bindings.get(sessionId);
        if (binding === undefined) {
          throw new PairRequestBindingError('Capture Provider received an unbound session');
        }
        const live = owner.#handles.get(sessionId);
        if (live === undefined) {
          throw new PairRequestBindingError('Capture Provider received a Session without a live Agent');
        }
        owner.#assertToolCatalog(live.agent);
        const messages = request.messages as readonly DshMessage[];
        const tools = request.tools as readonly JsonObject[] | undefined;
        const config = requestConfig(request);
        const fullRequestDigest = sha256Request({
          ...(request.system === undefined ? {} : { system: request.system as string }),
          messages,
          ...(tools === undefined ? {} : { tools }),
          config,
        });
        const handoff = owner.#requestHandoffs.claim(sessionId);
        if (handoff === undefined) {
          throw new PairRequestBindingError(
            'Provider call has no exact durable PairRequestSnapshot handoff',
          );
        }
        if (handoff.fullRequestDigest !== fullRequestDigest) {
          throw new PairRequestBindingError(
            `Provider request does not match its durable snapshot ${handoff.requestId}`,
          );
        }
        const events = await owner.options.store.read(binding.pairId);
        const persisted = events.find(
          (event) => event.seq === handoff.snapshotLedgerSeq,
        );
        if (persisted === undefined) {
          throw new PairRequestBindingError('Provider snapshot handoff is not durable');
        }
        const persistedPayload = jsonRecord(persisted.payload);
        const persistedSnapshot = durableRequestSnapshot(persisted);
        if (
          persistedPayload?.requestId !== handoff.requestId ||
          persistedSnapshot.fullRequestDigest !== handoff.fullRequestDigest
        ) {
          throw new PairRequestBindingError(
            'Provider snapshot handoff does not match its exact persisted ledger event',
          );
        }
        const providerStartedAtLedgerHead = events.at(-1)?.seq ?? 0;
        owner.#captures.push({
          provider: request.provider as string,
          model: request.model as string,
          sessionId,
          ...(request.system === undefined ? {} : { system: request.system as string }),
          messages: structuredClone(messages),
          ...(tools === undefined ? {} : { tools: structuredClone(tools) }),
          fullRequestDigest,
          snapshotLedgerSeq: persisted.seq,
          providerStartedAtLedgerHead,
        });
        const response = owner.#takeCaptureResponse(sessionId);
        if (response === undefined) {
          throw new Error(
            owner.captureQueues.bySession === undefined
              ? 'Capture Provider response script exhausted'
              : `Capture Provider response script exhausted for Session ${sessionId}`,
          );
        }
        if (typeof response === 'string') {
          for (const chunk of textResponse(response)) yield chunk;
          return;
        }
        if ('failure' in response) {
          yield {
            type: 'finish',
            reason: { kind: 'error', failure: response.failure },
          };
          return;
        }
        const args = canonicalJsonStringify(response.toolCall.arguments);
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield {
          type: 'tool-call-delta',
          index: 0,
          id: response.toolCall.id,
          name: response.toolCall.name,
          argumentsDelta: args,
        };
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: response.toolCall.id,
            name: response.toolCall.name,
            arguments: args,
          },
        };
        yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    })();
  }

  #assertOpen(): void {
    if (this.#closed) throw new DshAdapterClosedError();
  }

  #takeCaptureResponse(sessionId: string): CaptureProviderResponse | undefined {
    const bySession = this.captureQueues.bySession;
    if (bySession === undefined) return this.captureQueues.global?.shift();
    const queue = bySession.get(sessionId);
    if (queue === undefined) {
      throw new PairRequestBindingError(
        `Capture Provider has no response script for Session ${sessionId}`,
      );
    }
    return queue.shift();
  }

  #installObservationHook(): void {
    if (this.#observationOff !== undefined) {
      throw new PairRequestBindingError('DSH Session observation hook is already installed');
    }
    this.#observationOff = this.context.on('session/event', (session, rawEvent) => {
      const observed = this.#observedSessions.get(session.id);
      if (observed === undefined) return;
      const event = rawEvent as unknown as DshSessionEvent;
      if (observed.live === undefined) {
        if (
          observed.pendingSession !== undefined &&
          observed.pendingSession !== session
        ) {
          observed.fault = new PairRequestBindingError(
            `DSH Session ${session.id} reused a provisional ID with a different object`,
          );
        }
        observed.pendingSession = session;
        observed.pending = true;
        return;
      }
      if (observed.live !== session) {
        observed.fault = new PairRequestBindingError(
          `DSH Session ${session.id} reused a bound ID with a different live object`,
        );
      }
      for (const listener of this.#sessionEventListeners) {
        listener(session.id, event);
      }
    });
  }

  #bindProvisional(input: PreparePairAgentInput, pairId: PairId): void {
    const bridge = this.#requireBridge();
    if (this.#observedSessions.has(input.sessionId)) {
      throw new PairRequestBindingError(
        `DSH Pair Session ${input.sessionId} already has an observation binding`,
      );
    }
    bridge.bindSession(pairId, input.role, input.sessionId);
    this.#observedSessions.set(input.sessionId, {
      pairId,
      role: input.role,
      sessionId: input.sessionId,
      pending: false,
    });
  }

  #confirmLiveSession(sessionId: string, session: DshSession): void {
    const observed = this.#requireObservedSession(sessionId);
    if (session.id !== sessionId) {
      throw new PairRequestBindingError('DSH Session live identity does not match its binding');
    }
    if (observed.live !== undefined && observed.live !== session) {
      throw new PairRequestBindingError(
        `DSH Pair Session ${sessionId} changed live object identity`,
      );
    }
    if (
      observed.pendingSession !== undefined &&
      observed.pendingSession !== session
    ) {
      throw new PairRequestBindingError(
        `DSH Pair Session ${sessionId} provisional identity did not become live`,
      );
    }
    if (observed.fault !== undefined) throw observed.fault;
    observed.live = session;
    observed.pendingSession = undefined;
    const retained = observed.pending;
    observed.pending = false;
    if (retained) this.#requireBridge().markDirty(sessionId);
  }

  #removeObservedSession(sessionId: string): void {
    const observed = this.#observedSessions.get(sessionId);
    if (observed === undefined) return;
    this.#observedSessions.delete(sessionId);
    try {
      this.#bridge?.unbindSession(sessionId);
    } catch {
      this.#observedSessions.set(sessionId, observed);
    }
  }

  #forgetOwnedPairHandle(
    pairHandle: PairAgentHandle,
    owned: DshOwnedAgentHandle,
  ): void {
    const { sessionId } = pairHandle;
    this.#removeObservedSession(sessionId);
    this.#pairHandles.delete(pairHandle);
    if (this.#handles.get(sessionId) !== owned) return;
    this.#handles.delete(sessionId);
    this.#prepared.delete(sessionId);
    this.#bindings.delete(sessionId);
    this.#deliveries.delete(sessionId);
    this.#artifacts.delete(sessionId);
    this.#orphans.delete(owned);
    this.#disposedHandles.delete(owned);
  }

  #requireObservedSession(sessionId: string): DshObservedPairSession {
    const observed = this.#observedSessions.get(sessionId);
    if (observed === undefined) {
      throw new PairRequestBindingError(`Unknown observed DSH Pair Session ${sessionId}`);
    }
    return observed;
  }

  #requireBridge(): SessionToPairBridge {
    if (this.#bridge === undefined) {
      throw new PairRequestBindingError(
        'Pair Bridge must be attached before preparing Agents',
      );
    }
    return this.#bridge;
  }

  #openTurn(session: DshSession): number {
    const start = session.events.findLast((event) => event.type === 'turn/start');
    const data = jsonRecord(start?.data);
    const turn = data?.turn;
    if (!Number.isSafeInteger(turn) || (turn as number) <= 0) {
      throw new PairRequestBindingError(
        'Peer Message tool execution is outside an open DSH Turn',
      );
    }
    const ended = session.events.some((event) => {
      const end = jsonRecord(event.data);
      return event.type === 'turn/end' && end?.turn === turn;
    });
    if (ended) {
      throw new PairRequestBindingError(
        'Peer Message tool execution references a closed DSH Turn',
      );
    }
    return turn as number;
  }

  #assertToolCatalog(scope?: unknown): void {
    assertExactToolCatalog(
      this.context.tools.schemas(scope),
      this.expectedToolSchemas,
      scope === undefined ? 'global' : 'Pair Agent scope',
    );
  }

  async #disposeOwned(
    handle: DshOwnedAgentHandle,
    reason: 'rollback' | 'release' | 'close',
  ): Promise<void> {
    if (this.#disposedHandles.has(handle)) return;
    await this.options.lifecycleFaults?.beforeDispose?.(reason);
    await handle.dispose();
    this.#disposedHandles.add(handle);
  }
}

function validateWebRuntimeOptions(options: DshPairWebRuntimeOptions): void {
  if (!isAbsolute(options.dataRoot)) {
    throw new TypeError('DSH Web dataRoot must be an explicit absolute path');
  }
  if (
    options.web.host !== '127.0.0.1' ||
    !Number.isSafeInteger(options.web.port) ||
    options.web.port < 0 ||
    options.web.port > 65_535
  ) {
    throw new TypeError('DSH Web host must be 127.0.0.1 and port must be 0..65535');
  }
  if ((options.capture === undefined) === (options.openai === undefined)) {
    throw new TypeError(
      'Exactly one DSH Provider mode must be configured: capture or openai',
    );
  }
  if (options.lifecycleFaults !== undefined && options.capture === undefined) {
    throw new TypeError('lifecycleFaults are allowed only with the capture Provider');
  }
}

let dshHomeBootTail: Promise<void> = Promise.resolve();

async function withProcessDshHome<T>(
  harnessHome: string,
  entered: (() => Promise<void> | void) | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = dshHomeBootTail;
  let release!: () => void;
  dshHomeBootTail = new Promise<void>((resolveTail) => { release = resolveTail; });
  await predecessor;
  const previousDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = harnessHome;
  try {
    await entered?.();
    return await operation();
  } finally {
    if (previousDshHome === undefined) Reflect.deleteProperty(process.env, 'DSH_HOME');
    else process.env.DSH_HOME = previousDshHome;
    release();
  }
}

async function createSafePreset(root: string): Promise<string> {
  const presetRoot = join(root, 'agent-presets');
  const presetDirectory = join(presetRoot, 'pair-safe');
  await mkdir(presetDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      join(presetDirectory, 'preset.yml'),
      'name: Pair Safe\ndescription: Pair Agent Phase 0 harmless-tool-only preset.\norder: 1\n',
      { flag: 'w' },
    ),
    writeFile(
      join(presetDirectory, 'agent.cordis.yml'),
      [
        '# Pair Phase 0 intentionally contributes no shell, filesystem, network, workflow, or delegation tools.',
        '[]',
        '',
      ].join('\n'),
      { flag: 'w' },
    ),
  ]);
  return presetRoot;
}

export async function launchDshPairWebRuntime(
  options: DshPairWebRuntimeOptions,
): Promise<DshPairWebRuntime> {
  validateWebRuntimeOptions(options);
  await mkdir(options.dataRoot, { recursive: true });
  const dataRoot = await realpath(options.dataRoot);
  const sessionRoot = join(dataRoot, 'dsh-sessions');
  const storageRoot = join(dataRoot, 'dsh-storage');
  const harnessHome = join(dataRoot, 'dsh-home');
  const profileRoot = join(harnessHome, 'profiles', 'pair-agent');
  await Promise.all([
    mkdir(sessionRoot, { recursive: true }),
    mkdir(storageRoot, { recursive: true }),
    mkdir(harnessHome, { recursive: true }),
    mkdir(profileRoot, { recursive: true }),
  ]);
  const safePresetRoot = await createSafePreset(dataRoot);
  const rootConfig = join(profileRoot, 'cordis.yml');
  await writeFile(rootConfig, '[]\n', { flag: 'w' });

  const modules = await loadVerifiedDshModules(options.source);
  modules.healProfilesModuleFallback(
    join(modules.sourceRoot, 'apps/cli/package.json'),
    harnessHome,
  );
  const basePatches = modules.loadOverlayPatches(
    'pair-agent web runtime',
    join(modules.sourceRoot, 'packages/bundle/base/cordis.patch.yml'),
  );
  const webPatches = modules.loadOverlayPatches(
    'pair-agent web runtime',
    join(modules.sourceRoot, 'packages/bundle/web-app/cordis.patch.yml'),
  );
  const overlays = [
    ...basePatches,
    ...webPatches,
    {
      id: 'agent-presets',
      config: {
        default: 'pair-safe',
        roots: [{ path: safePresetRoot, trust: 'system' }],
        includeUserRoot: false,
      },
    },
    {
      id: 'session-persistence-jsonl',
      config: { root: sessionRoot, compression: 'none', packChunks: false },
    },
    { id: 'storage-json', config: { root: storageRoot } },
    { id: 'settings', config: { dshHome: harnessHome } },
    { id: 'credentials', config: { dshHome: harnessHome } },
    { id: 'attachment-local', config: { dshHome: harnessHome } },
    { id: 'session-query-sqlite', config: { path: ':memory:', openAt: 'never' } },
    { id: 'sandbox-policy', config: { mode: 'read-only', workspaceRoot: dataRoot } },
    { id: 'fs-sandbox', config: { cwd: dataRoot } },
    { id: 'session-title-llm', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'llm-deepseek', disabled: true },
    { id: 'llm-pi-ai', disabled: true },
    { id: 'web-search-deepseek', disabled: true },
    {
      id: 'agent-default-model',
      config: { provider: options.provider, model: options.model },
    },
    {
      id: 'webserver',
      config: { host: options.web.host, port: options.web.port },
    },
    {
      id: 'web-runtime',
      config: {
        openBrowser: false,
        printUrl: false,
        surfaceContext: false,
        trustedHosts: [],
      },
    },
  ] as const;

  const context = await withProcessDshHome(
    harnessHome,
    options.lifecycleFaults?.afterHostedHomeSet === undefined
      ? undefined
      : () => options.lifecycleFaults!.afterHostedHomeSet!(harnessHome),
    async () => modules.boot(
      'pair-agent web runtime',
      rootConfig,
      overlays,
      (bootContext) => {
        modules.provideCmdline(bootContext, {
          args: [],
          exit(code) {
            throw new Error(`DSH Web composition requested unexpected exit ${String(code)}`);
          },
        });
      },
    ),
  );

  const disposeContext = async (): Promise<void> => {
    options.lifecycleFaults?.beforeHostedContextDispose?.();
    await context.fiber.dispose();
  };

  try {
    const webServer = context.get('webServer') as
      | { readonly host: string; readonly port: number }
      | undefined;
    if (
      webServer === undefined ||
      webServer.host !== options.web.host ||
      !Number.isSafeInteger(webServer.port) ||
      webServer.port <= 0
    ) {
      throw new PairRequestBindingError('DSH Web composition did not expose its bound Host');
    }
    const extraTool = options.lifecycleFaults?.hostedExtraTool;
    if (extraTool !== undefined) {
      context.tools.register(modules.defineContentToolFixture(extraTool));
    }
    const adapter = await DshPairAgentAdapter.createOnHostedContext(
      { ...options, sessionRoot },
      modules,
      context,
    );
    let closePromise: Promise<void> | undefined;
    let adapterClosed = false;
    let contextClosed = false;
    return {
      adapter,
      context,
      origin: `http://${options.web.host}:${String(webServer.port)}`,
      paths: { dataRoot, sessionRoot, storageRoot, harnessHome },
      close() {
        if (adapterClosed && contextClosed) return Promise.resolve();
        if (closePromise !== undefined) return closePromise;
        const attempt = (async () => {
          const failures: unknown[] = [];
          if (!adapterClosed) {
            try {
              await adapter.close();
              adapterClosed = true;
            } catch (error) {
              failures.push(error);
            }
          }
          if (adapterClosed && !contextClosed) {
            try {
              await disposeContext();
              contextClosed = true;
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length > 0) {
            throw new AggregateError(failures, 'Hosted DSH runtime cleanup failed');
          }
        })();
        closePromise = attempt;
        void attempt.finally(() => {
          if (closePromise === attempt) closePromise = undefined;
        }).catch(() => undefined);
        return attempt;
      },
    };
  } catch (error) {
    try {
      await disposeContext();
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        'DSH Web startup and cleanup both failed',
      );
    }
    throw error;
  }
}

interface PendingRequestHandoff {
  readonly request: PersistedPairRequest;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

export class PendingRequestHandoffs {
  readonly #queues = new Map<string, PendingRequestHandoff[]>();

  enqueue(
    sessionId: string,
    request: PersistedPairRequest,
    signal: AbortSignal,
  ): void {
    if (signal.aborted) return;
    let entry!: PendingRequestHandoff;
    entry = {
      request,
      signal,
      onAbort: () => this.#remove(sessionId, entry),
    };
    const queue = this.#queues.get(sessionId) ?? [];
    queue.push(entry);
    this.#queues.set(sessionId, queue);
    signal.addEventListener('abort', entry.onAbort, { once: true });
  }

  claim(sessionId: string): PersistedPairRequest | undefined {
    const queue = this.#queues.get(sessionId);
    while (queue !== undefined && queue.length > 0) {
      const entry = queue.shift()!;
      entry.signal.removeEventListener('abort', entry.onAbort);
      if (entry.signal.aborted) continue;
      if (queue.length === 0) this.#queues.delete(sessionId);
      return entry.request;
    }
    this.#queues.delete(sessionId);
    return undefined;
  }

  clear(): void {
    for (const [sessionId, queue] of this.#queues) {
      for (const entry of [...queue]) this.#remove(sessionId, entry);
    }
  }

  #remove(sessionId: string, entry: PendingRequestHandoff): void {
    entry.signal.removeEventListener('abort', entry.onAbort);
    const queue = this.#queues.get(sessionId);
    if (queue === undefined) return;
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.#queues.delete(sessionId);
  }
}

function sha256Request(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJsonStringify(value as JsonObject), 'utf8')
    .digest('hex')}`;
}

export { PairRequestBindingError } from './pair-request-plugin.js';
