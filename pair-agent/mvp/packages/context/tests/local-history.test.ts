import { describe, expect, it } from 'vitest';

import {
  LocalHistoryInvariantError,
  projectLocalHistory,
  type LocalBoundaryMessage,
  type RequestLocalSessionLink,
  type SessionEventPairSpanLink,
} from '../src/index.js';

const sessionId = 'pair:pair-01:pilot';

function boundary(
  sessionSeq: number,
  message: LocalBoundaryMessage['message'],
): LocalBoundaryMessage {
  return {
    sessionId,
    sessionSeq,
    messageId: `message-${sessionSeq}`,
    message,
  };
}

function link(
  fromSessionSeq: number,
  throughSessionSeq: number,
  representation: SessionEventPairSpanLink['representation'],
  pairEventId = `pair-event-${fromSessionSeq}`,
): SessionEventPairSpanLink {
  return {
    sessionId,
    fromSessionSeq,
    throughSessionSeq,
    messageIds: Array.from(
      { length: throughSessionSeq - fromSessionSeq + 1 },
      (_, index) => `message-${fromSessionSeq + index}`,
    ),
    representation,
    pairEventId,
  };
}

function requestLocalLink(
  sessionSeq: number,
  proof: RequestLocalSessionLink['proof'],
): RequestLocalSessionLink {
  return {
    ...link(sessionSeq, sessionSeq, 'full', proof.kind === 'pair-delivery'
      ? proof.pairEventId
      : 'pair-event-current'),
    persistence: 'request-local',
    proof,
  };
}

