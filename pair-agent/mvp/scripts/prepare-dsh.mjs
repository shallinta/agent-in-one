import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { devNull } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SUPPORTED_NODE_PATTERN = /^>=(\d+)\.(\d+)\.(\d+)$/;
const FLOATING_REF_FIELDS = ['branch', 'ref', 'revision', 'upstreamRef'];
const PATCH_DIRECTORY = join('patches', 'deepseek-harness');
const RUNTIME_ARTIFACT_ROOTS = ['apps', 'native', 'packages', 'vendor'];
const PATCH_COMMITTER_ENV = {
  GIT_COMMITTER_NAME: 'Pair Agent DSH Patch Applicator',
  GIT_COMMITTER_EMAIL: 'pair-agent-dsh@example.invalid',
};
const HERMETIC_GIT_ENV = {
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: devNull,
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const defaultProjectDirectory = resolve(scriptDirectory, '..');
export const defaultCheckoutDirectory = join(
  defaultProjectDirectory,
  '.runtime',
  'deepseek-harness',
);

/** @param {unknown} value */
function assertObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('DSH source lock must be a JSON object');
  }
}

/**
 * @param {unknown} lockValue
 * @param {unknown} packageValue
 */
export function validateSourceLock(lockValue, packageValue) {
  assertObject(lockValue);
  assertObject(packageValue);

  const lock = /** @type {Record<string, unknown>} */ (lockValue);
  const packageJson = /** @type {Record<string, unknown>} */ (packageValue);

  for (const field of FLOATING_REF_FIELDS) {
    if (field in lock) {
      throw new Error(`Floating ref field "${field}" is not allowed in dsh.lock.json`);
    }
  }

  if (
    typeof lock.upstreamRepository !== 'string' ||
    lock.upstreamRepository.trim() === ''
  ) {
    throw new Error('upstreamRepository must be a non-empty repository URL or path');
  }
  if (
    typeof lock.sourceRepository !== 'string' ||
    lock.sourceRepository.trim() === ''
  ) {
    throw new Error('sourceRepository must be a non-empty repository identity');
  }
  if (lock.requestLayoutSeamVersion !== 1) {
    throw new Error('requestLayoutSeamVersion must be 1');
  }
  if (typeof lock.tag !== 'string' || lock.tag.trim() === '') {
    throw new Error('tag must be a non-empty release tag');
  }
  if (
    typeof lock.upstreamCommit !== 'string' ||
    !FULL_SHA_PATTERN.test(lock.upstreamCommit)
  ) {
    throw new Error('upstreamCommit must be a lowercase 40-character commit SHA');
  }
  if (
    typeof lock.expectedDerivedCommit !== 'string' ||
    !FULL_SHA_PATTERN.test(lock.expectedDerivedCommit)
  ) {
    throw new Error('expectedDerivedCommit must be a lowercase 40-character commit SHA');
  }
  if (
    typeof lock.supportedNode !== 'string' ||
    !SUPPORTED_NODE_PATTERN.test(lock.supportedNode)
  ) {
    throw new Error('supportedNode must be an exact minimum range such as >=22.19.0');
  }
  if (
    typeof lock.pnpmVersion !== 'string' ||
    !VERSION_PATTERN.test(lock.pnpmVersion)
  ) {
    throw new Error('pnpmVersion must be an exact semantic version');
  }
  if (packageJson.packageManager !== `pnpm@${lock.pnpmVersion}`) {
    throw new Error(
      `Package manager must be exactly pnpm@${lock.pnpmVersion}; received ${String(packageJson.packageManager)}`,
    );
  }
  if (!Array.isArray(lock.patchSeries)) {
    throw new Error('patchSeries must be an ordered array');
  }
  if (
    lock.patchSeries.some((entry) => typeof entry !== 'string' || entry === '') ||
    new Set(lock.patchSeries).size !== lock.patchSeries.length
  ) {
    throw new Error('patchSeries entries must be unique non-empty strings');
  }
  if (
    lock.patchSeries.length === 0 &&
    lock.expectedDerivedCommit !== lock.upstreamCommit
  ) {
    throw new Error('An empty patchSeries must derive exactly the upstream commit');
  }
  const runtimeArtifacts = lock.runtimeArtifacts;
  if (
    runtimeArtifacts === null ||
    typeof runtimeArtifacts !== 'object' ||
    Array.isArray(runtimeArtifacts)
  ) {
    throw new Error('runtime artifacts must be a lock object');
  }
  const artifactLock = /** @type {Record<string, unknown>} */ (runtimeArtifacts);
  if (
    artifactLock.schemaVersion !== 1 ||
    artifactLock.buildProfile !== 'official' ||
    artifactLock.include !== 'lib/**/*.{js,cjs,mjs}' ||
    !Number.isSafeInteger(artifactLock.fileCount) ||
    /** @type {number} */ (artifactLock.fileCount) <= 0
  ) {
    throw new Error('runtime artifacts require schema v1, official profile, executable lib include and positive file count');
  }
  if (
    !Array.isArray(artifactLock.roots) ||
    artifactLock.roots.length !== RUNTIME_ARTIFACT_ROOTS.length ||
    artifactLock.roots.some(
      (entry, index) => entry !== RUNTIME_ARTIFACT_ROOTS[index],
    )
  ) {
    throw new Error('runtime artifact roots must be apps, native, packages and vendor');
  }
  if (
    typeof artifactLock.digest !== 'string' ||
    !SHA256_PATTERN.test(artifactLock.digest)
  ) {
    throw new Error('runtime artifact digest must be a sha256 value');
  }

  return lock;
}

