import {
  type JsonObject,
  type JsonValue,
  type PairEvent,
  type PairEventSource,
  type PairId,
  type PairRole,
} from '@pair-agent/contracts';

import type { DerivedEventSpec } from './pair-derived-event-writer.js';

const DELIVERY_PLUGIN = 'pair-agent:delivery';

export interface DshSessionEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: JsonValue;
  readonly ignorable?: true;
  readonly sourceEventSeqs?: readonly number[];
  readonly surfaceOp?: JsonValue;
}

export interface DurableSessionInput {
  readonly pairId: PairId;
  readonly role: PairRole;
  readonly sessionId: string;
  readonly events: readonly DshSessionEvent[];
  readonly existingPairEvents: readonly PairEvent[];
}

export interface DerivedSessionGroup {
  readonly sourceSessionSeq: number;
  readonly time: number;
  readonly role: PairRole;
  readonly records: readonly [DerivedEventSpec, DerivedEventSpec?];
}

export class SessionEventDerivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionEventDerivationError';
  }
}

interface MessageView {
  readonly id: string;
  readonly content: readonly JsonObject[];
  readonly source: JsonObject;
}

function plainObject(value: unknown): Record<string, JsonValue> | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return undefined;
  }
  return value as Record<string, JsonValue>;
}

function messageView(value: unknown, expectedRole: 'user' | 'assistant'): MessageView | undefined {
  const message = plainObject(value);
  if (
    message === undefined ||
    message.role !== expectedRole ||
    typeof message.id !== 'string' ||
    message.id.length === 0 ||
    !Array.isArray(message.content)
  ) {
    return undefined;
  }
  const source = plainObject(message.source);
  const content = message.content.every((block) => plainObject(block) !== undefined)
    ? message.content as readonly JsonObject[]
    : undefined;
  if (source === undefined || content === undefined) return undefined;
  return { id: message.id, content, source: source as JsonObject };
}

function textProjection(content: readonly JsonObject[]): {
  readonly text: string;
  readonly content: readonly JsonObject[];
  readonly representation: 'full' | 'summary';
  readonly hasToolCall: boolean;
} {
  const textBlocks = content.filter(
    (block): block is JsonObject & { readonly type: 'text'; readonly text: string } =>
      block.type === 'text' && typeof block.text === 'string',
  );
  return {
    text: textBlocks.map((block) => block.text).join(''),
    content:
      textBlocks.length === content.length
        ? content
        : textBlocks.map((block) => ({ type: 'text', text: block.text })),
    representation: textBlocks.length === content.length ? 'full' : 'summary',
    hasToolCall: content.some((block) => block.type === 'tool-call'),
  };
}

function messageSourceId(
  sessionId: string,
  seq: number,
  kind: 'user.message' | 'agent.message' | 'session_event.linked',
): string {
  return `dsh:${sessionId}:${seq}:${kind}`;
}

function sessionSource(role: PairRole): PairEventSource {
  return role === 'navigator' ? 'navigator-session' : 'pilot-session';
}

function eventId(event: Pick<PairEvent, 'pairId' | 'seq'>): string {
  return `${event.pairId}:${event.seq}`;
}

function makeLink(
  input: DurableSessionInput,
  sourceEvent: DshSessionEvent,
  messageId: string,
  representation: 'full' | 'summary',
  throughSessionSeq: number,
  represented:
    | { readonly representedSourceId: string }
    | { readonly representedPairEventId: string },
): DerivedEventSpec {
  return {
    sourceId: messageSourceId(
      input.sessionId,
      sourceEvent.seq,
      'session_event.linked',
    ),
    ...represented,
    draft: {
      type: 'session_event.linked',
      actor: { kind: 'host' },
      source: sessionSource(input.role),
      channel: input.role,
      visibility: 'infrastructure',
      authority: 'host',
      refs: {},
      payload: {
        schemaVersion: 1,
        sessionId: input.sessionId,
        fromSessionSeq: sourceEvent.seq,
        throughSessionSeq,
        messageIds: [messageId],
        pairEventId:
          'representedPairEventId' in represented
            ? represented.representedPairEventId
            : 'resolved-by-writer',
        representation,
      },
    },
  };
}

function findExistingMessage(
  input: DurableSessionInput,
  pairEventId: string,
): PairEvent {
  const represented = input.existingPairEvents.find(
    (event) => eventId(event) === pairEventId,
  );
  if (
    represented === undefined ||
    (represented.type !== 'user.message' && represented.type !== 'agent.message')
  ) {
    throw new SessionEventDerivationError(
      `Pair delivery references missing message ${pairEventId}`,
    );
  }
  return represented;
}

