import { createHash } from 'node:crypto';

import type { PairRole } from '@pair-agent/contracts';

import type { CommonSystemDefinition } from './serialize.js';

export interface PairPromptBundleSource {
  readonly commonSystem: string;
  readonly roleToolGuidance: Readonly<Record<PairRole, string>>;
}

export interface MaterializedPairPromptBundle {
  readonly commonSystem: CommonSystemDefinition;
  readonly roleToolGuidance: Readonly<Record<PairRole, string>>;
}

function field(name: string, value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([
    Buffer.from(`${name}:${String(bytes.byteLength)}\n`, 'utf8'),
    bytes,
    Buffer.from('\n', 'utf8'),
  ]);
}

function versionFor(source: PairPromptBundleSource): string {
  const material = Buffer.concat([
    field('commonSystem', source.commonSystem),
    field('navigatorGuidance', source.roleToolGuidance.navigator),
    field('pilotGuidance', source.roleToolGuidance.pilot),
  ]);
  const digest = createHash('sha256').update(material).digest('hex');
  return `pair-prompt/sha256:${digest}`;
}

export function createContentAddressedPairPrompt(
  source: PairPromptBundleSource,
): MaterializedPairPromptBundle {
  return {
    commonSystem: {
      version: versionFor(source),
      content: source.commonSystem,
    },
    roleToolGuidance: {
      navigator: source.roleToolGuidance.navigator,
      pilot: source.roleToolGuidance.pilot,
    },
  };
}

export function assertContentAddressedPairPrompt(
  bundle: MaterializedPairPromptBundle,
): void {
  if (!bundle.commonSystem.version.startsWith('pair-prompt/sha256:')) return;
  const actual = versionFor({
    commonSystem: bundle.commonSystem.content,
    roleToolGuidance: bundle.roleToolGuidance,
  });
  if (actual !== bundle.commonSystem.version) {
    throw new Error(
      `Prompt bundle identity mismatch: expected ${bundle.commonSystem.version}, got ${actual}`,
    );
  }
}
