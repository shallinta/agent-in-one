import { describe, expect, test } from 'vitest';

import { PendingRequestHandoffs } from '../src/dsh-adapter.js';
import type { PersistedPairRequest } from '../src/pair-request-plugin.js';

function request(id: string, seq: number): PersistedPairRequest {
  return {
    requestId: id,
    snapshotLedgerSeq: seq,
    messages: [],
    snapshot: {},
    fullRequestDigest: `sha256:${'a'.repeat(64)}`,
  };
}

describe('PendingRequestHandoffs', () => {
  test('drops an aborted layout before Provider and binds the next same-digest request exactly', () => {
    const handoffs = new PendingRequestHandoffs();
    const aborted = new AbortController();
    const live = new AbortController();
    handoffs.enqueue('session-1', request('attempt-1', 10), aborted.signal);
    aborted.abort();
    handoffs.enqueue('session-1', request('attempt-2', 11), live.signal);

    expect(handoffs.claim('session-1')).toMatchObject({
      requestId: 'attempt-2',
      snapshotLedgerSeq: 11,
    });
    expect(handoffs.claim('session-1')).toBeUndefined();
  });
});
