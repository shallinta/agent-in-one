import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { parsePairId, type PairRole } from '../packages/contracts/src/index.js';
import { JsonlPairLedgerStore } from '../packages/ledger/src/index.js';
import {
  analyzePairRequests,
  renderPairRequestAnalysisMarkdown,
  type PairRequestAnalysis,
  type SessionEventRecord,
} from './request-analysis.js';

export interface RequestAnalysisOptions {
  readonly pairId: string;
  readonly dataRoot: string;
  readonly format: 'json' | 'markdown';
}

function requiredValue(args: readonly string[], index: number, name: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new TypeError(`${name} requires a value`);
  }
  return value;
}

export function parseRequestAnalysisOptions(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): RequestAnalysisOptions {
  let pairId = environment.PAIR_ID ?? 'pair-demo';
  let dataRoot = environment.PAIR_DATA_ROOT ?? join(homedir(), '.pair-agent', 'p0.5');
  let format: RequestAnalysisOptions['format'] = 'markdown';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    switch (argument) {
      case '--pair-id':
        pairId = requiredValue(args, index, '--pair-id');
        index += 1;
        break;
      case '--data-root':
        dataRoot = requiredValue(args, index, '--data-root');
        index += 1;
        break;
      case '--format': {
        const value = requiredValue(args, index, '--format');
        if (value !== 'json' && value !== 'markdown') {
          throw new TypeError('--format must be json or markdown');
        }
        format = value;
        index += 1;
        break;
      }
      default:
        throw new TypeError(`unknown argument ${String(argument)}`);
    }
  }
  parsePairId(pairId);
  if (!isAbsolute(dataRoot)) throw new TypeError('--data-root must be absolute');
  return { pairId, dataRoot: resolve(dataRoot), format };
}

function encodeSessionPathSegment(raw: string): string {
  if (raw.length === 0) throw new TypeError('session ID must not be empty');
  let encoded = '';
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const character = String.fromCharCode(code);
    encoded += character !== '~' && /^[A-Za-z0-9._-]$/.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return encoded;
}

export function pairSessionLogPath(dataRoot: string, sessionId: string): string {
  if (!isAbsolute(dataRoot)) throw new TypeError('dataRoot must be absolute');
  return join(
    dataRoot,
    'dsh-sessions',
    '_no-cwd',
    encodeSessionPathSegment(sessionId),
    'session.jsonl',
  );
}

async function readJsonl(path: string): Promise<SessionEventRecord[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as SessionEventRecord;
      } catch (error) {
        throw new SyntaxError(`invalid JSONL at ${path}:${String(index + 1)}`, {
          cause: error,
        });
      }
    });
}

export async function loadPairRequestAnalysis(
  options: RequestAnalysisOptions,
): Promise<PairRequestAnalysis> {
  const store = new JsonlPairLedgerStore(join(options.dataRoot, 'pairs'));
  const pairEvents = await store.read(options.pairId);
  const sessionId = (role: PairRole): string => `pair:${options.pairId}:${role}`;
  const [navigator, pilot] = await Promise.all([
    readJsonl(pairSessionLogPath(options.dataRoot, sessionId('navigator'))),
    readJsonl(pairSessionLogPath(options.dataRoot, sessionId('pilot'))),
  ]);
  return analyzePairRequests(pairEvents, { navigator, pilot });
}

export async function runRequestAnalysis(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const options = parseRequestAnalysisOptions(args, environment);
  const analysis = await loadPairRequestAnalysis(options);
  return options.format === 'json'
    ? `${JSON.stringify(analysis, null, 2)}\n`
    : renderPairRequestAnalysisMarkdown(analysis);
}
