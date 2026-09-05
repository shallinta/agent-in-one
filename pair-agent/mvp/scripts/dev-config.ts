import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface Phase0DevConfig {
  readonly dataRoot: string;
  readonly pairId: string;
  readonly webSearch: {
    readonly enabled: boolean;
    readonly apiKeyEnv: string;
  };
  readonly ports: {
    readonly pairWeb: number;
    readonly dshWeb: number;
    readonly pairHost: number;
  };
  readonly provider:
    | { readonly kind: 'capture'; readonly model: 'capture-model' }
    | {
        readonly kind: 'openai';
        readonly model: string;
        readonly baseURL: string;
        readonly apiKeyEnv: string;
        readonly contextWindow: number;
        readonly maxTokens: number;
        readonly compatibility: 'openai' | 'deepseek';
      };
}

function zeroOrOne(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const raw = environment[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === '1') return true;
  if (raw === '0') return false;
  throw new TypeError(`${name} must be 0 or 1`);
}

function environmentVariableName(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string {
  const value = environment[name] ?? fallback;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new TypeError(`${name} must name an environment variable`);
  }
  return value;
}

function port(environment: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = environment[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new TypeError(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new TypeError(`${name} must be an integer`);
  if (value < 1024 || value > 65_535) {
    throw new RangeError(`${name} must be between 1024 and 65535`);
  }
  return value;
}

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = environment[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return Number(raw);
}

function openAiCompatibility(
  environment: NodeJS.ProcessEnv,
  model: string,
): 'openai' | 'deepseek' {
  const configured = environment.PAIR_OPENAI_COMPATIBILITY;
  if (configured === undefined || configured === '') {
    return model.toLowerCase().startsWith('deepseek-') ? 'deepseek' : 'openai';
  }
  if (configured !== 'openai' && configured !== 'deepseek') {
    throw new TypeError('PAIR_OPENAI_COMPATIBILITY must be openai or deepseek');
  }
  return configured;
}

export function readPhase0DevConfig(environment: NodeJS.ProcessEnv): Phase0DevConfig {
  const configuredRoot = environment.PAIR_DATA_ROOT;
  const dataRoot = configuredRoot ?? join(homedir(), '.pair-agent', 'p0.5');
  if (!isAbsolute(dataRoot)) throw new TypeError('PAIR_DATA_ROOT must be absolute');
  const ports = {
    pairWeb: port(environment, 'PAIR_WEB_PORT', 3070),
    dshWeb: port(environment, 'DSH_WEB_PORT', 3080),
    pairHost: port(environment, 'PAIR_HOST_PORT', 3090),
  };
  if (new Set(Object.values(ports)).size !== 3) {
    throw new TypeError('PAIR_WEB_PORT, DSH_WEB_PORT and PAIR_HOST_PORT must be distinct');
  }
  const pairId = environment.PAIR_ID ?? 'pair-demo';
  if (!/^pair-[a-z0-9][a-z0-9._-]{0,127}$/.test(pairId)) {
    throw new TypeError('PAIR_ID must be a valid Pair ID');
  }
  const providerFields = [
    environment.PAIR_OPENAI_BASE_URL,
    environment.PAIR_OPENAI_MODEL,
    environment.PAIR_OPENAI_API_KEY_ENV,
  ];
  const webSearch = {
    enabled: zeroOrOne(environment, 'PAIR_WEB_SEARCH_ENABLED', true),
    apiKeyEnv: environmentVariableName(
      environment,
      'PAIR_WEB_SEARCH_API_KEY_ENV',
      'DEEPSEEK_API_KEY',
    ),
  };
  const configuredFields = providerFields.filter(
    (value) => value !== undefined && value !== '',
  ).length;
  if (configuredFields === 0) {
    return {
      dataRoot: resolve(dataRoot),
      pairId,
      webSearch,
      ports,
      provider: { kind: 'capture', model: 'capture-model' },
    };
  }
  if (configuredFields !== providerFields.length) {
    throw new TypeError(
      'PAIR_OPENAI_BASE_URL, PAIR_OPENAI_MODEL and PAIR_OPENAI_API_KEY_ENV are required together',
    );
  }
  let baseURL: URL;
  try {
    baseURL = new URL(providerFields[0]!);
  } catch {
    throw new TypeError('PAIR_OPENAI_BASE_URL must be an absolute HTTP(S) URL');
  }
  if (baseURL.protocol !== 'https:' && baseURL.protocol !== 'http:') {
    throw new TypeError('PAIR_OPENAI_BASE_URL must be an absolute HTTP(S) URL');
  }
  return {
    dataRoot: resolve(dataRoot),
    pairId,
    webSearch,
    ports,
    provider: {
      kind: 'openai',
      baseURL: baseURL.href.replace(/\/$/, ''),
      model: providerFields[1]!,
      apiKeyEnv: providerFields[2]!,
      contextWindow: positiveInteger(environment, 'PAIR_OPENAI_CONTEXT_WINDOW', 128_000),
      maxTokens: positiveInteger(environment, 'PAIR_OPENAI_MAX_TOKENS', 4_096),
      compatibility: openAiCompatibility(environment, providerFields[1]!),
    },
  };
}
