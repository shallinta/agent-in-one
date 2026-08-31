import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

import {
  prepareDsh,
  resolvePatchPaths,
  runGit,
  validateSourceLock,
} from '../prepare-dsh.mjs';
import { verifyPreparedCheckout } from '../verify-dsh.mjs';
import { computeRuntimeArtifactLock } from '../refresh-dsh-runtime-artifacts.mjs';

const PINNED_COMMIT = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e';

const validLock = {
  upstreamRepository: 'https://github.com/deepseek-ai/deepseek-harness.git',
  tag: 'dsh-v0.1.1-rc.2',
  upstreamCommit: PINNED_COMMIT,
  sourceRepository: 'local/pair-agent-phase-0',
  requestLayoutSeamVersion: 1,
  supportedNode: '>=22.19.0',
  pnpmVersion: '11.7.0',
  patchSeries: [],
  expectedDerivedCommit: PINNED_COMMIT,
  runtimeArtifacts: {
    schemaVersion: 1,
    buildProfile: 'official',
    roots: ['apps', 'native', 'packages', 'vendor'],
    include: 'lib/**/*.{js,cjs,mjs}',
    fileCount: 1,
    digest: `sha256:${'0'.repeat(64)}`,
  },
};

const validPackage = {
  packageManager: 'pnpm@11.7.0',
};

const temporaryDirectories = new Set<string>();

function createTemporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of [...temporaryDirectories].reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      `core.hooksPath=${devNull}`,
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: devNull,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: devNull,
      },
    },
  ).trim();
}

function createRepository(): { directory: string; first: string } {
  const directory = createTemporaryDirectory('pair-source-lock-repo-');
  git(directory, 'init');
  git(directory, 'config', 'user.name', 'Pair Agent DSH Patch Applicator');
  git(directory, 'config', 'user.email', 'pair-agent-dsh@example.invalid');
  writeFileSync(join(directory, 'README.md'), 'locked source\n');
  git(directory, 'add', 'README.md');
  git(directory, 'commit', '-m', 'initial source');
  return { directory, first: git(directory, 'rev-parse', 'HEAD') };
}

