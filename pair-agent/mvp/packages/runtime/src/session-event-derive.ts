import {
  canonicalJsonStringify,
  type JsonObject,
  type JsonValue,
  type PairEvent,
  type PairEventSource,
  type PairId,
  type PairRole,
} from '@pair-agent/contracts';
import { createRepresentedContentDigest } from '@pair-agent/context';

import {
  CanonicalDirectedCausalityError,
  deriveCanonicalDirectedCausality,
  isCanonicalDirectedAgentMessage,
  type CanonicalDirectedCausality,
} from './canonical-directed-causality.js';
import type { DerivedEventSpec } from './pair-derived-event-writer.js';

const DELIVERY_PLUGIN = 'pair-agent:delivery';
const COMPLETION_TOOL = 'pair_report_completion';

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
  readonly completionDelivery?: {
    readonly sourceId: string;
    readonly senderTurn: number;
  };
  readonly failureDelivery?: {
    readonly sourceId: string;
    readonly failedTurn: number;
  };
  readonly records:
    | readonly [DerivedEventSpec]
    | readonly [DerivedEventSpec, DerivedEventSpec];
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

interface CompletionCallView {
  readonly turn: number;
  readonly callId: string;
}

interface CompletionResultView extends CompletionCallView {
  readonly isError: boolean;
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
  kind:
    | 'user.message'
    | 'agent.message'
    | 'agent.turn_failed'
    | 'session_event.linked',
): string {
  return `dsh:${sessionId}:${seq}:${kind}`;
}

function deriveTurnFailureGroup(
  input: DurableSessionInput,
  event: DshSessionEvent,
  turn: number,
  reason: Record<string, JsonValue>,
): DerivedSessionGroup {
  const failure = plainObject(reason.error) ?? plainObject(reason.failure);
  const code =
    typeof failure?.code === 'string' && failure.code.trim() !== ''
      ? failure.code
      : 'UNKNOWN';
  const message =
    typeof failure?.message === 'string' && failure.message.trim() !== ''
      ? failure.message
      : 'Agent turn failed without a provider error message';
  const sourceId = messageSourceId(
    input.sessionId,
    event.seq,
    'agent.turn_failed',
  );
  return {
    sourceSessionSeq: event.seq,
    time: event.time,
    role: input.role,
    ...(input.role === 'pilot'
      ? { failureDelivery: { sourceId, failedTurn: turn } }
      : {}),
    records: [
      {
        sourceId,
        draft: {
          type: 'agent.turn_failed',
          actor: { kind: 'host' },
          source: sessionSource(input.role),
          channel: input.role === 'pilot' ? 'navigator' : 'shared-control',
          visibility: 'shared',
          authority: 'host',
          refs: {},
          payload: {
            schemaVersion: 1,
            failedRole: input.role,
            failedTurn: turn,
            code,
            message,
            origin: {
              schemaVersion: 1,
              sessionId: input.sessionId,
              sessionEventSeq: event.seq,
            },
          },
        },
      },
    ],
  };
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
  representedContent?: readonly JsonObject[],
): DerivedEventSpec {
  if (representation === 'summary' && representedContent === undefined) {
    throw new SessionEventDerivationError(
      'Summary Session link requires represented visible content',
    );
  }
  const representedContentDigest =
    representation === 'summary'
      ? createRepresentedContentDigest(representedContent as readonly JsonObject[])
      : undefined;
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
        ...(representedContentDigest === undefined
          ? {}
          : { representedContentDigest }),
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
    represented.visibility !== 'shared'
  ) {
    throw new SessionEventDerivationError(
      `Pair delivery references missing message ${pairEventId}`,
    );
  }
  return represented;
}

function canonicalTextPayload(event: PairEvent): boolean {
  return (
    typeof event.payload.text === 'string' &&
    canonicalJsonStringify(event.payload.content) ===
      canonicalJsonStringify([{ type: 'text', text: event.payload.text }])
  );
}

