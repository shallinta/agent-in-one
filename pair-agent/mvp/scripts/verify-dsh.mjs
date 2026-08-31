import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  defaultCheckoutDirectory,
  defaultProjectDirectory,
  inspectCheckout,
  isDirectExecution,
  readJson,
  validateSourceLock,
} from './prepare-dsh.mjs';
import { computeRuntimeArtifactLock } from './refresh-dsh-runtime-artifacts.mjs';

/**
 * @param {{ checkoutDirectory: string, lock: unknown, packageJson: unknown }} options
 */
export function verifyPreparedCheckout(options) {
  const lock = validateSourceLock(options.lock, options.packageJson);
  const checkoutDirectory = resolve(options.checkoutDirectory);

  if (existsSync(checkoutDirectory)) {
    let source;
    try {
      source = inspectCheckout(checkoutDirectory, lock);
    } catch {
      source = undefined;
    }
    if (source !== undefined) {
      try {
        const actualRuntimeArtifacts = computeRuntimeArtifactLock(
          checkoutDirectory,
          source.actualHead,
        );
        const runtimeArtifactsValid =
          JSON.stringify(actualRuntimeArtifacts) ===
          JSON.stringify(lock.runtimeArtifacts);
        return {
          ...source,
          runtimeArtifacts: actualRuntimeArtifacts,
          runtimeArtifactsValid,
          valid: source.valid && runtimeArtifactsValid,
        };
      } catch {
        return {
          ...source,
          runtimeArtifacts: null,
          runtimeArtifactsValid: false,
          valid: false,
        };
      }
    }
  }

  return {
    upstreamCommit: lock.upstreamCommit,
    actualHead: null,
    expectedDerivedCommit: lock.expectedDerivedCommit,
    dirty: existsSync(checkoutDirectory),
    patchSeries: [.../** @type {string[]} */ (lock.patchSeries)],
    runtimeArtifacts: null,
    runtimeArtifactsValid: false,
    valid: false,
  };
}

export function main() {
  const lock = readJson(join(defaultProjectDirectory, 'dsh.lock.json'));
  const packageJson = readJson(join(defaultProjectDirectory, 'package.json'));
  const report = verifyPreparedCheckout({
    checkoutDirectory: defaultCheckoutDirectory,
    lock,
    packageJson,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.valid ? 0 : 1;
}

if (isDirectExecution(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
