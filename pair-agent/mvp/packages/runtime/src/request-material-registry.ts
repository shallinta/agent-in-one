import {
  canonicalJsonStringify,
  type JsonObject,
  type PairRole,
} from '@pair-agent/contracts';
import type { CommonSystemDefinition } from '@pair-agent/context';

export interface PairRequestMaterialEntry {
  readonly promptVersion: string;
  readonly commonSystem: CommonSystemDefinition;
  readonly roleToolGuidance: Readonly<Record<PairRole, string>>;
  readonly toolSetVersion: string;
  readonly tools: readonly JsonObject[];
  readonly requestConfigVersion: string;
  readonly config: JsonObject;
}

export interface PairRequestMaterialVersions {
  readonly promptVersion: string;
  readonly toolSetVersion: string;
  readonly requestConfigVersion: string;
}

export class RequestMaterialRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestMaterialRegistryError';
  }
}

function key(versions: PairRequestMaterialVersions): string {
  return canonicalJsonStringify({
    promptVersion: versions.promptVersion,
    toolSetVersion: versions.toolSetVersion,
    requestConfigVersion: versions.requestConfigVersion,
  });
}

function clone(entry: PairRequestMaterialEntry): PairRequestMaterialEntry {
  return structuredClone(entry);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export class ImmutablePairRequestMaterialRegistry {
  readonly #entries = new Map<string, PairRequestMaterialEntry>();
  readonly active: PairRequestMaterialEntry;

  constructor(
    active: PairRequestMaterialEntry,
    historical: readonly PairRequestMaterialEntry[] = [],
  ) {
    for (const entry of [...historical, active]) this.#add(entry);
    this.active = deepFreeze(clone(active));
  }

  resolve(versions: PairRequestMaterialVersions): PairRequestMaterialEntry {
    const entry = this.#entries.get(key(versions));
    if (entry === undefined) {
      throw new RequestMaterialRegistryError(
        `No immutable request materials are registered for ${versions.promptVersion}, ${versions.toolSetVersion}, ${versions.requestConfigVersion}`,
      );
    }
    return clone(entry);
  }

  export(): readonly PairRequestMaterialEntry[] {
    return [...this.#entries.values()].map(clone);
  }

  #add(entry: PairRequestMaterialEntry): void {
    if (
      entry.promptVersion.length === 0 ||
      entry.toolSetVersion.length === 0 ||
      entry.requestConfigVersion.length === 0 ||
      entry.commonSystem.version !== entry.promptVersion
    ) {
      throw new RequestMaterialRegistryError('Request material versions are invalid');
    }
    canonicalJsonStringify(entry);
    const entryKey = key(entry);
    const prior = this.#entries.get(entryKey);
    if (
      prior !== undefined &&
      canonicalJsonStringify(prior) !== canonicalJsonStringify(entry)
    ) {
      throw new RequestMaterialRegistryError(
        'An immutable request material version cannot be redefined',
      );
    }
    this.#entries.set(entryKey, deepFreeze(clone(entry)));
  }
}
