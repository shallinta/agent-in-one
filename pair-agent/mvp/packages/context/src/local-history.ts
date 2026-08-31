import {
  InvalidJsonValueError,
  canonicalJsonStringify,
  type JsonValue,
} from '@pair-agent/contracts';

import {
  InvalidNormalizedMessageError,
  canonicalJsonClone,
  normalizeMessage,
  type NormalizedMessage,
} from './serialize.js';

export interface LocalBoundaryMessage {
  sessionId: string;
  sessionSeq: number;
  messageId: string;
  message: NormalizedMessage;
}

export type LinkRepresentation = 'full' | 'summary' | 'artifact-ref';

export interface SessionEventPairSpanLink {
  sessionId: string;
  fromSessionSeq: number;
  throughSessionSeq: number;
  messageIds: readonly string[];
  representation: LinkRepresentation;
  pairEventId: string;
}

export type LocalHistoryDecision = 'retained' | 'excluded' | 'degraded';

export type LocalHistoryReason =
  | 'fully-represented-in-pair'
  | 'summary-representation'
  | 'artifact-ref-representation'
  | 'unknown-representation'
  | 'unlinked'
  | 'incomplete-protocol-link'
  | 'malformed-normalized-message'
  | 'malformed-tool-protocol'
  | 'malformed-message-order'
  | 'duplicate-message-id'
  | 'unexpected-boundary-session'
  | 'unexpected-link-session';

export interface LocalHistorySpanManifest {
  source: 'local-history';
  fromSessionSeq: number;
  throughSessionSeq: number;
  messageIds: readonly string[];
  decision: LocalHistoryDecision;
  reason: LocalHistoryReason;
  linkedPairEventIds: readonly string[];
}

export interface MalformedHistoryEntry {
  index: number;
  sessionId: string;
  sessionSeq: number;
  messageId: string;
  raw: JsonValue;
  reason: 'malformed-normalized-message';
}

export interface SafeLocalHistoryProjection {
  status: 'safe';
  messages: readonly NormalizedMessage[];
  malformedEntries: readonly [];
  spans: readonly LocalHistorySpanManifest[];
}

export interface DegradedLocalHistoryProjection {
  status: 'degraded';
  messages: readonly NormalizedMessage[];
  malformedEntries: readonly MalformedHistoryEntry[];
  spans: readonly LocalHistorySpanManifest[];
}

export type LocalHistoryProjection =
  | SafeLocalHistoryProjection
  | DegradedLocalHistoryProjection;

export interface ProjectLocalHistoryOptions {
  expectedSessionId: string;
}

export class LocalHistoryInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalHistoryInvariantError';
  }
}

interface ProjectedBoundaryMessage {
  index: number;
  sessionId: string;
  sessionSeq: number;
  messageId: string;
  rawMessage: JsonValue;
  normalizedMessage?: NormalizedMessage;
}

interface HistorySpan {
  items: readonly ProjectedBoundaryMessage[];
  protocol: boolean;
  malformed: boolean;
  malformedNormalizedMessage: boolean;
}

interface RuntimeLink {
  sessionId: string;
  fromSessionSeq: number;
  throughSessionSeq: number;
  messageIds: readonly string[];
  representation: string;
  pairEventId: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeBoundary(
  input: LocalBoundaryMessage,
  index: number,
): ProjectedBoundaryMessage {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    !Object.hasOwn(input, 'message')
  ) {
    throw new LocalHistoryInvariantError('boundary message is required');
  }
  const cloned = canonicalJsonClone(
    input as unknown as JsonValue,
  ) as unknown as LocalBoundaryMessage;
  if (!nonEmptyString(cloned.sessionId)) {
    throw new LocalHistoryInvariantError('boundary sessionId is required');
  }
  if (!Number.isSafeInteger(cloned.sessionSeq) || cloned.sessionSeq <= 0) {
    throw new LocalHistoryInvariantError(
      'boundary sessionSeq must be a positive safe integer',
    );
  }
  if (!nonEmptyString(cloned.messageId)) {
    throw new LocalHistoryInvariantError('boundary messageId is required');
  }
  const projected = {
    index,
    sessionId: cloned.sessionId,
    sessionSeq: cloned.sessionSeq,
    messageId: cloned.messageId,
    rawMessage: cloned.message as unknown as JsonValue,
  };
  try {
    return {
      ...projected,
      normalizedMessage: normalizeMessage(cloned.message),
    };
  } catch (error) {
    if (
      !(error instanceof InvalidNormalizedMessageError) &&
      !(error instanceof InvalidJsonValueError)
    ) {
      throw error;
    }
    return projected;
  }
}

