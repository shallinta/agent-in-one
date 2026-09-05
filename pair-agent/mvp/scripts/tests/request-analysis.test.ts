import { describe, expect, test } from 'vitest';

import {
  analyzePairRequests,
  renderPairRequestAnalysisMarkdown,
} from '../request-analysis.js';
import {
  parseRequestAnalysisOptions,
  pairSessionLogPath,
} from '../request-analysis-cli.js';

const common = {
  schema: 'pair-request-segments/v1',
  tokenEstimateMethod: 'utf8-bytes-div-4/v1',
  categorizedUtf8Bytes: 310,
  estimatedTokens: 79,
  sharedEventCount: 2,
  localMessageCount: 1,
  segments: [
    { name: 'common-system', utf8Bytes: 100, estimatedTokens: 25, itemCount: 1, digest: 'sha256:common' },
    { name: 'shared-events', utf8Bytes: 80, estimatedTokens: 20, itemCount: 1, digest: 'sha256:events-1' },
    { name: 'shared-projection', utf8Bytes: 40, estimatedTokens: 10, itemCount: 1, digest: 'sha256:projection-1' },
    { name: 'local-history', utf8Bytes: 40, estimatedTokens: 10, itemCount: 1, digest: 'sha256:local-1' },
    { name: 'active-role', utf8Bytes: 20, estimatedTokens: 5, itemCount: 1, digest: 'sha256:role' },
    { name: 'current-trigger', utf8Bytes: 10, estimatedTokens: 3, itemCount: 1, digest: 'sha256:trigger' },
    { name: 'tool-schemas', utf8Bytes: 10, estimatedTokens: 3, itemCount: 1, digest: 'sha256:tools' },
    { name: 'request-config', utf8Bytes: 10, estimatedTokens: 3, itemCount: 1, digest: 'sha256:config' },
  ],
} as const;

function requestEvent(
  seq: number,
  requestId: string,
  role: 'navigator' | 'pilot',
  turn: number,
  measurements: unknown = common,
) {
  return {
    pairId: 'pair-analysis',
    seq,
    type: 'pair.request_built',
    payload: {
      requestId,
      snapshot: {
        requestId,
        role,
        turn,
        step: 1,
        attempt: 1,
        sharedHead: seq - 1,
        sourceLedgerHead: seq - 1,
        segmentMeasurements: measurements,
      },
    },
  };
}

describe('request analysis', () => {
  test('joins successful provider usage and locates the first changed segment', () => {
    const secondMeasurements = structuredClone(common) as unknown as {
      segments: Array<{ name: string; digest: string }>;
    } & Record<string, unknown>;
    secondMeasurements.segments[1]!.digest = 'sha256:events-2';
    secondMeasurements.segments[2]!.digest = 'sha256:projection-2';

    const analysis = analyzePairRequests(
      [
        requestEvent(2, 'pair:pair-analysis:navigator:1:1:1', 'navigator', 1),
        requestEvent(4, 'pair:pair-analysis:pilot:1:1:1', 'pilot', 1, secondMeasurements),
      ],
      {
        navigator: [
          {
            type: 'assistant/chunk',
            data: {
              turn: 1,
              step: 1,
              chunk: {
                type: 'usage',
                usage: { inputTokens: 100, cacheReadTokens: 60, outputTokens: 20 },
              },
            },
          },
          {
            type: 'assistant/message',
            data: {
              turn: 1,
              step: 1,
              message: {
                role: 'assistant',
                content: [
                  { type: 'reasoning', text: 'think' },
                  { type: 'text', text: 'answer' },
                ],
              },
            },
          },
        ],
        pilot: [
          {
            type: 'assistant/message',
            data: {
              turn: 1,
              step: 1,
              usage: { inputTokens: 80, cacheReadTokens: 40, outputTokens: 10 },
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'done' }],
              },
            },
          },
        ],
      },
    );

    expect(analysis.requests).toHaveLength(2);
    expect(analysis.requests[0]).toMatchObject({
      requestId: 'pair:pair-analysis:navigator:1:1:1',
      usage: {
        uncachedInputTokens: 100,
        cacheReadTokens: 60,
        totalInputTokens: 160,
        outputTokens: 20,
        cacheReadRate: 0.375,
      },
      responseContent: { reasoningCharacters: 5, visibleCharacters: 6 },
      firstChangedSegment: null,
    });
    expect(analysis.requests[1]).toMatchObject({
      usage: {
        uncachedInputTokens: 80,
        cacheReadTokens: 40,
        totalInputTokens: 120,
        outputTokens: 10,
        cacheReadRate: 1 / 3,
      },
      responseContent: { reasoningCharacters: 0, visibleCharacters: 4 },
      firstChangedSegment: 'shared-events',
    });
    expect(analysis.totals).toMatchObject({
      requestCount: 2,
      measuredRequestCount: 2,
      usageRequestCount: 2,
      uncachedInputTokens: 180,
      cacheReadTokens: 100,
      totalInputTokens: 280,
      outputTokens: 30,
      cacheReadRate: 100 / 280,
      reasoningCharacters: 5,
      visibleCharacters: 10,
    });
  });

  test('keeps legacy requests visible when segment measurements are absent', () => {
    const legacy = requestEvent(
      2,
      'pair:pair-analysis:navigator:1:1:1',
      'navigator',
      1,
      undefined,
    );
    delete (legacy.payload.snapshot as Record<string, unknown>).segmentMeasurements;

    const analysis = analyzePairRequests([legacy], { navigator: [], pilot: [] });

    expect(analysis.requests[0]?.segmentMeasurements).toBeNull();
    expect(analysis.totals).toMatchObject({
      requestCount: 1,
      measuredRequestCount: 0,
      usageRequestCount: 0,
    });
    expect(renderPairRequestAnalysisMarkdown(analysis)).toContain(
      'Segment measurements unavailable',
    );
  });
});

describe('request analysis CLI', () => {
  test('resolves one Pair data root without depending on Provider configuration', () => {
    expect(parseRequestAnalysisOptions(
      ['--pair-id', 'pair-analysis', '--data-root', '/tmp/pair-analysis', '--format', 'json'],
      {},
    )).toEqual({
      pairId: 'pair-analysis',
      dataRoot: '/tmp/pair-analysis',
      format: 'json',
    });
    expect(
      pairSessionLogPath('/tmp/pair-analysis', 'pair:pair-analysis:navigator'),
    ).toBe(
      '/tmp/pair-analysis/dsh-sessions/_no-cwd/pair~003Apair-analysis~003Anavigator/session.jsonl',
    );
  });

  test('rejects unknown flags and relative data roots', () => {
    expect(() => parseRequestAnalysisOptions(['--unknown'], {})).toThrow(
      /unknown argument/,
    );
    expect(() => parseRequestAnalysisOptions(
      ['--pair-id', 'pair-analysis', '--data-root', 'relative'],
      {},
    )).toThrow(/absolute/);
  });
});
