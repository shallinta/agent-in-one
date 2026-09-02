import { describe, expect, test } from 'vitest';

import {
  ImmutablePairRequestMaterialRegistry,
  RequestMaterialRegistryError,
  type PairRequestMaterialEntry,
} from '../src/request-material-registry.js';

const entry: PairRequestMaterialEntry = {
  promptVersion: 'prompt/v1',
  sharedEventContextFormat: 'pair-event-context/text-dedup-v1',
  commonSystem: { version: 'prompt/v1', content: 'common' },
  roleToolGuidance: { navigator: 'govern', pilot: 'execute' },
  toolSetVersion: 'tools/v1',
  tools: [],
  requestConfigVersion: 'config/v1',
  config: { provider: 'openai-completions', model: 'test' },
};

describe('ImmutablePairRequestMaterialRegistry', () => {
  test('rejects the same version key with different immutable content', () => {
    expect(
      () =>
        new ImmutablePairRequestMaterialRegistry(
          { ...entry, commonSystem: { ...entry.commonSystem, content: 'changed' } },
          [entry],
        ),
    ).toThrow(RequestMaterialRegistryError);
  });

  test('returns detached materials addressed only by persisted versions', () => {
    const registry = new ImmutablePairRequestMaterialRegistry(entry);
    expect(Object.isFrozen(registry.active)).toBe(true);
    expect(Object.isFrozen(registry.active.commonSystem)).toBe(true);
    expect(
      registry.resolve({
        promptVersion: 'prompt/v1',
        sharedEventContextFormat: 'pair-event-context/text-dedup-v1',
        toolSetVersion: 'tools/v1',
        requestConfigVersion: 'config/v1',
      }),
    ).toEqual(entry);
  });

  test('addresses otherwise identical materials by shared event context format', () => {
    const legacy: PairRequestMaterialEntry = {
      ...entry,
      sharedEventContextFormat: 'pair-event-context/full-v1',
    };
    const registry = new ImmutablePairRequestMaterialRegistry(entry, [legacy]);

    expect(
      registry.resolve({
        promptVersion: 'prompt/v1',
        sharedEventContextFormat: 'pair-event-context/full-v1',
        toolSetVersion: 'tools/v1',
        requestConfigVersion: 'config/v1',
      }),
    ).toEqual(legacy);
    expect(
      registry.resolve({
        promptVersion: 'prompt/v1',
        sharedEventContextFormat: 'pair-event-context/text-dedup-v1',
        toolSetVersion: 'tools/v1',
        requestConfigVersion: 'config/v1',
      }),
    ).toEqual(entry);
  });
});