function messageRecord(
  boundary: ProjectedBoundaryMessage,
): Record<string, JsonValue> | undefined {
  const value = boundary.rawMessage;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function messageRole(boundary: ProjectedBoundaryMessage): JsonValue | undefined {
  return boundary.normalizedMessage?.role ?? messageRecord(boundary)?.role;
}

function messageToolCalls(
  boundary: ProjectedBoundaryMessage,
): readonly unknown[] | undefined {
  const calls =
    boundary.normalizedMessage?.role === 'assistant'
      ? boundary.normalizedMessage.toolCalls
      : messageRecord(boundary)?.toolCalls;
  return Array.isArray(calls) ? calls : undefined;
}

function messageToolCallId(
  boundary: ProjectedBoundaryMessage,
): string | undefined {
  if (boundary.normalizedMessage?.role === 'tool') {
    return boundary.normalizedMessage.toolCallId;
  }
  const value = messageRecord(boundary)?.toolCallId;
  return typeof value === 'string' ? value : undefined;
}

function runtimeLink(input: unknown): RuntimeLink | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  if (
    !nonEmptyString(value.sessionId) ||
    !Number.isSafeInteger(value.fromSessionSeq) ||
    (value.fromSessionSeq as number) <= 0 ||
    !Number.isSafeInteger(value.throughSessionSeq) ||
    (value.throughSessionSeq as number) < (value.fromSessionSeq as number) ||
    !Array.isArray(value.messageIds) ||
    !value.messageIds.every(nonEmptyString) ||
    !nonEmptyString(value.representation) ||
    !nonEmptyString(value.pairEventId)
  ) {
    return undefined;
  }
  return value as unknown as RuntimeLink;
}

function buildSpans(
  input: readonly ProjectedBoundaryMessage[],
): readonly HistorySpan[] {
  const spans: HistorySpan[] = [];
  for (let index = 0; index < input.length; ) {
    const current = input[index];
    if (current === undefined) break;

    if (current.normalizedMessage === undefined) {
      const items: ProjectedBoundaryMessage[] = [current];
      let cursor = index + 1;
      if (
        messageRole(current) === 'assistant' &&
        messageToolCalls(current) !== undefined
      ) {
        while (
          input[cursor] !== undefined &&
          messageRole(input[cursor] as ProjectedBoundaryMessage) === 'tool'
        ) {
          items.push(input[cursor] as ProjectedBoundaryMessage);
          cursor += 1;
        }
      }
      spans.push({
        items,
        protocol: items.length > 1,
        malformed: true,
        malformedNormalizedMessage: true,
      });
      index = cursor;
      continue;
    }

    if (current.normalizedMessage.role === 'tool') {
      spans.push({
        items: [current],
        protocol: true,
        malformed: true,
        malformedNormalizedMessage: false,
      });
      index += 1;
      continue;
    }

    const calls = current.normalizedMessage.toolCalls;
    if (current.normalizedMessage.role !== 'assistant' || calls === undefined) {
      spans.push({
        items: [current],
        protocol: false,
        malformed: false,
        malformedNormalizedMessage: false,
      });
      index += 1;
      continue;
    }

    const items: ProjectedBoundaryMessage[] = [current];
    let cursor = index + 1;
    while (
      input[cursor] !== undefined &&
      messageRole(input[cursor] as ProjectedBoundaryMessage) === 'tool'
    ) {
      items.push(input[cursor] as ProjectedBoundaryMessage);
      cursor += 1;
    }

    const expectedIds = calls.map(({ id }) => id);
    const resultIds = items.slice(1).map(messageToolCallId);
    const hasMalformedNormalizedMessage = items.some(
      ({ normalizedMessage }) => normalizedMessage === undefined,
    );
    const uniqueExpected = new Set(expectedIds);
    const uniqueResults = new Set(resultIds);
    const wellFormed =
      uniqueExpected.size === expectedIds.length &&
      resultIds.length === expectedIds.length &&
      uniqueResults.size === resultIds.length &&
      resultIds.every((id, resultIndex) => id === expectedIds[resultIndex]) &&
      !hasMalformedNormalizedMessage;

    spans.push({
      items,
      protocol: true,
      malformed: !wellFormed,
      malformedNormalizedMessage: hasMalformedNormalizedMessage,
    });
    index = cursor;
  }
  return spans;
}

