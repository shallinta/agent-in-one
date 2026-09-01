import { expect, test } from 'vitest';

import {
  assertContentAddressedPairPrompt,
  createContentAddressedPairPrompt,
} from '../src/prompt-bundle.js';

const source = {
  commonSystem: 'PAIR SESSION IDENTITY\ncontract',
  roleToolGuidance: {
    navigator: 'navigator guidance',
    pilot: 'pilot guidance',
  },
} as const;

test('addresses the exact Common System and both role guidance strings', () => {
  const original = createContentAddressedPairPrompt(source);
  expect(original.commonSystem.version).toMatch(/^pair-prompt\/sha256:[a-f0-9]{64}$/);
  expect(original.commonSystem.version).toBe(
    'pair-prompt/sha256:a657f4ebf1ef4390d17f1dd53dd6f98a79f4ab3b6a01fc7dfce0e4727655ae74',
  );
  expect(original.commonSystem.content).toBe(source.commonSystem);
  expect(original.roleToolGuidance).toEqual(source.roleToolGuidance);
  expect(() => assertContentAddressedPairPrompt(original)).not.toThrow();

  for (const changed of [
    { ...source, commonSystem: `${source.commonSystem} ` },
    {
      ...source,
      roleToolGuidance: {
        ...source.roleToolGuidance,
        navigator: 'navigator guidance ',
      },
    },
    {
      ...source,
      roleToolGuidance: {
        ...source.roleToolGuidance,
        pilot: 'pilot guidance ',
      },
    },
  ]) {
    expect(createContentAddressedPairPrompt(changed).commonSystem.version).not.toBe(
      original.commonSystem.version,
    );
  }

  expect(() =>
    assertContentAddressedPairPrompt({
      commonSystem: original.commonSystem,
      roleToolGuidance: {
        ...original.roleToolGuidance,
        pilot: 'wrong guidance',
      },
    }),
  ).toThrow(/Prompt bundle identity mismatch/);
});