/**
 * @param {string} supportedRange
 * @param {string} [nodeVersion]
 */
export function assertSupportedNode(supportedRange, nodeVersion = process.versions.node) {
  const match = SUPPORTED_NODE_PATTERN.exec(supportedRange);
  if (!match) {
    throw new Error(`Unsupported Node range syntax: ${supportedRange}`);
  }
  const minimum = match.slice(1).map(Number);
  const actual = nodeVersion.replace(/^v/, '').split('.').slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > minimum[index]) return;
    if (actual[index] < minimum[index]) {
      throw new Error(`Node ${nodeVersion} does not satisfy ${supportedRange}`);
    }
  }
}

/**
 * @param {string} projectDirectory
 * @param {string[]} patchSeries
 */
export function resolvePatchPaths(projectDirectory, patchSeries) {
  const projectRoot = resolve(projectDirectory);
  const patchRoot = resolve(projectRoot, PATCH_DIRECTORY);
  const patchRootFromProject = relative(projectRoot, patchRoot);
  if (
    patchRootFromProject === '..' ||
    patchRootFromProject.startsWith(`..${sep}`) ||
    isAbsolute(patchRootFromProject)
  ) {
    throw new Error('Lexical patch root must remain inside the project');
  }

  const lexicalPatchPaths = patchSeries.map((entry) => {
    if (
      isAbsolute(entry) ||
      !entry.startsWith('patches/deepseek-harness/') ||
      !entry.endsWith('.patch')
    ) {
      throw new Error(
        `Patch path must be a .patch file inside patches/deepseek-harness: ${entry}`,
      );
    }

    const patchPath = resolve(projectDirectory, entry);
    const fromPatchRoot = relative(patchRoot, patchPath);
    if (
      fromPatchRoot === '' ||
      fromPatchRoot === '..' ||
      fromPatchRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromPatchRoot)
    ) {
      throw new Error(`Patch path escapes patches/deepseek-harness: ${entry}`);
    }
    return { entry, patchPath };
  });

  if (lexicalPatchPaths.length === 0) return [];

  const expectedRealPatchRoot = resolve(realpathSync(projectRoot), PATCH_DIRECTORY);
  const realPatchRoot = realpathSync(patchRoot);
  if (realPatchRoot !== expectedRealPatchRoot) {
    throw new Error('Patch root realpath must remain inside the project allowlist');
  }

  return lexicalPatchPaths.map(({ entry, patchPath }) => {
    if (!existsSync(patchPath) || !statSync(patchPath).isFile()) {
      throw new Error(`Patch file does not exist: ${entry}`);
    }

    const realPatchPath = realpathSync(patchPath);
    const fromRealRoot = relative(realPatchRoot, realPatchPath);
    if (
      fromRealRoot === '..' ||
      fromRealRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRealRoot)
    ) {
      throw new Error(`Patch symlink escapes patches/deepseek-harness: ${entry}`);
    }
    return realPatchPath;
  });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [extraEnvironment]
 */