function linkMatchesPersistedRange(
  link: RuntimeLink,
  boundaries: readonly ProjectedBoundaryMessage[],
): boolean {
  const covered = boundaries.filter(
    ({ sessionId, sessionSeq }) =>
      sessionId === link.sessionId &&
      sessionSeq >= link.fromSessionSeq &&
      sessionSeq <= link.throughSessionSeq,
  );
  return (
    covered[0]?.sessionSeq === link.fromSessionSeq &&
    covered.at(-1)?.sessionSeq === link.throughSessionSeq &&
    covered.length === link.messageIds.length &&
    covered.every(({ messageId }, index) => messageId === link.messageIds[index])
  );
}

function linksForSpan(
  span: HistorySpan,
  links: readonly RuntimeLink[],
): readonly RuntimeLink[] {
  const first = span.items[0];
  const last = span.items.at(-1);
  if (first === undefined || last === undefined) return [];
  return links.filter(
    (link) =>
      link.sessionId === first.sessionId &&
      link.fromSessionSeq <= first.sessionSeq &&
      link.throughSessionSeq >= last.sessionSeq,
  );
}

function retainedReason(
  span: HistorySpan,
  coveringLinks: readonly RuntimeLink[],
  overlappingLinks: readonly RuntimeLink[],
): LocalHistoryReason {
  if (span.malformedNormalizedMessage) {
    return 'malformed-normalized-message';
  }
  if (span.malformed) return 'malformed-tool-protocol';
  if (
    span.protocol &&
    overlappingLinks.some(({ representation }) => representation === 'full') &&
    !coveringLinks.some(({ representation }) => representation === 'full')
  ) {
    return 'incomplete-protocol-link';
  }
  const representations = new Set(
    [...coveringLinks, ...overlappingLinks].map(({ representation }) =>
      representation,
    ),
  );
  if (
    [...representations].some(
      (representation) =>
        representation !== 'full' &&
        representation !== 'summary' &&
        representation !== 'artifact-ref',
    )
  ) {
    return 'unknown-representation';
  }
  if (representations.has('summary')) return 'summary-representation';
  if (representations.has('artifact-ref')) {
    return 'artifact-ref-representation';
  }
  return 'unlinked';
}

function normalizedMessages(
  boundaries: readonly ProjectedBoundaryMessage[],
): readonly NormalizedMessage[] {
  return boundaries.flatMap(({ normalizedMessage }) =>
    normalizedMessage === undefined ? [] : [normalizedMessage],
  );
}

function malformedEntries(
  boundaries: readonly ProjectedBoundaryMessage[],
): readonly MalformedHistoryEntry[] {
  return boundaries.flatMap((boundary) =>
    boundary.normalizedMessage !== undefined
      ? []
      : [
          {
            index: boundary.index,
            sessionId: boundary.sessionId,
            sessionSeq: boundary.sessionSeq,
            messageId: boundary.messageId,
            raw: boundary.rawMessage,
            reason: 'malformed-normalized-message' as const,
          },
        ],
  );
}