function deriveUserGroup(
  input: DurableSessionInput,
  event: DshSessionEvent,
  turn: number,
): DerivedSessionGroup | undefined {
  const message = messageView(event.data, 'user');
  if (message === undefined) {
    throw new SessionEventDerivationError(
      `Malformed durable user/message at ${input.sessionId}:${event.seq}`,
    );
  }
  if (message.source.kind === 'plugin' && message.source.plugin === DELIVERY_PLUGIN) {
    const pairEventId = message.source.pairEventId;
    const deliveryId = message.source.deliveryId;
    if (
      typeof pairEventId !== 'string' ||
      typeof deliveryId !== 'string' ||
      pairEventId !== deliveryId
    ) {
      throw new SessionEventDerivationError(
        `Malformed Pair delivery provenance at ${input.sessionId}:${event.seq}`,
      );
    }
    findExistingMessage(input, pairEventId);
    return {
      sourceSessionSeq: event.seq,
      time: event.time,
      role: input.role,
      records: [
        makeLink(input, event, message.id, 'full', event.seq, {
          representedPairEventId: pairEventId,
        }),
      ],
    };
  }
  if (message.source.kind !== 'user') return undefined;

  const projection = textProjection(message.content);
  if (projection.text.length === 0) return undefined;
  const sourceId = messageSourceId(input.sessionId, event.seq, 'user.message');
  const messageSpec: DerivedEventSpec = {
    sourceId,
    draft: {
      type: 'user.message',
      actor: { kind: 'user' },
      source: sessionSource(input.role),
      channel: input.role,
      visibility: 'shared',
      authority: 'user-derived',
      refs: {},
      payload: {
        schemaVersion: 1,
        kind: 'user-input',
        text: projection.text,
        content: projection.content,
        origin: {
          schemaVersion: 1,
          sessionId: input.sessionId,
          sessionEventSeq: event.seq,
          turn,
          messageId: message.id,
        },
      },
    },
  };
  return {
    sourceSessionSeq: event.seq,
    time: event.time,
    role: input.role,
    records: [
      messageSpec,
      makeLink(
        input,
        event,
        message.id,
        projection.representation,
        event.seq,
        { representedSourceId: sourceId },
      ),
    ],
  };
}

function deriveAssistantGroup(
  input: DurableSessionInput,
  event: DshSessionEvent,
  throughSessionSeq: number,
  completion: 'complete' | 'partial',
): DerivedSessionGroup | undefined {
  const data = plainObject(event.data);
  const message = messageView(data?.message, 'assistant');
  if (
    data === undefined ||
    message === undefined ||
    typeof data.turn !== 'number' ||
    !Number.isSafeInteger(data.turn)
  ) {
    throw new SessionEventDerivationError(
      `Malformed durable assistant/message at ${input.sessionId}:${event.seq}`,
    );
  }
  const projection = textProjection(message.content);
  if (projection.text.length === 0 || projection.hasToolCall) return undefined;

  const sourceId = messageSourceId(input.sessionId, event.seq, 'agent.message');
  const messageSpec: DerivedEventSpec = {
    sourceId,
    draft: {
      type: 'agent.message',
      actor: { kind: 'agent', role: input.role },
      source: sessionSource(input.role),
      channel: input.role,
      visibility: 'shared',
      authority: input.role,
      refs: {},
      payload: {
        schemaVersion: 1,
        kind: 'turn-output',
        text: projection.text,
        content: projection.content,
        completion,
        origin: {
          schemaVersion: 1,
          sessionId: input.sessionId,
          sessionEventSeq: event.seq,
          turn: data.turn,
          messageId: message.id,
        },
      },
    },
  };
  return {
    sourceSessionSeq: event.seq,
    time: event.time,
    role: input.role,
    records: [
      messageSpec,
      makeLink(
        input,
        event,
        message.id,
        projection.representation,
        throughSessionSeq,
        { representedSourceId: sourceId },
      ),
    ],
  };
}

export function deriveDurableSessionGroups(
  input: DurableSessionInput,
): readonly DerivedSessionGroup[] {
  const groups: DerivedSessionGroup[] = [];
  const assistantsByTurn = new Map<number, DshSessionEvent[]>();
  let currentTurn = 0;

  for (const event of input.events) {
    if (event.type === 'turn/start') {
      const data = plainObject(event.data);
      if (typeof data?.turn === 'number' && Number.isSafeInteger(data.turn)) {
        currentTurn = data.turn;
      }
      continue;
    }
    if (event.type === 'user/message') {
      const group = deriveUserGroup(input, event, currentTurn);
      if (group !== undefined) groups.push(group);
      continue;
    }
    if (event.type === 'assistant/message') {
      const data = plainObject(event.data);
      if (typeof data?.turn !== 'number' || !Number.isSafeInteger(data.turn)) {
        throw new SessionEventDerivationError(
          `Malformed durable assistant/message at ${input.sessionId}:${event.seq}`,
        );
      }
      const turnEvents = assistantsByTurn.get(data.turn) ?? [];
      turnEvents.push(event);
      assistantsByTurn.set(data.turn, turnEvents);
      continue;
    }
    if (event.type !== 'turn/end') continue;

    const data = plainObject(event.data);
    const reason = plainObject(data?.reason);
    if (
      typeof data?.turn !== 'number' ||
      !Number.isSafeInteger(data.turn) ||
      typeof reason?.kind !== 'string'
    ) {
      throw new SessionEventDerivationError(
        `Malformed durable turn/end at ${input.sessionId}:${event.seq}`,
      );
    }
    const candidates = assistantsByTurn.get(data.turn) ?? [];
    assistantsByTurn.delete(data.turn);
    const candidate = candidates.at(-1);
    if (candidate === undefined) continue;
    const completion =
      reason.kind === 'completed'
        ? 'complete'
        : reason.kind === 'max-tokens'
          ? 'partial'
          : undefined;
    if (completion === undefined) continue;
    const group = deriveAssistantGroup(input, candidate, event.seq, completion);
    if (group !== undefined) groups.push(group);
  }

  return groups;
}