export function runGit(cwd, args, extraEnvironment = {}) {
  const result = spawnSync(
    'git',
    ['-c', `core.hooksPath=${devNull}`, ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...extraEnvironment,
        ...HERMETIC_GIT_ENV,
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout.trim();
}

/** @param {string} filePath */
export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * @param {string} moduleUrl
 * @param {string | undefined} [entryPath]
 */
export function isDirectExecution(moduleUrl, entryPath = process.argv[1]) {
  if (!entryPath) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entryPath)).href;
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   projectDirectory?: string,
 *   checkoutDirectory?: string,
 *   lock: unknown,
 *   packageJson: unknown,
 * }} options
 */
export function prepareDsh(options) {
  const projectDirectory = resolve(options.projectDirectory ?? defaultProjectDirectory);
  const checkoutDirectory = resolve(
    options.checkoutDirectory ?? join(projectDirectory, '.runtime', 'deepseek-harness'),
  );
  const lock = validateSourceLock(options.lock, options.packageJson);
  assertSupportedNode(/** @type {string} */ (lock.supportedNode));
  const patchPaths = resolvePatchPaths(
    projectDirectory,
    /** @type {string[]} */ (lock.patchSeries),
  );

  if (existsSync(checkoutDirectory)) {
    const existing = inspectCheckout(checkoutDirectory, lock);
    if (!existing.valid) {
      throw new Error(
        `Prepared DSH checkout is invalid: HEAD=${String(existing.actualHead)}, dirty=${existing.dirty}`,
      );
    }
    return existing;
  }

  const checkoutParent = dirname(checkoutDirectory);
  mkdirSync(checkoutParent, { recursive: true });
  const temporaryCheckoutDirectory = mkdtempSync(
    join(checkoutParent, `.${basename(checkoutDirectory)}-`),
  );
  let promoted = false;
  try {
    runGit(projectDirectory, [
      'clone',
      '--no-checkout',
      /** @type {string} */ (lock.upstreamRepository),
      temporaryCheckoutDirectory,
    ]);
    runGit(temporaryCheckoutDirectory, [
      'checkout',
      '--detach',
      /** @type {string} */ (lock.upstreamCommit),
    ]);

    const lockedHead = runGit(temporaryCheckoutDirectory, ['rev-parse', 'HEAD']);
    if (lockedHead !== lock.upstreamCommit) {
      throw new Error(
        `Unexpected upstream HEAD: expected ${String(lock.upstreamCommit)}, received ${lockedHead}`,
      );
    }

    for (const patchPath of patchPaths) {
      runGit(
        temporaryCheckoutDirectory,
        ['am', '--no-gpg-sign', '--committer-date-is-author-date', patchPath],
        PATCH_COMMITTER_ENV,
      );
    }

    const prepared = inspectCheckout(temporaryCheckoutDirectory, lock);
    if (!prepared.valid) {
      throw new Error(
        `Unexpected prepared HEAD: expected ${String(lock.expectedDerivedCommit)}, received ${String(prepared.actualHead)}, dirty=${prepared.dirty}`,
      );
    }
    if (existsSync(checkoutDirectory)) {
      throw new Error(`Prepared DSH checkout target appeared during prepare`);
    }
    renameSync(temporaryCheckoutDirectory, checkoutDirectory);
    promoted = true;
    return prepared;
  } finally {
    if (!promoted) {
      rmSync(temporaryCheckoutDirectory, { recursive: true, force: true });
    }
  }
}

/**
 * @param {string} checkoutDirectory
 * @param {Record<string, unknown>} lock
 */
export function inspectCheckout(checkoutDirectory, lock) {
  const actualHead = runGit(checkoutDirectory, ['rev-parse', 'HEAD']);
  const worktreeRoot = runGit(checkoutDirectory, [
    'rev-parse',
    '--show-toplevel',
  ]);
  const isWorktreeRoot =
    realpathSync(worktreeRoot) === realpathSync(checkoutDirectory);
  const dirty = runGit(checkoutDirectory, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]) !== '';
  return {
    upstreamCommit: lock.upstreamCommit,
    actualHead,
    expectedDerivedCommit: lock.expectedDerivedCommit,
    dirty,
    patchSeries: [.../** @type {string[]} */ (lock.patchSeries)],
    valid: isWorktreeRoot && actualHead === lock.expectedDerivedCommit && !dirty,
  };
}

export function main() {
  const lock = readJson(join(defaultProjectDirectory, 'dsh.lock.json'));
  const packageJson = readJson(join(defaultProjectDirectory, 'package.json'));
  const report = prepareDsh({ lock, packageJson });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (isDirectExecution(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