export function projectLocalHistory(
  boundaryMessages: readonly LocalBoundaryMessage[],
  persistedLinks: readonly SessionEventPairSpanLink[],
  options: ProjectLocalHistoryOptions,
): LocalHistoryProjection {
  canonicalJsonStringify(persistedLinks);
  if (!nonEmptyString(options.expectedSessionId)) {
    throw new LocalHistoryInvariantError('expectedSessionId is required');
  }
  const boundaries = boundaryMessages.map(normalizeBoundary);
  const duplicateMessageId = boundaries.some(
    ({ messageId }, index) =>
      boundaries.findIndex((candidate) => candidate.messageId === messageId) !==
      index,
  );
  const hasMalformedOrder = boundaries.some(
    (boundary, index) =>
      index > 0 &&
      boundary.sessionSeq <= (boundaries[index - 1]?.sessionSeq ?? 0),
  );
  const hasUnexpectedBoundarySession = boundaries.some(
    ({ sessionId }) => sessionId !== options.expectedSessionId,
  );
  const hasUnexpectedLinkSession = persistedLinks.some(
    (link) =>
      typeof link !== 'object' ||
      link === null ||
      link.sessionId !== options.expectedSessionId,
  );
  const degradedReason: LocalHistoryReason | undefined =
    hasUnexpectedBoundarySession
      ? 'unexpected-boundary-session'
      : hasUnexpectedLinkSession
        ? 'unexpected-link-session'
        : duplicateMessageId
          ? 'duplicate-message-id'
          : hasMalformedOrder
            ? 'malformed-message-order'
            : undefined;
  if (degradedReason !== undefined) {
    return {
      status: 'degraded',
      messages: normalizedMessages(boundaries),
      malformedEntries: malformedEntries(boundaries),
      spans: boundaries.length === 0
        ? []
        : [
            {
              source: 'local-history',
              fromSessionSeq: Math.min(...boundaries.map(({ sessionSeq }) => sessionSeq)),
              throughSessionSeq: Math.max(
                ...boundaries.map(({ sessionSeq }) => sessionSeq),
              ),
              messageIds: boundaries.map(({ messageId }) => messageId),
              decision: 'degraded',
              reason: degradedReason,
              linkedPairEventIds: [],
            },
          ],
    };
  }

  const runtimeLinks = persistedLinks
    .map(runtimeLink)
    .filter((link): link is RuntimeLink => link !== undefined);
  const validLinks = runtimeLinks.filter((link) =>
    linkMatchesPersistedRange(link, boundaries),
  );
  const outputMessages: NormalizedMessage[] = [];
  const outputSpans: LocalHistorySpanManifest[] = [];

  for (const span of buildSpans(boundaries)) {
    const first = span.items[0];
    const last = span.items.at(-1);
    if (first === undefined || last === undefined) continue;
    const coveringLinks = linksForSpan(span, validLinks);
    const overlappingLinks = validLinks.filter(
      (link) =>
        link.sessionId === first.sessionId &&
        link.fromSessionSeq <= last.sessionSeq &&
        link.throughSessionSeq >= first.sessionSeq,
    );
    const fullLink = coveringLinks.find(
      ({ representation }) => representation === 'full',
    );
    const excluded = !span.malformed && fullLink !== undefined;
    if (!excluded) {
      outputMessages.push(...normalizedMessages(span.items));
    }
    const relevantLinks = coveringLinks.length > 0 ? coveringLinks : overlappingLinks;
    outputSpans.push({
      source: 'local-history',
      fromSessionSeq: first.sessionSeq,
      throughSessionSeq: last.sessionSeq,
      messageIds: span.items.map(({ messageId }) => messageId),
      decision: excluded
        ? 'excluded'
        : span.malformed
          ? 'degraded'
          : 'retained',
      reason: excluded
        ? 'fully-represented-in-pair'
        : retainedReason(span, coveringLinks, overlappingLinks),
      linkedPairEventIds: [...new Set(relevantLinks.map(({ pairEventId }) => pairEventId))],
    });
  }

  const malformed = malformedEntries(boundaries);
  const degraded = outputSpans.some(({ decision }) => decision === 'degraded');
  return degraded
    ? {
        status: 'degraded',
        messages: outputMessages,
        malformedEntries: malformed,
        spans: outputSpans,
      }
    : {
        status: 'safe',
        messages: outputMessages,
        malformedEntries: [],
        spans: outputSpans,
      };
}