function canonicalDirectUserInput(
  input: DurableSessionInput,
  sourceEvent: DshSessionEvent,
  turn: number,
): PairEvent {
  const message = messageView(sourceEvent.data, 'user');
  if (message === undefined) {
    throw new SessionEventDerivationError(
      `Malformed direct-user provenance at ${input.sessionId}:${sourceEvent.seq}`,
    );
  }
  const projection = textProjection(message.content);
  const sourceId = messageSourceId(input.sessionId, sourceEvent.seq, 'user.message');
  const candidates = input.existingPairEvents.filter(
    (event) => event.refs.sourceEventIds?.length === 1 &&
      event.refs.sourceEventIds[0] === sourceId,
  );
  if (candidates.length !== 1) {
    throw new SessionEventDerivationError(
      `Completion handoff requires one canonical direct-user provenance at ${input.sessionId}:${sourceEvent.seq}`,
    );
  }
  const candidate = candidates[0]!;
  const origin = plainObject(candidate.payload.origin);
  if (
    candidate.pairId !== input.pairId ||
    candidate.type !== 'user.message' ||
    candidate.actor.kind !== 'user' ||
    candidate.source !== sessionSource(input.role) ||
    candidate.channel !== input.role ||
    candidate.visibility !== 'shared' ||
    candidate.authority !== 'user-derived' ||
    candidate.payload.schemaVersion !== 1 ||
    candidate.payload.kind !== 'user-input' ||
    candidate.payload.text !== projection.text ||
    canonicalJsonStringify(candidate.payload.content) !==
      canonicalJsonStringify(projection.content) ||
    origin?.schemaVersion !== 1 ||
    origin.sessionId !== input.sessionId ||
    origin.sessionEventSeq !== sourceEvent.seq ||
    origin.turn !== turn ||
    origin.messageId !== message.id
  ) {
    throw new SessionEventDerivationError(
      `Completion handoff direct-user provenance is not canonical at ${input.sessionId}:${sourceEvent.seq}`,
    );
  }
  return candidate;
}

function canonicalDeliveredInput(
  input: DurableSessionInput,
  sourceEvent: DshSessionEvent,
): PairEvent {
  const message = messageView(sourceEvent.data, 'user');
  const pairEventId = message?.source.pairEventId;
  const deliveryId = message?.source.deliveryId;
  if (
    message?.source.kind !== 'plugin' ||
    message.source.plugin !== DELIVERY_PLUGIN ||
    typeof pairEventId !== 'string' ||
    pairEventId !== deliveryId
  ) {
    throw new SessionEventDerivationError(
      `Completion handoff requires canonical Pair delivery provenance at ${input.sessionId}:${sourceEvent.seq}`,
    );
  }
  const represented = findExistingMessage(input, pairEventId);
  const isUserRoot =
    represented.type === 'user.message' &&
    represented.actor.kind === 'user' &&
    represented.source === 'pair' &&
    represented.channel === input.role &&
    represented.authority === 'user' &&
    represented.payload.schemaVersion === 1 &&
    represented.payload.kind === 'user-input' &&
    canonicalTextPayload(represented);
  const isTaskRoot =
    input.role === 'pilot' &&
    represented.type === 'task.assigned' &&
    represented.actor.kind === 'agent' &&
    represented.actor.role === 'navigator' &&
    represented.source === 'navigator-session' &&
    represented.channel === 'shared-control' &&
    represented.visibility === 'shared' &&
    represented.authority === 'navigator';
  const isDirected =
    represented.channel === input.role &&
    isCanonicalDirectedAgentMessage(represented);
  if (!isUserRoot && !isTaskRoot && !isDirected) {
    throw new SessionEventDerivationError(
      `Completion handoff input ${pairEventId} is not canonical provenance`,
    );
  }
  return represented;
}

function completionCausality(
  input: DurableSessionInput,
  turn: number,
  turnInputs: readonly DshSessionEvent[],
): CanonicalDirectedCausality {
  const roots = turnInputs.map((sourceEvent) => {
    const message = messageView(sourceEvent.data, 'user');
    if (message?.source.kind === 'user') {
      return canonicalDirectUserInput(input, sourceEvent, turn);
    }
    return canonicalDeliveredInput(input, sourceEvent);
  });
  try {
    return deriveCanonicalDirectedCausality(input.pairId, roots);
  } catch (error) {
    if (error instanceof CanonicalDirectedCausalityError) {
      throw new SessionEventDerivationError(
        `Completion handoff ${error.message}`,
      );
    }
    throw error;
  }
}

function completionCallView(event: DshSessionEvent): CompletionCallView | undefined {
  if (event.type !== 'tool/call') return undefined;
  const data = plainObject(event.data);
  if (
    data?.name !== COMPLETION_TOOL ||
    typeof data.turn !== 'number' ||
    !Number.isSafeInteger(data.turn) ||
    typeof data.callId !== 'string' ||
    data.callId.length === 0
  ) {
    return undefined;
  }
  return { turn: data.turn, callId: data.callId };
}

function completionResultView(
  event: DshSessionEvent,
): CompletionResultView | undefined {
  if (event.type !== 'tool/result' || event.surfaceOp !== 'append') return undefined;
  const data = plainObject(event.data);
  const message = plainObject(data?.message);
  const source = plainObject(message?.source);
  const content = message?.content;
  const block = Array.isArray(content) && content.length === 1
    ? plainObject(content[0])
    : undefined;
  if (
    typeof data?.turn !== 'number' ||
    !Number.isSafeInteger(data.turn) ||
    message?.role !== 'user' ||
    source?.kind !== 'tool' ||
    typeof source.callId !== 'string' ||
    source.callId.length === 0 ||
    block?.type !== 'tool-result' ||
    block.toolCallId !== source.callId ||
    typeof block.isError !== 'boolean'
  ) {
    return undefined;
  }
  return {
    turn: data.turn,
    callId: source.callId,
    isError: block.isError,
  };
}

