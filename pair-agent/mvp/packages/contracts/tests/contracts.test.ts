import { describe, expect, test } from 'vitest';

import {
  MAX_PAIR_MESSAGE_BYTES,
  MAX_PEER_HOPS,
  type AssignPairTaskRequest,
  type CreatePairRequest,
  InvalidPairIdError,
  PAIR_EVENT_TYPES,
  type PairEvent,
  type SendPairMessageRequest,
  assertP05PairEventPayload,
  canonicalJsonStringify,
  createPairSessionIds,
  isPeerAgentMessage,
  isPairEventType,
  parsePairId,
  parseSessionEventsQuery,
} from '../src/index.js';

describe('Pair Host request DTOs', () => {
  test('keeps Pair creation client-owned input to pairId only', () => {
    const request = { pairId: 'pair-01' } satisfies CreatePairRequest;
    expect(request).toEqual({ pairId: 'pair-01' });
  });

  test('requires message CAS in the exported request shape', () => {
    const request = {
      text: 'hello Navigator',
      expectedLedgerHead: 2,
    } satisfies SendPairMessageRequest;
    expect(request.expectedLedgerHead).toBe(2);
  });

  test('requires task CAS around the existing PairTask assignment shape', () => {
    const request = {
      expectedLedgerHead: 2,
      task: {
        id: 'task-01',
        revision: 1,
        summary: 'Implement host',
        state: 'queued',
      },
      goalRef: { id: 'goal-01', version: 1 },
    } satisfies AssignPairTaskRequest;
    expect(request.task).toMatchObject({ revision: 1, state: 'queued' });
  });
});

describe('PairId', () => {
  test('maps one valid PairId to two deterministic, distinct session IDs', () => {
    const first = createPairSessionIds('pair_01-A');
    const second = createPairSessionIds(parsePairId('pair_01-A'));

    expect(first).toEqual({
      navigatorSessionId: 'pair:pair_01-A:navigator',
      pilotSessionId: 'pair:pair_01-A:pilot',
    });
    expect(second).toEqual(first);
    expect(first.navigatorSessionId).not.toBe(first.pilotSessionId);
  });

  test.each([
    '',
    ' ',
    'a/b',
    '..',
    'a\\b',
    'a:b',
    'a.b',
    'line\nbreak',
    'x'.repeat(129),
  ])('rejects unsafe PairId %j', (candidate) => {
    expect(() => parsePairId(candidate)).toThrow(InvalidPairIdError);
    expect(() => createPairSessionIds(candidate)).toThrow(InvalidPairIdError);
  });

  test('rejects values that are not strings', () => {
    expect(() => parsePairId(42)).toThrow(InvalidPairIdError);
  });

  test('always throws InvalidPairIdError for BigInt and circular inputs', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => parsePairId(1n)).toThrow(InvalidPairIdError);
    expect(() => parsePairId(circular)).toThrow(InvalidPairIdError);
  });
});

