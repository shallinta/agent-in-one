import type {
  PairRequestSegmentMeasurements,
  PairRequestSegmentName,
} from '../packages/context/src/index.js';
import type { PairRole } from '../packages/contracts/src/index.js';

export interface ProviderUsageAnalysis {
  readonly uncachedInputTokens: number;
  readonly cacheReadTokens: number;
  readonly totalInputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadRate: number;
}

export interface ResponseContentAnalysis {
  readonly reasoningCharacters: number;
  readonly visibleCharacters: number;
}

export interface PairRequestAnalysisRow {
  readonly ledgerSeq: number;
  readonly requestId: string;
  readonly role: PairRole;
  readonly turn: number;
  readonly step: number;
  readonly attempt: number;
  readonly sharedHead: number;
  readonly sourceLedgerHead: number;
  readonly segmentMeasurements: PairRequestSegmentMeasurements | null;
  readonly firstChangedSegment: PairRequestSegmentName | null;
  readonly usage: ProviderUsageAnalysis | null;
  readonly responseContent: ResponseContentAnalysis;
}

export interface PairRequestAnalysis {
  readonly schema: 'pair-request-analysis/v1';
  readonly pairId: string | null;
  readonly requests: readonly PairRequestAnalysisRow[];
  readonly totals: {
    readonly requestCount: number;
    readonly measuredRequestCount: number;
    readonly usageRequestCount: number;
    readonly uncachedInputTokens: number;
    readonly cacheReadTokens: number;
    readonly totalInputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadRate: number;
    readonly reasoningCharacters: number;
    readonly visibleCharacters: number;
  };
}

