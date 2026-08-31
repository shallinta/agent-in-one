import {
  type JsonObject,
  type JsonValue,
  type PairEvent,
  parsePairId,
} from '@pair-agent/contracts';
import { describe, expect, test } from 'vitest';

import {
  deriveDurableSessionGroups,
  type DshSessionEvent,
} from '../src/session-event-derive.js';

const pairId = parsePairId('pair-derive');
const sessionId = 'pair:pair-derive:navigator';

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

function derive(
  events: readonly DshSessionEvent[],
  existingPairEvents: readonly PairEvent[] = [],
) {
  return deriveDurableSessionGroups({
    pairId,
    role: 'navigator',
    sessionId,
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
    { kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } },
    { kind: 'aborted', reason: { kind: 'user' } },
    { kind: 'aborted', reason: { kind: 'disposed' } },
    { kind: 'interrupted' },
  ])('does not retrieve an older answer for terminal reason $kind', (reason) => {
    expect(derive([
      assistant(2, 1, 1, [{ type: 'text', text: 'older step' }]),
      turnEnd(3, 1, reason),
    ])).toEqual([]);
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
  });

  test('ignores reasoning-only and empty visible output', () => {
    expect(derive([
      assistant(2, 1, 1, [{ type: 'reasoning', text: 'private chain' }]),
      turnEnd(3, 1, { kind: 'completed' }),
    ])).toEqual([]);
  });
});