describe('source lock validation', () => {
  test('accepts the pinned upstream with an initially empty patch series', () => {
    expect(() => validateSourceLock(validLock, validPackage)).not.toThrow();
  });

  test('rejects floating ref fields even when a full commit is present', () => {
    expect(() =>
      validateSourceLock({ ...validLock, upstreamRef: 'main' }, validPackage),
    ).toThrow(/floating ref/i);
  });

  test('rejects a commit that is not a full 40-character SHA', () => {
    expect(() =>
      validateSourceLock(
        { ...validLock, upstreamCommit: PINNED_COMMIT.slice(0, 39) },
        validPackage,
      ),
    ).toThrow(/40-character/i);
  });

  test('rejects a package-manager version different from the lock', () => {
    expect(() =>
      validateSourceLock(validLock, { packageManager: 'pnpm@11.6.0' }),
    ).toThrow(/package manager/i);
  });

  test('requires a complete parent-trusted runtime artifact digest', () => {
    const { runtimeArtifacts: _omitted, ...missing } = validLock;
    expect(() => validateSourceLock(missing, validPackage)).toThrow(
      /runtime artifacts/i,
    );
    expect(() =>
      validateSourceLock(
        {
          ...validLock,
          runtimeArtifacts: {
            ...validLock.runtimeArtifacts,
            roots: ['packages'],
          },
        },
        validPackage,
      ),
    ).toThrow(/runtime artifact roots/i);
    expect(() =>
      validateSourceLock(
        {
          ...validLock,
          runtimeArtifacts: {
            ...validLock.runtimeArtifacts,
            digest: 'sha256:not-a-digest',
          },
        },
        validPackage,
      ),
    ).toThrow(/runtime artifact digest/i);
  });

  test('rejects patches outside patches/deepseek-harness', () => {
    expect(() =>
      resolvePatchPaths(
        '/work/pair-agent/mvp',
        ['patches/deepseek-harness/../escape.patch'],
      ),
    ).toThrow(/patches\/deepseek-harness/i);
  });

  test('rejects an allowlist root symlinked outside the project', () => {
    const projectDirectory = createTemporaryDirectory('pair-patch-root-project-');
    const externalDirectory = createTemporaryDirectory('pair-patch-root-external-');
    mkdirSync(join(projectDirectory, 'patches'));
    writeFileSync(join(externalDirectory, 'outside.patch'), 'external patch\n');
    symlinkSync(
      externalDirectory,
      join(projectDirectory, 'patches', 'deepseek-harness'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(() =>
      resolvePatchPaths(projectDirectory, [
        'patches/deepseek-harness/outside.patch',
      ]),
    ).toThrow(/patch root.*project/i);
  });
});

describe('prepared checkout verification', () => {
  test('marks a dirty prepared checkout invalid', () => {
    const repository = createRepository();
    const lock = {
      ...validLock,
      upstreamCommit: repository.first,
      expectedDerivedCommit: repository.first,
    };
    writeFileSync(join(repository.directory, 'untracked.txt'), 'dirty\n');

    expect(
      verifyPreparedCheckout({
        checkoutDirectory: repository.directory,
        lock,
        packageJson: validPackage,
      }),
    ).toMatchObject({
      actualHead: repository.first,
      dirty: true,
      valid: false,
    });
  });

  test('rejects a normal subdirectory of a clean Git worktree', () => {
    const repository = createRepository();
    const nestedCheckout = join(repository.directory, 'nested');
    mkdirSync(nestedCheckout);
    const lock = {
      ...validLock,
      upstreamCommit: repository.first,
      expectedDerivedCommit: repository.first,
    };

    expect(
      verifyPreparedCheckout({
        checkoutDirectory: nestedCheckout,
        lock,
        packageJson: validPackage,
      }).valid,
    ).toBe(false);
  });

  test('rejects a symlink to a subdirectory of a clean Git worktree', () => {
    const repository = createRepository();
    const nestedCheckout = join(repository.directory, 'nested');
    const checkoutLink = join(
      createTemporaryDirectory('pair-source-lock-link-'),
      'checkout',
    );
    mkdirSync(nestedCheckout);
    symlinkSync(
      nestedCheckout,
      checkoutLink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const lock = {
      ...validLock,
      upstreamCommit: repository.first,
      expectedDerivedCommit: repository.first,
    };

    expect(
      verifyPreparedCheckout({
        checkoutDirectory: checkoutLink,
        lock,
        packageJson: validPackage,
      }).valid,
    ).toBe(false);
  });

  test('removes a failed first prepare target and allows a clean retry', () => {
    const repository = createRepository();
    const projectDirectory = createTemporaryDirectory('pair-atomic-prepare-');
    const checkoutDirectory = join(projectDirectory, '.runtime', 'deepseek-harness');
    const missingCommit = '0'.repeat(40);

    expect(() =>
      prepareDsh({
        projectDirectory,
        checkoutDirectory,
        lock: {
          ...validLock,
          upstreamRepository: repository.directory,
          upstreamCommit: missingCommit,
          expectedDerivedCommit: missingCommit,
        },
        packageJson: validPackage,
      }),
    ).toThrow();
    expect(existsSync(checkoutDirectory)).toBe(false);
    expect(
      readdirSync(join(projectDirectory, '.runtime')).filter((entry) =>
        entry.startsWith('.deepseek-harness-'),
      ),
    ).toEqual([]);

    expect(
      prepareDsh({
        projectDirectory,
        checkoutDirectory,
        lock: {
          ...validLock,
          upstreamRepository: repository.directory,
          upstreamCommit: repository.first,
          expectedDerivedCommit: repository.first,
        },
        packageJson: validPackage,
      }).valid,
    ).toBe(true);
  });

  test('clones the locked SHA and applies patches in declared order', () => {
    const repository = createRepository();
    writeFileSync(join(repository.directory, 'first.txt'), 'first patch\n');
    git(repository.directory, 'add', 'first.txt');
    git(repository.directory, 'commit', '-m', 'first patch');
    writeFileSync(join(repository.directory, 'second.txt'), 'second patch\n');
    git(repository.directory, 'add', 'second.txt');
    git(repository.directory, 'commit', '-m', 'second patch');
    const derivedCommit = git(repository.directory, 'rev-parse', 'HEAD');

    const projectDirectory = createTemporaryDirectory('pair-source-lock-project-');
    const patchDirectory = join(projectDirectory, 'patches', 'deepseek-harness');
    mkdirSync(patchDirectory, { recursive: true });
    git(
      repository.directory,
      'format-patch',
      '-2',
      '--output-directory',
      patchDirectory,
    );
    const patchSeries = [
      'patches/deepseek-harness/0001-first-patch.patch',
      'patches/deepseek-harness/0002-second-patch.patch',
    ];
    const checkoutDirectory = join(projectDirectory, '.runtime', 'deepseek-harness');

    const report = prepareDsh({
      projectDirectory,
      checkoutDirectory,
      lock: {
        ...validLock,
        upstreamRepository: repository.directory,
        upstreamCommit: repository.first,
        patchSeries,
        expectedDerivedCommit: derivedCommit,
      },
      packageJson: validPackage,
    });

    expect(report).toMatchObject({
      actualHead: derivedCommit,
      dirty: false,
      patchSeries,
      valid: true,
    });
  });
});

describe('runtime artifact attestation', () => {
  test('covers every executable lib artifact and binds the derived commit and profile', () => {
    const root = createTemporaryDirectory('pair-runtime-artifacts-');
    for (const name of ['apps', 'native', 'packages', 'vendor']) {
      mkdirSync(join(root, name, 'sample', 'lib'), { recursive: true });
    }
    writeFileSync(join(root, 'apps/sample/lib/index.js'), 'export const app = 1\n');
    writeFileSync(join(root, 'native/sample/lib/worker.cjs'), 'exports.native = 1\n');
    writeFileSync(join(root, 'vendor/sample/lib/index.mjs'), 'export const vendor = 1\n');
    writeFileSync(join(root, 'packages/sample/lib/types.d.ts'), 'export {}\n');

    const first = computeRuntimeArtifactLock(root, PINNED_COMMIT);
    expect(first).toMatchObject({
      buildProfile: 'official',
      fileCount: 3,
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    writeFileSync(join(root, 'vendor/sample/lib/index.mjs'), 'export const vendor = 2\n');
    const changed = computeRuntimeArtifactLock(root, PINNED_COMMIT);
    const rebound = computeRuntimeArtifactLock(root, '1'.repeat(40));
    expect(changed.digest).not.toBe(first.digest);
    expect(rebound.digest).not.toBe(changed.digest);
  });
});

describe('source lock CLI', () => {
  test('runs verify main when invoked through a symlinked script directory', () => {
    const linkRoot = createTemporaryDirectory('pair-source-lock-cli-');
    const scriptDirectory = dirname(
      fileURLToPath(new URL('../verify-dsh.mjs', import.meta.url)),
    );
    const linkedScriptDirectory = join(linkRoot, 'scripts');
    symlinkSync(
      scriptDirectory,
      linkedScriptDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const result = spawnSync(
      process.execPath,
      [join(linkedScriptDirectory, 'verify-dsh.mjs')],
      { encoding: 'utf8' },
    );

    expect(result.stdout.trim()).not.toBe('');
    const report = JSON.parse(result.stdout);
    expect(result.status).toBe(report.valid ? 0 : 1);
  });
});

describe('hermetic Git execution', () => {
  test('ignores global and system config plus repository hooks', () => {
    const repository = createRepository();
    const hooksDirectory = createTemporaryDirectory('pair-source-lock-hooks-');
    const preCommitHook = join(hooksDirectory, 'pre-commit');
    writeFileSync(preCommitHook, '#!/bin/sh\nexit 97\n');
    chmodSync(preCommitHook, 0o755);
    git(repository.directory, 'config', 'core.hooksPath', hooksDirectory);
    writeFileSync(join(repository.directory, 'next.txt'), 'next\n');
    git(repository.directory, 'add', 'next.txt');

    const hostileConfigDirectory = createTemporaryDirectory(
      'pair-source-lock-git-config-',
    );
    const hostileConfig = join(hostileConfigDirectory, 'config');
    writeFileSync(hostileConfig, '[invalid\n');
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    const previousSystem = process.env.GIT_CONFIG_SYSTEM;
    const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_GLOBAL = hostileConfig;
    process.env.GIT_CONFIG_SYSTEM = hostileConfig;
    delete process.env.GIT_CONFIG_NOSYSTEM;

    try {
      expect(() =>
        runGit(repository.directory, ['commit', '-m', 'hermetic commit']),
      ).not.toThrow();
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      if (previousSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = previousSystem;
      if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    }
  });
});