export interface SessionEventRecord {
  readonly type?: unknown;
  readonly data?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function role(value: unknown): PairRole | undefined {
  return value === 'navigator' || value === 'pilot' ? value : undefined;
}

function requestKey(roleValue: PairRole, turn: number, step: number): string {
  return `${roleValue}:${String(turn)}:${String(step)}`;
}

function parseUsage(value: unknown): ProviderUsageAnalysis | undefined {
  const usage = record(value);
  if (
    usage === undefined ||
    !nonNegativeNumber(usage.inputTokens) ||
    !nonNegativeNumber(usage.outputTokens)
  ) return undefined;
  const cacheReadTokens = nonNegativeNumber(usage.cacheReadTokens)
    ? usage.cacheReadTokens
    : 0;
  const totalInputTokens = usage.inputTokens + cacheReadTokens;
  return {
    uncachedInputTokens: usage.inputTokens,
    cacheReadTokens,
    totalInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadRate: totalInputTokens === 0 ? 0 : cacheReadTokens / totalInputTokens,
  };
}

function responseCharacters(messageValue: unknown): ResponseContentAnalysis {
  const message = record(messageValue);
  const content = message?.content;
  if (typeof content === 'string') {
    return { reasoningCharacters: 0, visibleCharacters: content.length };
  }
  if (!Array.isArray(content)) {
    return { reasoningCharacters: 0, visibleCharacters: 0 };
  }
  let reasoningCharacters = 0;
  let visibleCharacters = 0;
  for (const candidate of content) {
    const block = record(candidate);
    if (block === undefined || typeof block.text !== 'string') continue;
    if (block.type === 'reasoning') reasoningCharacters += block.text.length;
    if (block.type === 'text') visibleCharacters += block.text.length;
  }
  return { reasoningCharacters, visibleCharacters };
}

function sessionFacts(events: readonly SessionEventRecord[]): {
  readonly usage: ReadonlyMap<string, ProviderUsageAnalysis>;
  readonly content: ReadonlyMap<string, ResponseContentAnalysis>;
} {
  const usage = new Map<string, ProviderUsageAnalysis>();
  const fallbackUsage = new Map<string, ProviderUsageAnalysis>();
  const content = new Map<string, ResponseContentAnalysis>();
  for (const event of events) {
    const data = record(event.data);
    if (data === undefined || !positiveInteger(data.turn) || !positiveInteger(data.step)) {
      continue;
    }
    const key = `${String(data.turn)}:${String(data.step)}`;
    if (event.type === 'assistant/chunk') {
      const chunk = record(data.chunk);
      if (chunk?.type !== 'usage') continue;
      const parsed = parseUsage(chunk.usage);
      if (parsed !== undefined) usage.set(key, parsed);
      continue;
    }
    if (event.type !== 'assistant/message') continue;
    const parsed = parseUsage(data.usage);
    if (parsed !== undefined) fallbackUsage.set(key, parsed);
    content.set(key, responseCharacters(record(data.message)));
  }
  for (const [key, value] of fallbackUsage) {
    if (!usage.has(key)) usage.set(key, value);
  }
  return { usage, content };
}

function measurements(value: unknown): PairRequestSegmentMeasurements | null {
  const candidate = record(value);
  if (candidate === undefined) return null;
  if (
    candidate.schema !== 'pair-request-segments/v1' ||
    candidate.tokenEstimateMethod !== 'utf8-bytes-div-4/v1' ||
    !Array.isArray(candidate.segments)
  ) {
    throw new TypeError('pair request segment measurements are malformed');
  }
  return structuredClone(candidate) as unknown as PairRequestSegmentMeasurements;
}

function firstChangedSegment(
  previous: PairRequestSegmentMeasurements | null,
  current: PairRequestSegmentMeasurements | null,
): PairRequestSegmentName | null {
  if (previous === null || current === null) return null;
  const previousDigests = new Map(
    previous.segments.map((segment) => [segment.name, segment.digest] as const),
  );
  for (const segment of current.segments) {
    if (previousDigests.get(segment.name) !== segment.digest) return segment.name;
  }
  return null;
}

export function analyzePairRequests(
  pairEvents: readonly unknown[],
  sessionEvents: Readonly<Record<PairRole, readonly SessionEventRecord[]>>,
): PairRequestAnalysis {
  const roleFacts = {
    navigator: sessionFacts(sessionEvents.navigator),
    pilot: sessionFacts(sessionEvents.pilot),
  };
  const requests: Array<Omit<PairRequestAnalysisRow, 'firstChangedSegment'>> = [];
  let pairId: string | null = null;
  for (const value of pairEvents) {
    const event = record(value);
    if (event?.type !== 'pair.request_built') continue;
    const payload = record(event.payload);
    const snapshot = record(payload?.snapshot);
    const parsedRole = role(snapshot?.role);
    if (
      !positiveInteger(event.seq) ||
      typeof payload?.requestId !== 'string' ||
      parsedRole === undefined ||
      !positiveInteger(snapshot?.turn) ||
      !positiveInteger(snapshot.step) ||
      !positiveInteger(snapshot.attempt) ||
      !positiveInteger(snapshot.sharedHead) ||
      !positiveInteger(snapshot.sourceLedgerHead)
    ) {
      throw new TypeError('pair.request_built contains invalid analysis coordinates');
    }
    if (typeof event.pairId === 'string') {
      if (pairId !== null && pairId !== event.pairId) {
        throw new TypeError('pair request analysis received multiple Pair IDs');
      }
      pairId = event.pairId;
    }
    const facts = roleFacts[parsedRole];
    const sessionKey = `${String(snapshot.turn)}:${String(snapshot.step)}`;
    requests.push({
      ledgerSeq: event.seq,
      requestId: payload.requestId,
      role: parsedRole,
      turn: snapshot.turn,
      step: snapshot.step,
      attempt: snapshot.attempt,
      sharedHead: snapshot.sharedHead,
      sourceLedgerHead: snapshot.sourceLedgerHead,
      segmentMeasurements: measurements(snapshot.segmentMeasurements),
      usage: facts.usage.get(sessionKey) ?? null,
      responseContent: facts.content.get(sessionKey) ?? {
        reasoningCharacters: 0,
        visibleCharacters: 0,
      },
    });
  }
  requests.sort((left, right) => left.ledgerSeq - right.ledgerSeq);

  const lastRequestIndexByStep = new Map<string, number>();
  requests.forEach((request, index) => {
    lastRequestIndexByStep.set(requestKey(request.role, request.turn, request.step), index);
  });
  const rows: PairRequestAnalysisRow[] = [];
  let previousMeasurements: PairRequestSegmentMeasurements | null = null;
  requests.forEach((request, index) => {
    const isLastAttempt = lastRequestIndexByStep.get(
      requestKey(request.role, request.turn, request.step),
    ) === index;
    const row: PairRequestAnalysisRow = {
      ...request,
      firstChangedSegment: firstChangedSegment(
        previousMeasurements,
        request.segmentMeasurements,
      ),
      usage: isLastAttempt ? request.usage : null,
      responseContent: isLastAttempt ? request.responseContent : {
        reasoningCharacters: 0,
        visibleCharacters: 0,
      },
    };
    rows.push(row);
    previousMeasurements = request.segmentMeasurements;
  });

  const totals = rows.reduce(
    (result, request) => {
      result.measuredRequestCount += request.segmentMeasurements === null ? 0 : 1;
      if (request.usage !== null) {
        result.usageRequestCount += 1;
        result.uncachedInputTokens += request.usage.uncachedInputTokens;
        result.cacheReadTokens += request.usage.cacheReadTokens;
        result.totalInputTokens += request.usage.totalInputTokens;
        result.outputTokens += request.usage.outputTokens;
      }
      result.reasoningCharacters += request.responseContent.reasoningCharacters;
      result.visibleCharacters += request.responseContent.visibleCharacters;
      return result;
    },
    {
      requestCount: rows.length,
      measuredRequestCount: 0,
      usageRequestCount: 0,
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      totalInputTokens: 0,
      outputTokens: 0,
      cacheReadRate: 0,
      reasoningCharacters: 0,
      visibleCharacters: 0,
    },
  );
  totals.cacheReadRate = totals.totalInputTokens === 0
    ? 0
    : totals.cacheReadTokens / totals.totalInputTokens;
  return {
    schema: 'pair-request-analysis/v1',
    pairId,
    requests: rows,
    totals,
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function renderPairRequestAnalysisMarkdown(
  analysis: PairRequestAnalysis,
): string {
  const lines = [
    `# Pair request analysis: ${analysis.pairId ?? 'unknown Pair'}`,
    '',
    `Requests: ${analysis.totals.requestCount}; measured: ${analysis.totals.measuredRequestCount}; with Provider usage: ${analysis.totals.usageRequestCount}.`,
    '',
    '| Role | Turn/step/attempt | Shared head | Estimated segment tokens | First changed segment | Total input | Cache read | Cache rate | Output |',
    '| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |',
  ];
  for (const request of analysis.requests) {
    lines.push(
      `| ${request.role} | ${request.turn}/${request.step}/${request.attempt} | ${request.sharedHead} | ${request.segmentMeasurements?.estimatedTokens ?? 'n/a'} | ${request.firstChangedSegment ?? 'n/a'} | ${request.usage?.totalInputTokens ?? 'n/a'} | ${request.usage?.cacheReadTokens ?? 'n/a'} | ${request.usage === null ? 'n/a' : percent(request.usage.cacheReadRate)} | ${request.usage?.outputTokens ?? 'n/a'} |`,
    );
  }
  lines.push(
    '',
    `Combined cache read rate: ${percent(analysis.totals.cacheReadRate)} (${analysis.totals.cacheReadTokens}/${analysis.totals.totalInputTokens} input tokens).`,
    `Reasoning/visible response characters: ${analysis.totals.reasoningCharacters}/${analysis.totals.visibleCharacters}.`,
  );
  if (analysis.totals.measuredRequestCount < analysis.totals.requestCount) {
    lines.push('', 'Segment measurements unavailable for one or more legacy requests.');
  }
  return `${lines.join('\n')}\n`;
}