describe('canonical JSON', () => {
  test('serializes equivalent objects to byte-identical JSON independent of insertion order', () => {
    const left = { z: 1, nested: { b: true, a: 'value' }, a: [2, 1] };
    const right = { a: [2, 1], nested: { a: 'value', b: true }, z: 1 };

    expect(canonicalJsonStringify(left)).toBe(
      '{"a":[2,1],"nested":{"a":"value","b":true},"z":1}',
    );
    expect(canonicalJsonStringify(right)).toBe(canonicalJsonStringify(left));
  });

  test('preserves an own __proto__ key as data', () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.alpha = 1;
    value.__proto__ = { retained: true };

    expect(canonicalJsonStringify(value)).toBe(
      '{"__proto__":{"retained":true},"alpha":1}',
    );
  });

  test.each([
    ['undefined', { nested: { value: undefined } }],
    ['non-finite number', { nested: { value: Number.NaN } }],
    ['Date', { nested: { value: new Date('2026-08-26T00:00:00.000Z') } }],
  ])('rejects non-JSON %s instead of rewriting it', (_label, value) => {
    expect(() => canonicalJsonStringify(value)).toThrow(/JSON/i);
  });

  test('reports a circular JSON value explicitly', () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(() => canonicalJsonStringify(value)).toThrow(/circular/i);
  });

  test('rejects symbol-keyed properties that JSON would silently omit', () => {
    const value = { retained: true } as Record<PropertyKey, unknown>;
    value[Symbol('hidden')] = 'not durable';

    expect(() => canonicalJsonStringify(value)).toThrow(/JSON/i);
  });

  test('rejects non-enumerable object properties instead of omitting them', () => {
    const value = { visible: true } as Record<string, unknown>;
    Object.defineProperty(value, 'hidden', {
      value: 'not durable',
      enumerable: false,
    });

    expect(() => canonicalJsonStringify(value)).toThrow(/JSON/i);
  });

  test('rejects object accessors without invoking them', () => {
    let invoked = false;
    const value = {} as Record<string, unknown>;
    Object.defineProperty(value, 'computed', {
      enumerable: true,
      get() {
        invoked = true;
        return 'not data';
      },
    });

    expect(() => canonicalJsonStringify(value)).toThrow(/JSON/i);
    expect(invoked).toBe(false);
  });

  test.each([
    [
      'extra non-enumerable property',
      () => {
        const value = ['item'];
        Object.defineProperty(value, 'hidden', { value: true });
        return value;
      },
    ],
    [
      'accessor element',
      () => {
        const value = ['item'];
        Object.defineProperty(value, '0', {
          enumerable: true,
          get: () => 'computed',
        });
        return value;
      },
    ],
    [
      'symbol property',
      () => {
        const value = ['item'] as unknown[] & Record<PropertyKey, unknown>;
        value[Symbol('hidden')] = true;
        return value;
      },
    ],
    ['sparse element', () => new Array(1)],
  ])('rejects an array with %s', (_label, createValue) => {
    expect(() => canonicalJsonStringify(createValue())).toThrow(/JSON/i);
  });
});

describe('PairEventType runtime contract', () => {
  test('has one closed runtime set shared by type guards and persistence', () => {
    expect(PAIR_EVENT_TYPES).toContain('pair.created');
    expect(PAIR_EVENT_TYPES).toContain('delivery.superseded');
    expect(PAIR_EVENT_TYPES.every(isPairEventType)).toBe(true);
    expect(isPairEventType('unknown.event')).toBe(false);
    expect(isPairEventType('')).toBe(false);
  });
});

describe('P0.5 Session Events query contract', () => {
  test('parses explicit physical cursor pagination values', () => {
    expect(
      parseSessionEventsQuery({
        afterSeq: '4',
        limit: '2',
        view: 'semantic',
      }),
    ).toEqual({ afterSeq: 4, limit: 2, view: 'semantic' });
  });

  test('supplies bounded semantic defaults', () => {
    expect(parseSessionEventsQuery({})).toEqual({
      afterSeq: 0,
      limit: 100,
      view: 'semantic',
    });
  });

  test.each([
    [{ afterSeq: '-1' }, /afterSeq/],
    [{ afterSeq: '1.5' }, /afterSeq/],
    [{ afterSeq: String(Number.MAX_SAFE_INTEGER + 1) }, /afterSeq/],
    [{ limit: '0' }, /limit/],
    [{ limit: '501' }, /limit/],
    [{ limit: '2.5' }, /limit/],
    [{ view: 'private' }, /view/],
    [{ unexpected: 'value' }, /unexpected/],
  ])('rejects invalid query %#', (query, expected) => {
    expect(() => parseSessionEventsQuery(query)).toThrow(expected);
  });
});

