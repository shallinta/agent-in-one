import { describe, expect, test } from 'vitest';

import type { PairEvent, PairRole } from '@pair-agent/contracts';
import { validatePairRequestCoordinates } from '../src/dsh-adapter.js';

function requestEvent(
  seq: number,
  sessionId: string,
  role: PairRole,
  requestId = `${sessionId}:1:1:1`,
): PairEvent {
  return {
    pairId: 'audit-pair' as never,
    seq,
    type: 'pair.request_built',
    actor: { kind: 'host' },
    source: 'pair',
    channel: 'shared-control',
    visibility: 'infrastructure',
    authority: 'host',
    refs: {},
    payload: {
      requestId,
      snapshot: {
        requestId,
        sessionId,
        role,
        turn: 1,
        step: 1,
        attempt: 1,
        fullRequestDigest: `sha256:${'a'.repeat(64)}`,
      },
    },
    occurredAt: '2026-01-01T00:00:00.000Z',
  } as PairEvent;
}

describe('Pair-level historical request coordinates', () => {
  test('rejects an unknown or cross-Pair Session', () => {
    expect(() =>
      validatePairRequestCoordinates('audit-pair', [
        requestEvent(3, 'pair:another-pair:navigator', 'navigator'),
      ]),
    ).toThrow(/authoritative coordinates/i);
  });

  test('rejects a role that conflicts with the authoritative Session mapping', () => {
    expect(() =>
      validatePairRequestCoordinates('audit-pair', [
        requestEvent(3, 'pair:audit-pair:navigator', 'pilot'),
      ]),
    ).toThrow(/authoritative coordinates/i);
  });

  test('rejects duplicate request IDs before reconstruction', () => {
    const event = requestEvent(3, 'pair:audit-pair:navigator', 'navigator');
    expect(() =>
      validatePairRequestCoordinates('audit-pair', [
        event,
        { ...event, seq: 4 },
      ]),
    ).toThrow(/duplicate.*requestId/i);
  });
});
