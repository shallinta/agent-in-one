import {
  type JsonObject,
  type JsonValue,
  type PairEvent,
  type PairRole,
  MAX_PEER_HOPS,
  parsePairId,
} from '@pair-agent/contracts';
import { createRepresentedContentDigest } from '@pair-agent/context';
import { describe, expect, test } from 'vitest';

import {
  deriveDurableSessionGroups,
  SessionEventDerivationError,
  type DshSessionEvent,
} from '../src/session-event-derive.js';

const pairId = parsePairId('pair-derive');
const sessionId = 'pair:pair-derive:navigator';
const pilotSessionId = 'pair:pair-derive:pilot';

function event(
  type: string,
  seq: number,
  data: JsonValue,
  time = 1_800_000_000_000 + seq,
): DshSessionEvent {
  return { type, seq, time, data };
}

function user(
  seq: number,
  text: string,
  source: JsonObject = { kind: 'user' },
): DshSessionEvent {
  return event('user/message', seq, {
    id: `user-${seq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source,
  });
}

function assistant(
  seq: number,
  turn: number,
  step: number,
  content: readonly JsonObject[],
): DshSessionEvent {
  return event('assistant/message', seq, {
    turn,
    step,
    message: {
      id: `assistant-${seq}`,
      role: 'assistant',
      content,
      source: { kind: 'model', provider: 'capture', model: 'capture' },
    },
  });
}

function turnEnd(
  seq: number,
  turn: number,
  reason: JsonObject,
): DshSessionEvent {
  return event('turn/end', seq, { turn, reason });
}

function completionCall(
  seq: number,
  turn: number,
  callId = `completion-${turn}`,
): DshSessionEvent {
  return event('tool/call', seq, {
    turn,
    step: 1,
    callId,
    name: 'pair_report_completion',
    arguments: '{}',
  });
}

function completionResult(
  seq: number,
  turn: number,
  callId = `completion-${turn}`,
  isError = false,
  surfaceOp: JsonValue = 'append',
  sourceEventSeqs: readonly number[] = [seq - 1],
): DshSessionEvent {
  return {
    ...event('tool/result', seq, {
      turn,
      step: 1,
      message: {
        id: `tool-result-${seq}`,
        role: 'user',
        content: [
          {
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text: isError ? 'rejected' : 'registered' }],
            isError,
          },
        ],
        source: { kind: 'tool', callId },
      },
    }),
    surfaceOp,
    sourceEventSeqs,
  };
}

function directUserPairEvent(
  role: PairRole,
  sessionEventSeq: number,
  pairSeq = 2,
): PairEvent {
  const roleSessionId = role === 'navigator' ? sessionId : pilotSessionId;
  return {
    pairId,
    seq: pairSeq,
    type: 'user.message',
    actor: { kind: 'user' },
    source: `${role}-session`,
    channel: role,
    visibility: 'shared',
    authority: 'user-derived',
    refs: {
      sourceEventIds: [`dsh:${roleSessionId}:${sessionEventSeq}:user.message`],
    },
    payload: {
      schemaVersion: 1,
      kind: 'user-input',
      text: 'do the work',
      content: [{ type: 'text', text: 'do the work' }],
      origin: {
        schemaVersion: 1,
        sessionId: roleSessionId,
        sessionEventSeq,
        turn: 7,
        messageId: `user-${sessionEventSeq}`,
      },
    },
    occurredAt: '2026-09-03T00:00:00.000Z',
  };
}

function directedPeerPairEvent(
  hop = 1,
  seq = 5,
  causalRootId = `${pairId}:2`,
  senderTurn = 3,
): PairEvent {
  return {
    pairId,
    seq,
    type: 'agent.message',
    actor: { kind: 'agent', role: 'navigator' },
    source: 'navigator-session',
    channel: 'pilot',
    visibility: 'shared',
    authority: 'navigator',
    refs: {
      sourceEventIds: [
        `dsh:${sessionId}:turn:${String(senderTurn)}:peer-message`,
      ],
    },
    payload: {
      schemaVersion: 1,
      kind: 'peer-message',
      text: 'finish the delegated task',
      content: [{ type: 'text', text: 'finish the delegated task' }],
      causalRootId,
      hop,
    },
    occurredAt: '2026-09-03T00:00:00.000Z',
  };
}

function pairDelivery(seq: number, represented: PairEvent): DshSessionEvent {
  const representedId = `${represented.pairId}:${represented.seq}`;
  return user(seq, '<pair-delivery/>', {
    kind: 'plugin',
    plugin: 'pair-agent:delivery',
    deliveryId: representedId,
    pairEventId: representedId,
  });
}

function derive(
  events: readonly DshSessionEvent[],
  existingPairEvents: readonly PairEvent[] = [],
  role: PairRole = 'navigator',
) {
  return deriveDurableSessionGroups({
    pairId,
    role,
    sessionId: role === 'navigator' ? sessionId : pilotSessionId,
    events,
    existingPairEvents,
  });
}

describe('deriveDurableSessionGroups', () => {
  test('promotes a direct text-only user message with a full link', () => {
    const [group] = derive([user(2, 'hello'), event('step/start', 3, { turn: 1, step: 1 })]);

    expect(group).toMatchObject({ sourceSessionSeq: 2, role: 'navigator' });
    expect(group?.records).toHaveLength(2);
    expect(group?.records[0]).toMatchObject({
      sourceId: `dsh:${sessionId}:2:user.message`,
      draft: {
        type: 'user.message',
        actor: { kind: 'user' },
        source: 'navigator-session',
        channel: 'navigator',
        visibility: 'shared',
        authority: 'user-derived',
        payload: {
          schemaVersion: 1,
          kind: 'user-input',
          text: 'hello',
          content: [{ type: 'text', text: 'hello' }],
          origin: {
            schemaVersion: 1,
            sessionId,
            sessionEventSeq: 2,
            turn: 0,
            messageId: 'user-2',
          },
        },
      },
    });
    expect(group?.records[1]).toMatchObject({
      representedSourceId: `dsh:${sessionId}:2:user.message`,
      draft: {
        type: 'session_event.linked',
        payload: {
          fromSessionSeq: 2,
          throughSessionSeq: 2,
          messageIds: ['user-2'],
          representation: 'full',
        },
      },
    });
  });

  test('uses the containing turn for direct user-message origin when available', () => {
    const [group] = derive([
      event('turn/start', 0, { turn: 7 }),
      user(1, 'inside turn'),
    ]);

    expect(group?.records[0].draft.payload).toMatchObject({
      origin: { turn: 7 },
    });
  });

  test('derives only a link for a verified Pair delivery', () => {
    const represented = {
      pairId,
      seq: 4,
      type: 'user.message',
      actor: { kind: 'user' },
      source: 'pair',
      channel: 'navigator',
      visibility: 'shared',
      authority: 'user',
      refs: {},
      payload: {
        schemaVersion: 1,
        kind: 'user-input',
        text: 'from Pair Host',
        content: [{ type: 'text', text: 'from Pair Host' }],
        deliveryId: `${pairId}:4`,
      },
      occurredAt: '2026-08-31T00:00:00.000Z',
    } satisfies PairEvent;
    const [group] = derive(
      [
        user(8, '<pair-delivery/>', {
          kind: 'plugin',
          plugin: 'pair-agent:delivery',
          deliveryId: `${pairId}:4`,
          pairEventId: `${pairId}:4`,
          trigger: { kind: 'user.message', pairEventId: `${pairId}:4` },
        }),
      ],
      [represented],
    );

    expect(group?.records).toHaveLength(1);
    expect(group?.records[0]).toMatchObject({
      sourceId: `dsh:${sessionId}:8:session_event.linked`,
      representedPairEventId: `${pairId}:4`,
      draft: {
        type: 'session_event.linked',
        payload: {
          pairEventId: `${pairId}:4`,
          representation: 'full',
          messageIds: ['user-8'],
        },
      },
    });
  });

  test.each<JsonObject>([
    { kind: 'plugin', plugin: 'bootstrap' },
    { kind: 'plugin', plugin: 'watcher' },
    { kind: 'goal', goalId: 'goal-1' },
    { kind: 'skill', name: 'skill-1' },
    { kind: 'compaction', checkpoint: 1 },
  ])('does not promote internal user input %#', (source) => {
    expect(derive([user(1, 'internal', source)])).toEqual([]);
  });

  test('selects only the last public non-tool assistant message at completed turn/end', () => {
    const groups = derive([
      assistant(2, 1, 1, [{ type: 'text', text: 'I will inspect' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }]),
      assistant(5, 1, 2, [{ type: 'text', text: 'final answer' }]),
      turnEnd(6, 1, { kind: 'completed' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.sourceSessionSeq).toBe(5);
    expect(groups[0]?.records[0]).toMatchObject({
      sourceId: `dsh:${sessionId}:5:agent.message`,
      draft: {
        type: 'agent.message',
        actor: { kind: 'agent', role: 'navigator' },
        channel: 'navigator',
        authority: 'navigator',
        payload: {
          kind: 'turn-output',
          text: 'final answer',
          content: [{ type: 'text', text: 'final answer' }],
          completion: 'complete',
          origin: { turn: 1, messageId: 'assistant-5' },
        },
      },
    });
  });

  test('marks a max-token answer partial', () => {
    const [group] = derive([
      assistant(2, 3, 1, [{ type: 'text', text: 'partial answer' }]),
      turnEnd(3, 3, { kind: 'max-tokens' }),
    ]);

    expect(group?.records[0].draft.payload).toMatchObject({ completion: 'partial' });
  });

  test.each<JsonObject>([
    { kind: 'blocked' },
    { kind: 'aborted', reason: { kind: 'user' } },
    { kind: 'aborted', reason: { kind: 'disposed' } },
    { kind: 'interrupted' },
  ])('does not retrieve an older answer for terminal reason $kind', (reason) => {
    expect(derive([
      assistant(2, 1, 1, [{ type: 'text', text: 'older step' }]),
      turnEnd(3, 1, reason),
    ])).toEqual([]);
  });

  test('records an authoritative shared failure instead of an older answer', () => {
    const groups = derive([
      assistant(2, 4, 1, [{ type: 'text', text: 'stale partial work' }]),
      turnEnd(3, 4, {
        kind: 'error',
        error: { message: 'request layout rejected', code: 'UNKNOWN' },
      }),
    ], [], 'pilot');

    expect(groups).toEqual([
      expect.objectContaining({
        sourceSessionSeq: 3,
        role: 'pilot',
        failureDelivery: {
          sourceId: `dsh:${pilotSessionId}:3:agent.turn_failed`,
          failedTurn: 4,
        },
        records: [
          expect.objectContaining({
            sourceId: `dsh:${pilotSessionId}:3:agent.turn_failed`,
            draft: {
              type: 'agent.turn_failed',
              actor: { kind: 'host' },
              source: 'pilot-session',
              channel: 'navigator',
              visibility: 'shared',
              authority: 'host',
              refs: {},
              payload: {
                schemaVersion: 1,
                failedRole: 'pilot',
                failedTurn: 4,
                code: 'UNKNOWN',
                message: 'request layout rejected',
                origin: {
                  schemaVersion: 1,
                  sessionId: pilotSessionId,
                  sessionEventSeq: 3,
                },
              },
            },
          }),
        ],
      }),
    ]);
  });

  test('does not retrieve an older non-tool step when the final step requests a tool', () => {
    expect(derive([
      assistant(2, 1, 1, [{ type: 'text', text: 'older public text' }]),
      assistant(4, 1, 2, [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }]),
      turnEnd(5, 1, { kind: 'completed' }),
    ])).toEqual([]);
  });

  test('downgrades reasoning and non-text content to a visible-text summary', () => {
    const [group] = derive([
      assistant(2, 1, 1, [
        { type: 'reasoning', text: 'private chain' },
        { type: 'text', text: 'public result' },
        { type: 'image', attachment: { attachmentId: 'image-1' } },
      ]),
      turnEnd(3, 1, { kind: 'completed' }),
    ]);

    expect(group?.records[0].draft.payload).toMatchObject({
      text: 'public result',
      content: [{ type: 'text', text: 'public result' }],
    });
    expect(group?.records[1]?.draft.payload).toMatchObject({ representation: 'summary' });
    expect(group?.records[1]?.draft.payload.representedContentDigest).toBe(
      createRepresentedContentDigest([{ type: 'text', text: 'public result' }]),
    );
  });

  test('ignores reasoning-only and empty visible output', () => {
    expect(derive([
      assistant(2, 1, 1, [{ type: 'reasoning', text: 'private chain' }]),
      turnEnd(3, 1, { kind: 'completed' }),
    ])).toEqual([]);
  });

  test('projects one completed Pilot registration as a directed completion handoff', () => {
    const groups = derive(
      [
        event('turn/start', 0, { turn: 7 }),
        user(1, 'do the work'),
        assistant(2, 7, 1, [
          {
            type: 'tool-call',
            id: 'completion-7',
            name: 'pair_report_completion',
            arguments: '{}',
          },
        ]),
        completionCall(3, 7),
        completionResult(4, 7),
        assistant(5, 7, 2, [{ type: 'text', text: 'complete report' }]),
        turnEnd(6, 7, { kind: 'completed' }),
      ],
      [directUserPairEvent('pilot', 1)],
      'pilot',
    );

    const handoff = groups.find(
      (group) => group.records[0].draft.payload.kind === 'completion-handoff',
    );
    expect(handoff).toMatchObject({ sourceSessionSeq: 5, role: 'pilot' });
    expect(handoff?.records[0]).toMatchObject({
      sourceId: `dsh:${pilotSessionId}:5:agent.message`,
      draft: {
        type: 'agent.message',
        actor: { kind: 'agent', role: 'pilot' },
        source: 'pilot-session',
        channel: 'navigator',
        visibility: 'shared',
        authority: 'pilot',
        payload: {
          schemaVersion: 1,
          kind: 'completion-handoff',
          text: 'complete report',
          content: [{ type: 'text', text: 'complete report' }],
          completion: 'complete',
          causalRootId: `${pairId}:2`,
          hop: 1,
          origin: {
            schemaVersion: 1,
            sessionId: pilotSessionId,
            sessionEventSeq: 5,
            turn: 7,
            messageId: 'assistant-5',
          },
        },
      },
    });
    expect(handoff?.records[1]?.draft.payload).toMatchObject({
      throughSessionSeq: 6,
      representation: 'full',
    });
    expect(
      groups.filter(
        (group) => group.records[0].draft.payload.kind === 'turn-output',
      ),
    ).toEqual([]);
  });

  test('increments the bounded causal hop from a canonical delivered peer message', () => {
    const peer = directedPeerPairEvent(1);
    const groups = derive(
      [
        event('turn/start', 0, { turn: 7 }),
        pairDelivery(1, peer),
        completionCall(2, 7),
        completionResult(3, 7),
        assistant(4, 7, 2, [{ type: 'text', text: 'complete report' }]),
        turnEnd(5, 7, { kind: 'completed' }),
      ],
      [peer],
      'pilot',
    );

    expect(groups.at(-1)?.records[0].draft.payload).toMatchObject({
      kind: 'completion-handoff',
      causalRootId: `${pairId}:2`,
      hop: 2,
    });
  });

  test('keeps ordinary Pilot output as passive turn output', () => {
    const groups = derive(
      [
        assistant(2, 7, 1, [{ type: 'text', text: 'ordinary answer' }]),
        turnEnd(3, 7, { kind: 'completed' }),
      ],
      [],
      'pilot',
    );

    expect(groups[0]?.records[0].draft).toMatchObject({
      channel: 'pilot',
      payload: { kind: 'turn-output', completion: 'complete' },
    });
  });

  test.each([
    ['Navigator role', 'navigator' as const, false, false],
    ['failed registration', 'pilot' as const, true, false],
    ['final text before registration result', 'pilot' as const, false, true],
  ])(
    'does not derive a completion handoff for %s',
    (_label, role, failed, textBeforeResult) => {
      const finalText = assistant(textBeforeResult ? 3 : 4, 7, 2, [
        { type: 'text', text: 'not a handoff' },
      ]);
      const result = completionResult(
        textBeforeResult ? 4 : 3,
        7,
        'completion-7',
        failed,
        'append',
        [2],
      );
      const groups = derive(
        [
          completionCall(2, 7),
          ...(textBeforeResult ? [finalText, result] : [result, finalText]),
          turnEnd(5, 7, { kind: 'completed' }),
        ],
        [],
        role,
      );

      expect(groups).toHaveLength(1);
      expect(groups[0]?.records[0].draft.payload).toMatchObject({
        kind: 'turn-output',
        completion: 'complete',
      });
    },
  );

  test('fails closed on duplicate successful completion registrations', () => {
    expect(() =>
      derive(
        [
          completionCall(2, 7, 'completion-a'),
          completionResult(3, 7, 'completion-a'),
          completionCall(4, 7, 'completion-b'),
          completionResult(5, 7, 'completion-b'),
          assistant(6, 7, 3, [{ type: 'text', text: 'ambiguous report' }]),
          turnEnd(7, 7, { kind: 'completed' }),
        ],
        [],
        'pilot',
      ),
    ).toThrow(SessionEventDerivationError);
  });

  test('fails closed when one completion call has two append-origin success results', () => {
    expect(() =>
      derive(
        [
          event('turn/start', 0, { turn: 7 }),
          user(1, 'do the work'),
          completionCall(2, 7),
          completionResult(3, 7),
          completionResult(4, 7, 'completion-7', false, 'append', [2]),
          assistant(5, 7, 3, [{ type: 'text', text: 'ambiguous report' }]),
          turnEnd(6, 7, { kind: 'completed' }),
        ],
        [directUserPairEvent('pilot', 1)],
        'pilot',
      ),
    ).toThrow(/duplicate successful completion registrations/i);
  });

  test('fails closed when a durable Turn repeats a completion tool call ID', () => {
    expect(() =>
      derive(
        [
          event('turn/start', 0, { turn: 7 }),
          user(1, 'do the work'),
          completionCall(2, 7),
          completionCall(3, 7),
          completionResult(4, 7),
          assistant(5, 7, 3, [{ type: 'text', text: 'ambiguous report' }]),
          turnEnd(6, 7, { kind: 'completed' }),
        ],
        [directUserPairEvent('pilot', 1)],
        'pilot',
      ),
    ).toThrow(/duplicate completion tool call/i);
  });

  test.each([
    ['missing', []],
    ['wrong', [1]],
    ['multiple', [2, 1]],
  ])(
    'fails closed when a successful completion result has %s tool-call provenance',
    (_label, sourceEventSeqs) => {
      expect(() =>
        derive(
          [
            event('turn/start', 0, { turn: 7 }),
            user(1, 'do the work'),
            completionCall(2, 7),
            completionResult(
              3,
              7,
              'completion-7',
              false,
              'append',
              sourceEventSeqs,
            ),
            assistant(4, 7, 2, [{ type: 'text', text: 'untrusted report' }]),
            turnEnd(5, 7, { kind: 'completed' }),
          ],
          [directUserPairEvent('pilot', 1)],
          'pilot',
        ),
      ).toThrow(/tool-call provenance/i);
    },
  );

  test('fails closed when a completion registration has no canonical Turn input', () => {
    expect(() =>
      derive(
        [
          completionCall(2, 7),
          completionResult(3, 7),
          assistant(4, 7, 2, [{ type: 'text', text: 'orphan report' }]),
          turnEnd(5, 7, { kind: 'completed' }),
        ],
        [],
        'pilot',
      ),
    ).toThrow(/provenance/i);
  });

  test('fails closed when direct-user provenance claims another Turn', () => {
    const root = directUserPairEvent('pilot', 1);
    const tampered = {
      ...root,
      payload: {
        ...root.payload,
        origin: { ...(root.payload.origin as JsonObject), turn: 6 },
      },
    } satisfies PairEvent;

    expect(() =>
      derive(
        [
          event('turn/start', 0, { turn: 7 }),
          user(1, 'do the work'),
          completionCall(2, 7),
          completionResult(3, 7),
          assistant(4, 7, 2, [{ type: 'text', text: 'tampered report' }]),
          turnEnd(5, 7, { kind: 'completed' }),
        ],
        [tampered],
        'pilot',
      ),
    ).toThrow(/canonical|provenance/i);
  });

  test('fails closed when completion causality would exceed the hop limit', () => {
    const peer = directedPeerPairEvent(MAX_PEER_HOPS);
    expect(() =>
      derive(
        [
          event('turn/start', 0, { turn: 7 }),
          pairDelivery(1, peer),
          completionCall(2, 7),
          completionResult(3, 7),
          assistant(4, 7, 2, [{ type: 'text', text: 'too deep' }]),
          turnEnd(5, 7, { kind: 'completed' }),
        ],
        [peer],
        'pilot',
      ),
    ).toThrow(/hop/i);
  });

  test('uses the highest hop across multiple directed inputs with one root', () => {
    const first = directedPeerPairEvent(1, 5, `${pairId}:2`, 3);
    const second = directedPeerPairEvent(2, 6, `${pairId}:2`, 4);
    const groups = derive(
      [
        event('turn/start', 0, { turn: 7 }),
        pairDelivery(1, first),
        pairDelivery(2, second),
        completionCall(3, 7),
        completionResult(4, 7),
        assistant(5, 7, 2, [{ type: 'text', text: 'combined report' }]),
        turnEnd(6, 7, { kind: 'completed' }),
      ],
      [first, second],
      'pilot',
    );

    expect(groups.at(-1)?.records[0].draft.payload).toMatchObject({
      kind: 'completion-handoff',
      causalRootId: `${pairId}:2`,
      hop: 3,
    });
  });

  test.each([
    [
      'mixed root and directed inputs',
      [directedPeerPairEvent(), directUserPairEvent('pilot', 2, 6)],
      [
        pairDelivery(1, directedPeerPairEvent()),
        user(2, 'do the work'),
      ],
    ],
    [
      'multiple directed roots',
      [
        directedPeerPairEvent(1, 5, `${pairId}:2`, 3),
        directedPeerPairEvent(1, 6, `${pairId}:3`, 4),
      ],
      [
        pairDelivery(1, directedPeerPairEvent(1, 5, `${pairId}:2`, 3)),
        pairDelivery(2, directedPeerPairEvent(1, 6, `${pairId}:3`, 4)),
      ],
    ],
  ])('fails closed for %s', (_label, existing, inputs) => {
    expect(() =>
      derive(
        [
          event('turn/start', 0, { turn: 7 }),
          ...inputs,
          completionCall(3, 7),
          completionResult(4, 7),
          assistant(5, 7, 2, [{ type: 'text', text: 'ambiguous report' }]),
          turnEnd(6, 7, { kind: 'completed' }),
        ],
        existing,
        'pilot',
      ),
    ).toThrow(/provenance|causal root/i);
  });

  test('does not count a replacement tool result as completion registration', () => {
    const groups = derive(
      [
        completionCall(2, 7),
        completionResult(3, 7, 'completion-7', false, {
          op: 'replace',
          start: 2,
          end: 2,
        }),
        assistant(4, 7, 2, [{ type: 'text', text: 'ordinary answer' }]),
        turnEnd(5, 7, { kind: 'completed' }),
      ],
      [],
      'pilot',
    );

    expect(groups[0]?.records[0].draft.payload).toMatchObject({
      kind: 'turn-output',
      completion: 'complete',
    });
  });

  test('counts an append result once when the same call later has a replacement copy', () => {
    const replacement = {
      ...completionResult(5, 7, 'completion-7', false, {
        op: 'replace',
        start: 4,
        end: 4,
      }),
      sourceEventSeqs: [4],
    };
    const groups = derive(
      [
        event('turn/start', 0, { turn: 7 }),
        user(1, 'do the work'),
        completionCall(3, 7),
        completionResult(4, 7),
        replacement,
        assistant(6, 7, 2, [{ type: 'text', text: 'complete report' }]),
        turnEnd(7, 7, { kind: 'completed' }),
      ],
      [directUserPairEvent('pilot', 1)],
      'pilot',
    );

    expect(groups.at(-1)?.records[0].draft.payload).toMatchObject({
      kind: 'completion-handoff',
      causalRootId: `${pairId}:2`,
      hop: 1,
    });
  });

  test('ignores an explicitly ignorable unrelated event during completion recognition', () => {
    const groups = derive(
      [
        event('turn/start', 0, { turn: 7 }),
        user(1, 'do the work'),
        completionCall(2, 7),
        {
          ...event('extension/telemetry', 3, { turn: 7 }),
          ignorable: true,
        },
        completionResult(4, 7, 'completion-7', false, 'append', [2]),
        assistant(5, 7, 2, [{ type: 'text', text: 'complete report' }]),
        turnEnd(6, 7, { kind: 'completed' }),
      ],
      [directUserPairEvent('pilot', 1)],
      'pilot',
    );

    expect(groups.at(-1)?.records[0].draft.payload).toMatchObject({
      kind: 'completion-handoff',
    });
  });

  test('keeps a max-token completion registration as partial turn output', () => {
    const groups = derive(
      [
        completionCall(2, 7),
        completionResult(3, 7),
        assistant(4, 7, 2, [{ type: 'text', text: 'partial report' }]),
        turnEnd(5, 7, { kind: 'max-tokens' }),
      ],
      [],
      'pilot',
    );

    expect(groups[0]?.records[0].draft.payload).toMatchObject({
      kind: 'turn-output',
      completion: 'partial',
    });
  });

  test.each([{ kind: 'interrupted' }, { kind: 'aborted' }])(
    'does not derive a handoff for terminal reason $kind',
    (reason) => {
      expect(
        derive(
          [
            completionCall(2, 7),
            completionResult(3, 7),
            assistant(4, 7, 2, [{ type: 'text', text: 'not delivered' }]),
            turnEnd(5, 7, reason),
          ],
          [],
          'pilot',
        ),
      ).toEqual([]);
    },
  );

  test('does not derive a handoff without final public text after registration', () => {
    expect(
      derive(
        [
          completionCall(2, 7),
          completionResult(3, 7),
          turnEnd(4, 7, { kind: 'completed' }),
        ],
        [],
        'pilot',
      ),
    ).toEqual([]);
  });

  test.each<{ readonly content: readonly JsonObject[] }>([
    { content: [{ type: 'reasoning', text: 'private only' }] },
    {
      content: [
        { type: 'text', text: 'still requesting a tool' },
        { type: 'tool-call', id: 'next-call', name: 'read', arguments: '{}' },
      ],
    },
  ])(
    'does not resolve completion provenance when the final assistant message is not publishable %#',
    ({ content }) => {
      expect(
        derive(
          [
            completionCall(2, 7),
            completionResult(3, 7),
            assistant(4, 7, 2, content),
            turnEnd(5, 7, { kind: 'completed' }),
          ],
          [],
          'pilot',
        ),
      ).toEqual([]);
    },
  );
});