describe('P0.5 message payload contract', () => {
  const origin = {
    schemaVersion: 1,
    sessionId: 'pair:pair-01:navigator',
    sessionEventSeq: 42,
    turn: 3,
    messageId: 'message-01',
  } as const;

  test('accepts a versioned user input payload at the UTF-8 byte limit', () => {
    const payload = {
      schemaVersion: 1,
      kind: 'user-input',
      text: 'a'.repeat(MAX_PAIR_MESSAGE_BYTES),
      content: [{ type: 'text', text: 'hello' }],
      origin,
    };

    expect(assertP05PairEventPayload('user.message', payload)).toBe(payload);
  });

  test('accepts a complete versioned turn output', () => {
    const payload = {
      schemaVersion: 1,
      kind: 'turn-output',
      text: 'done',
      content: [{ type: 'text', text: 'done' }],
      completion: 'complete',
      origin,
    };

    expect(assertP05PairEventPayload('agent.message', payload)).toBe(payload);
  });

  test('accepts a bounded peer message', () => {
    const payload = {
      schemaVersion: 1,
      kind: 'peer-message',
      text: 'please inspect the failing test',
      content: [{ type: 'text', text: 'please inspect the failing test' }],
      causalRootId: 'pair-event-10',
      hop: MAX_PEER_HOPS,
    };

    expect(assertP05PairEventPayload('agent.message', payload)).toBe(payload);
  });

  test.each([
    [
      'empty peer text',
      {
        schemaVersion: 1,
        kind: 'peer-message',
        text: '   ',
        content: [],
        causalRootId: 'root-1',
        hop: 1,
      },
      /text/,
    ],
    [
      'text over 64 KiB',
      {
        schemaVersion: 1,
        kind: 'peer-message',
        text: 'a'.repeat(MAX_PAIR_MESSAGE_BYTES + 1),
        content: [],
        causalRootId: 'root-1',
        hop: 1,
      },
      /64 KiB|text/,
    ],
    [
      'peer hop over the fixed limit',
      {
        schemaVersion: 1,
        kind: 'peer-message',
        text: 'continue',
        content: [],
        causalRootId: 'root-1',
        hop: MAX_PEER_HOPS + 1,
      },
      /hop/,
    ],
    [
      'unknown payload field',
      {
        schemaVersion: 1,
        kind: 'turn-output',
        text: 'done',
        content: [],
        completion: 'complete',
        unexpected: true,
      },
      /unexpected/,
    ],
  ])('rejects %s', (_label, payload, expected) => {
    expect(() => assertP05PairEventPayload('agent.message', payload)).toThrow(
      expected,
    );
  });

  test('rejects a message discriminant that does not match its event type', () => {
    expect(() =>
      assertP05PairEventPayload('user.message', {
        schemaVersion: 1,
        kind: 'turn-output',
        text: 'wrong actor',
        content: [],
        completion: 'complete',
      }),
    ).toThrow(/kind/);
  });

  test('validates exact versioned Session link payloads', () => {
    const payload = {
      schemaVersion: 1,
      sessionId: origin.sessionId,
      fromSessionSeq: 40,
      throughSessionSeq: 42,
      messageIds: [origin.messageId],
      pairEventId: 'pair-event-42',
      representation: 'full',
    };

    expect(assertP05PairEventPayload('session_event.linked', payload)).toBe(
      payload,
    );
    expect(() =>
      assertP05PairEventPayload('session_event.linked', {
        ...payload,
        throughSessionSeq: 39,
      }),
    ).toThrow(/throughSessionSeq/);
    expect(() =>
      assertP05PairEventPayload('session_event.linked', {
        ...payload,
        extra: true,
      }),
    ).toThrow(/extra/);
  });
});

describe('peer Agent message classification', () => {
  const peerEvent: PairEvent = {
    pairId: parsePairId('pair-01'),
    seq: 8,
    type: 'agent.message',
    actor: { kind: 'agent', role: 'navigator' },
    source: 'navigator-session',
    channel: 'pilot',
    visibility: 'shared',
    authority: 'navigator',
    refs: {},
    payload: {
      schemaVersion: 1,
      kind: 'peer-message',
      text: 'please continue',
      content: [{ type: 'text', text: 'please continue' }],
      causalRootId: 'pair-event-7',
      hop: 1,
    },
    occurredAt: '2026-08-31T00:00:00.000Z',
  };

  test('requires a cross-role channel and peer-message payload', () => {
    expect(isPeerAgentMessage(peerEvent)).toBe(true);
    expect(
      isPeerAgentMessage({ ...peerEvent, channel: 'navigator' }),
    ).toBe(false);
    expect(
      isPeerAgentMessage({
        ...peerEvent,
        payload: { ...peerEvent.payload, kind: 'turn-output' },
      }),
    ).toBe(false);
  });
});
