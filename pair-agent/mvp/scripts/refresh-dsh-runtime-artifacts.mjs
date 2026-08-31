import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import {
  defaultCheckoutDirectory,
  defaultProjectDirectory,
  isDirectExecution,
  readJson,
  runGit,
  validateSourceLock,
} from './prepare-dsh.mjs';

export const RUNTIME_ARTIFACT_ROOTS = ['apps', 'native', 'packages', 'vendor'];
const EXECUTABLE_LIB_PATTERN = /\.(?:js|cjs|mjs)$/;

/** @param {unknown} value @returns {unknown} */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value);
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

/** @param {string | NodeJS.ArrayBufferView} value */
function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/**
 * Compute the parent-project attestation material for one already-built DSH
 * checkout. The manifest itself is never read from the derived checkout.
 */
export function computeRuntimeArtifactLock(
  /** @type {string} */
  checkoutDirectory,
  /** @type {string} */
  derivedCommit,
  /** @type {string} */
  buildProfile = 'official',
) {
  const root = realpathSync(resolve(checkoutDirectory));
  /** @type {string[]} */
  const paths = [];
  /** @param {string} directory */
  const walk = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      const selected =
        relativePath.split('/').includes('lib') &&
        EXECUTABLE_LIB_PATTERN.test(relativePath);
      if (entry.isSymbolicLink()) {
        if (selected) throw new Error(`Runtime artifact ${relativePath} must not be a symlink`);
        continue;
      }
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && selected) paths.push(relativePath);
    }
  };
  for (const artifactRoot of RUNTIME_ARTIFACT_ROOTS) {
    const expected = join(root, artifactRoot);
    if (realpathSync(expected) !== expected) {
      throw new Error(`Runtime artifact root ${artifactRoot} escaped the checkout`);
    }
    walk(expected);
  }
  paths.sort();
  if (paths.length === 0) {
    throw new Error('No built DSH runtime artifacts matched lib/**/*.{js,cjs,mjs}');
  }
  const files = paths.map((path) => ({
    path,
    sha256: sha256(readFileSync(join(root, ...path.split('/')))),
  }));
  const manifest = {
    schemaVersion: 1,
    derivedCommit,
    buildProfile,
    roots: RUNTIME_ARTIFACT_ROOTS,
    files,
  };
  return {
    schemaVersion: 1,
    buildProfile,
    roots: [...RUNTIME_ARTIFACT_ROOTS],
    include: 'lib/**/*.{js,cjs,mjs}',
    fileCount: files.length,
    digest: sha256(JSON.stringify(canonical(manifest))),
  };
}

/** Explicit maintainer action after an official clean build; never runtime. */
/** @param {{ projectDirectory?: string, checkoutDirectory?: string, lockPath?: string }} options */
export function refreshRuntimeArtifactLock(options) {
  const projectDirectory = resolve(options.projectDirectory ?? defaultProjectDirectory);
  const checkoutDirectory = resolve(options.checkoutDirectory ?? defaultCheckoutDirectory);
  const lockPath = resolve(options.lockPath ?? join(projectDirectory, 'dsh.lock.json'));
  const packagePath = join(projectDirectory, 'package.json');
  const lock = validateSourceLock(readJson(lockPath), readJson(packagePath));
  const head = runGit(checkoutDirectory, ['rev-parse', 'HEAD']);
  const dirty = runGit(checkoutDirectory, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  if (head !== lock.expectedDerivedCommit || dirty !== '') {
    throw new Error('Runtime artifacts can only be attested from the locked clean DSH source');
  }
  const runtimeArtifacts = computeRuntimeArtifactLock(
    checkoutDirectory,
    head,
    'official',
  );
  const next = { ...lock, runtimeArtifacts };
  const temporaryDirectory = mkdtempSync(
    join(dirname(lockPath), `.${basename(lockPath)}-`),
  );
  const temporaryPath = join(temporaryDirectory, basename(lockPath));
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, lockPath);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return runtimeArtifacts;
}

if (isDirectExecution(import.meta.url)) {
  try {
    if (process.argv[2] !== '--write-lock') {
      throw new Error('Pass --write-lock to replace the parent-project runtime artifact attestation');
    }
    const report = refreshRuntimeArtifactLock({});
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