function isPublishableAssistant(event: DshSessionEvent): boolean {
  const data = plainObject(event.data);
  const message = messageView(data?.message, 'assistant');
  if (message === undefined) return false;
  const projection = textProjection(message.content);
  return projection.text.length > 0 && !projection.hasToolCall;
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
        projection.content,
      ),
    ],
  };
}

function deriveAssistantGroup(
  input: DurableSessionInput,
  event: DshSessionEvent,
  throughSessionSeq: number,
  completion: 'complete' | 'partial',
  handoff?: CanonicalDirectedCausality,
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
      channel: handoff === undefined ? input.role : 'navigator',
      visibility: 'shared',
      authority: input.role,
      refs: {},
      payload: {
        schemaVersion: 1,
        kind: handoff === undefined ? 'turn-output' : 'completion-handoff',
        text: projection.text,
        content: projection.content,
        completion,
        ...(handoff === undefined ? {} : handoff),
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
    ...(handoff === undefined
      ? {}
      : { completionDelivery: { sourceId, senderTurn: data.turn } }),
    records: [
      messageSpec,
      makeLink(
        input,
        event,
        message.id,
        projection.representation,
        throughSessionSeq,
        { representedSourceId: sourceId },
        projection.content,
      ),
    ],
  };
}

export function deriveDurableSessionGroups(
  input: DurableSessionInput,
): readonly DerivedSessionGroup[] {
  const groups: DerivedSessionGroup[] = [];
  const assistantsByTurn = new Map<number, DshSessionEvent[]>();
  const inputsByTurn = new Map<number, DshSessionEvent[]>();
  const completionCallsByTurn = new Map<number, Map<string, number>>();
  const completionResultsByTurn = new Map<number, number[]>();
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
      const message = messageView(event.data, 'user');
      if (
        currentTurn > 0 &&
        (message?.source.kind === 'user' ||
          (message?.source.kind === 'plugin' &&
            message.source.plugin === DELIVERY_PLUGIN))
      ) {
        const turnInputs = inputsByTurn.get(currentTurn) ?? [];
        turnInputs.push(event);
        inputsByTurn.set(currentTurn, turnInputs);
      }
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
    const call = completionCallView(event);
    if (call !== undefined) {
      const calls = completionCallsByTurn.get(call.turn) ?? new Map();
      if (calls.has(call.callId)) {
        throw new SessionEventDerivationError(
          `Pilot Turn ${String(call.turn)} has a duplicate completion tool call ${call.callId}`,
        );
      }
      calls.set(call.callId, event.seq);
      completionCallsByTurn.set(call.turn, calls);
      continue;
    }
    const result = completionResultView(event);
    if (result !== undefined) {
      const callSeq = completionCallsByTurn.get(result.turn)?.get(result.callId);
      if (callSeq !== undefined && callSeq < event.seq && !result.isError) {
        if (
          event.sourceEventSeqs?.length !== 1 ||
          event.sourceEventSeqs[0] !== callSeq
        ) {
          throw new SessionEventDerivationError(
            `Completion result ${String(event.seq)} lacks unique tool-call provenance ${String(callSeq)}`,
          );
        }
        const results = completionResultsByTurn.get(result.turn) ?? [];
        results.push(event.seq);
        completionResultsByTurn.set(result.turn, results);
      }
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
    const completionResults = completionResultsByTurn.get(data.turn) ?? [];
    completionCallsByTurn.delete(data.turn);
    completionResultsByTurn.delete(data.turn);
    const turnInputs = inputsByTurn.get(data.turn) ?? [];
    inputsByTurn.delete(data.turn);
    if (reason.kind === 'error') {
      groups.push(deriveTurnFailureGroup(input, event, data.turn, reason));
      continue;
    }
    if (
      input.role === 'pilot' &&
      reason.kind === 'completed' &&
      completionResults.length > 1
    ) {
      throw new SessionEventDerivationError(
        `Pilot Turn ${String(data.turn)} has duplicate successful completion registrations`,
      );
    }
    if (candidate === undefined) continue;
    const completion =
      reason.kind === 'completed'
        ? 'complete'
        : reason.kind === 'max-tokens'
          ? 'partial'
          : undefined;
    if (completion === undefined) continue;
    const completionResultSeq = completionResults[0];
    const handoff =
      input.role === 'pilot' &&
      completion === 'complete' &&
      completionResultSeq !== undefined &&
      candidate.seq > completionResultSeq &&
      isPublishableAssistant(candidate)
        ? completionCausality(input, data.turn, turnInputs)
        : undefined;
    const group = deriveAssistantGroup(
      input,
      candidate,
      event.seq,
      completion,
      handoff,
    );
    if (group !== undefined) groups.push(group);
  }

  return groups;
}