describe('projectLocalHistory', () => {
  it('rejects a boundary that has no own message value to preserve', () => {
    const missingMessage = {
      sessionId,
      sessionSeq: 1,
      messageId: 'message-1',
    } as never;

    expect(() =>
      projectLocalHistory([missingMessage], [], {
        expectedSessionId: sessionId,
      }),
    ).toThrow(LocalHistoryInvariantError);
    expect(() =>
      projectLocalHistory([missingMessage], [], {
        expectedSessionId: sessionId,
      }),
    ).toThrow(/boundary message is required/);
  });

  it('degrades and retains the full boundary when message identities repeat', () => {
    const input = [
      boundary(1, { role: 'user', content: 'first' }),
      {
        ...boundary(2, { role: 'assistant', content: 'second' }),
        messageId: 'message-1',
      },
    ];

    const projected = projectLocalHistory(
      input,
      [link(1, 2, 'full')],
      { expectedSessionId: sessionId },
    );

    expect(projected.status).toBe('degraded');
    expect(projected.messages).toEqual(input.map(({ message }) => message));
    expect(projected.malformedEntries).toEqual([]);
    expect(projected.spans).toEqual([
      expect.objectContaining({
        decision: 'degraded',
        reason: 'duplicate-message-id',
      }),
    ]);
  });

  it('degrades and retains the full boundary when a message belongs to another session', () => {
    const input = [
      boundary(1, { role: 'user', content: 'expected' }),
      {
        ...boundary(2, { role: 'assistant', content: 'foreign' }),
        sessionId: 'pair:other:pilot',
      },
    ];

    const projected = projectLocalHistory(input, [], {
      expectedSessionId: sessionId,
    });

    expect(projected.status).toBe('degraded');
    expect(projected.messages).toEqual(input.map(({ message }) => message));
    expect(projected.malformedEntries).toEqual([]);
    expect(projected.spans[0]).toEqual(
      expect.objectContaining({
        decision: 'degraded',
        reason: 'unexpected-boundary-session',
      }),
    );
  });

  it('degrades and retains the full boundary when any link belongs to another session', () => {
    const input = [boundary(1, { role: 'user', content: 'must stay' })];
    const foreignLink = {
      ...link(1, 1, 'full'),
      sessionId: 'pair:other:pilot',
    };

    const projected = projectLocalHistory(input, [foreignLink], {
      expectedSessionId: sessionId,
    });

    expect(projected.status).toBe('degraded');
    expect(projected.messages).toEqual(input.map(({ message }) => message));
    expect(projected.malformedEntries).toEqual([]);
    expect(projected.spans[0]).toEqual(
      expect.objectContaining({
        decision: 'degraded',
        reason: 'unexpected-link-session',
      }),
    );
  });

  it('conservatively retains a JSON-safe boundary with an impossible role combination', () => {
    const malformed = {
      role: 'assistant',
      content: 'must not be deduplicated',
      toolCallId: 'impossible-on-assistant',
      toolCalls: [{ id: 'call-1', name: 'inspect', arguments: {} }],
    };
    const result = {
      role: 'tool',
      content: { ok: true },
      toolCallId: 'call-1',
    } as const;
    const input = [boundary(1, malformed as never), boundary(2, result)];

    const projected = projectLocalHistory(input, [link(1, 2, 'full')], {
      expectedSessionId: sessionId,
    });

    expect(projected.status).toBe('degraded');
    expect(projected.messages).toEqual([result]);
    expect(projected.malformedEntries).toEqual([
      {
        index: 0,
        sessionId,
        sessionSeq: 1,
        messageId: 'message-1',
        raw: malformed,
        reason: 'malformed-normalized-message',
      },
    ]);
    expect(projected.spans).toEqual([
      expect.objectContaining({
        fromSessionSeq: 1,
        throughSessionSeq: 2,
        decision: 'degraded',
        reason: 'malformed-normalized-message',
        linkedPairEventIds: ['pair-event-1'],
      }),
    ]);
  });

  it('retains the whole call span when a tool result has an impossible field', () => {
    const assistant = boundary(1, {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call-1', name: 'inspect', arguments: {} }],
    });
    const malformedResult = boundary(2, {
      role: 'tool',
      content: { ok: true },
      toolCallId: 'call-1',
      name: 'forbidden-on-tool',
    } as never);

    const projected = projectLocalHistory(
      [assistant, malformedResult],
      [link(1, 2, 'full')],
      { expectedSessionId: sessionId },
    );

    expect(projected.status).toBe('degraded');
    expect(projected.messages).toEqual([assistant.message]);
    expect(projected.malformedEntries).toEqual([
      expect.objectContaining({
        index: 1,
        sessionSeq: 2,
        messageId: 'message-2',
        raw: malformedResult.message,
        reason: 'malformed-normalized-message',
      }),
    ]);
    expect(projected.spans).toEqual([
      expect.objectContaining({
        fromSessionSeq: 1,
        throughSessionSeq: 2,
        decision: 'degraded',
        reason: 'malformed-normalized-message',
      }),
    ]);
  });

  it('retains a JSON-safe message whose tool arguments are not an object', () => {
    const malformed = boundary(1, {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call-1', name: 'inspect', arguments: [] }],
    } as never);

    const projected = projectLocalHistory(
      [malformed],
      [link(1, 1, 'full')],
      { expectedSessionId: sessionId },
    );

    expect(projected.status).toBe('degraded');
    expect(projected.messages).toEqual([]);
    expect(projected.malformedEntries).toEqual([
      expect.objectContaining({
        index: 0,
        raw: malformed.message,
        reason: 'malformed-normalized-message',
      }),
    ]);
    expect(projected.spans).toEqual([
      expect.objectContaining({
        decision: 'degraded',
        reason: 'malformed-normalized-message',
      }),
    ]);
  });

  it('excludes an ordinary message fully represented by a persisted link', () => {
    const input = [boundary(1, { role: 'user', content: 'shared fact' })];

    const projected = projectLocalHistory(input, [link(1, 1, 'full')], {
      expectedSessionId: sessionId,
    });

    expect(projected.messages).toEqual([]);
    expect(projected.status).toBe('safe');
    expect(projected.malformedEntries).toEqual([]);
    expect(projected.spans).toEqual([
      expect.objectContaining({
        fromSessionSeq: 1,
        throughSessionSeq: 1,
        messageIds: ['message-1'],
        decision: 'excluded',
        reason: 'fully-represented-in-pair',
        linkedPairEventIds: ['pair-event-1'],
      }),
    ]);
  });

  it('retains summary, artifact, unlinked and unknown representations', () => {
    const input = [
      boundary(1, { role: 'user', content: 'summary source' }),
      boundary(2, { role: 'assistant', content: 'artifact source' }),
      boundary(3, { role: 'user', content: 'unlinked source' }),
      boundary(4, { role: 'assistant', content: 'unknown source' }),
    ];
    const links: readonly SessionEventPairSpanLink[] = [
      link(1, 1, 'summary'),
      link(2, 2, 'artifact-ref'),
      link(4, 4, 'future-format' as never),
    ];

    const projected = projectLocalHistory(input, links, {
      expectedSessionId: sessionId,
    });

    expect(projected.messages).toEqual(input.map(({ message }) => message));
    expect(projected.spans.map(({ decision, reason }) => ({ decision, reason })))
      .toEqual([
        { decision: 'retained', reason: 'summary-representation' },
        { decision: 'retained', reason: 'artifact-ref-representation' },
        { decision: 'retained', reason: 'unlinked' },
        { decision: 'retained', reason: 'unknown-representation' },
      ]);
  });

  it('accepts a proven request-local full link only through the current request option', () => {
    const input = [boundary(1, { role: 'user', content: 'already shared now' })];
    const current = requestLocalLink(1, {
      kind: 'pair-delivery',
      pairEventId: 'pair-01:2',
      deliveryId: 'pair-01:2',
    });

    const projected = projectLocalHistory(input, [], {
      expectedSessionId: sessionId,
      requestLocalLinks: [current],
    });

    expect(projected.messages).toEqual([]);
    expect(projected.spans).toEqual([
      expect.objectContaining({
        messageIds: ['message-1'],
        decision: 'excluded',
        reason: 'fully-represented-in-pair',
        linkedPairEventIds: ['pair-01:2'],
      }),
    ]);
  });

  it('rejects request-local proof links passed as reusable persisted links', () => {
    const current = requestLocalLink(1, {
      kind: 'native-composer',
      sourceEventId: `dsh:${sessionId}:1:user.message`,
    });

    expect(() =>
      projectLocalHistory(
        [boundary(1, { role: 'user', content: 'current native input' })],
        [current],
        { expectedSessionId: sessionId },
      ),
    ).toThrow(/request-local links must be supplied for the current request/);
  });

  it('rejects an unknown request-local proof discriminant', () => {
    const forged = {
      ...requestLocalLink(1, {
        kind: 'native-composer',
        sourceEventId: `dsh:${sessionId}:1:user.message`,
      }),
      proof: { kind: 'forged-proof', sourceEventId: 'forged' },
    };

    expect(() =>
      projectLocalHistory(
        [boundary(1, { role: 'user', content: 'must not deduplicate' })],
        [],
        {
          expectedSessionId: sessionId,
          requestLocalLinks: [forged as never],
        },
      ),
    ).toThrow(/request-local proof kind is invalid/);
  });

  it('rejects redundant request-local proof when an exact persisted full link exists', () => {
    const persisted = link(1, 1, 'full', 'pair-01:2');
    const current = requestLocalLink(1, {
      kind: 'pair-delivery',
      pairEventId: 'pair-01:2',
      deliveryId: 'pair-01:2',
    });

    expect(() =>
      projectLocalHistory(
        [boundary(1, { role: 'user', content: 'persistently represented' })],
        [persisted],
        {
          expectedSessionId: sessionId,
          requestLocalLinks: [current],
        },
      ),
    ).toThrow(/request-local proof is redundant/);
  });

  it('excludes a complete multi-call tool protocol only as one linked span', () => {
    const input = [
      boundary(1, {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'call-a', name: 'read', arguments: { path: '/a' } },
          { id: 'call-b', name: 'read', arguments: { path: '/b' } },
        ],
      }),
      boundary(2, { role: 'tool', content: { ok: true }, toolCallId: 'call-a' }),
      boundary(3, { role: 'tool', content: { ok: true }, toolCallId: 'call-b' }),
    ];

    const projected = projectLocalHistory(input, [link(1, 3, 'full')], {
      expectedSessionId: sessionId,
    });

    expect(projected.messages).toEqual([]);
    expect(projected.spans).toEqual([
      expect.objectContaining({
        fromSessionSeq: 1,
        throughSessionSeq: 3,
        decision: 'excluded',
        reason: 'fully-represented-in-pair',
        linkedPairEventIds: ['pair-event-1'],
      }),
    ]);
  });

  it('retains an entire tool span when the full link covers only part of it', () => {
    const input = [
      boundary(1, {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'call-a', name: 'read', arguments: {} },
          { id: 'call-b', name: 'write', arguments: {} },
        ],
      }),
      boundary(2, { role: 'tool', content: 'a', toolCallId: 'call-a' }),
      boundary(3, { role: 'tool', content: 'b', toolCallId: 'call-b' }),
    ];

    const projected = projectLocalHistory(input, [link(1, 2, 'full')], {
      expectedSessionId: sessionId,
    });

    expect(projected.messages).toEqual(input.map(({ message }) => message));
    expect(projected.spans).toEqual([
      expect.objectContaining({
        fromSessionSeq: 1,
        throughSessionSeq: 3,
        decision: 'retained',
        reason: 'incomplete-protocol-link',
      }),
    ]);
  });

  it('retains out-of-order tool results as one malformed span', () => {
    const input = [
      boundary(1, {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'call-a', name: 'a', arguments: {} },
          { id: 'call-b', name: 'b', arguments: {} },
        ],
      }),
      boundary(2, { role: 'tool', content: 'b', toolCallId: 'call-b' }),
      boundary(3, { role: 'tool', content: 'a', toolCallId: 'call-a' }),
    ];

    const projected = projectLocalHistory(input, [link(1, 3, 'full')], {
      expectedSessionId: sessionId,
    });

    expect(projected.messages).toEqual(input.map(({ message }) => message));
    expect(projected.status).toBe('degraded');
    expect(projected.malformedEntries).toEqual([]);
    expect(projected.spans[0]).toEqual(
      expect.objectContaining({
        decision: 'degraded',
        reason: 'malformed-tool-protocol',
      }),
    );
  });

  it('retains an incomplete call/result span and an orphan result', () => {
    const incomplete = projectLocalHistory(
      [
        boundary(1, {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'call-a', name: 'a', arguments: {} },
            { id: 'call-b', name: 'b', arguments: {} },
          ],
        }),
        boundary(2, { role: 'tool', content: 'a', toolCallId: 'call-a' }),
      ],
      [link(1, 2, 'full')],
      { expectedSessionId: sessionId },
    );
    const orphan = projectLocalHistory(
      [boundary(1, { role: 'tool', content: 'orphan', toolCallId: 'missing' })],
      [link(1, 1, 'full')],
      { expectedSessionId: sessionId },
    );

    expect(incomplete.messages).toHaveLength(2);
    expect(incomplete.status).toBe('degraded');
    expect(incomplete.malformedEntries).toEqual([]);
    expect(incomplete.spans[0]?.reason).toBe('malformed-tool-protocol');
    expect(orphan.messages).toHaveLength(1);
    expect(orphan.status).toBe('degraded');
    expect(orphan.malformedEntries).toEqual([]);
    expect(orphan.spans[0]?.reason).toBe('malformed-tool-protocol');
  });

  it('conservatively retains all input when session sequences are not increasing', () => {
    const input = [
      boundary(2, { role: 'user', content: 'later' }),
      boundary(1, { role: 'assistant', content: 'earlier' }),
    ];

    const projected = projectLocalHistory(input, [link(1, 2, 'full')], {
      expectedSessionId: sessionId,
    });

    expect(projected.messages).toEqual(input.map(({ message }) => message));
    expect(projected.spans).toEqual([
      expect.objectContaining({
        decision: 'degraded',
        reason: 'malformed-message-order',
        messageIds: ['message-2', 'message-1'],
      }),
    ]);
  });
});
