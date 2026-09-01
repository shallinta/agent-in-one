import { createHash } from 'node:crypto';

import {
  canonicalJsonStringify,
  createPairSessionIds,
  type JsonObject,
  type JsonValue,
  type PairEvent,
  type PairId,
  type PairRole,
} from '@pair-agent/contracts';
import {
  buildPairRequestLayout,
  type LocalBoundaryMessage,
  type NormalizedMessage,
  type PairCurrentTrigger,
  type PairRequestLayout,
  type RequestLocalSessionLink,
  type SessionEventPairSpanLink,
} from '@pair-agent/context';
import { isCanonicalDirectedPeerMessage } from './peer-message-event.js';
import {
  JsonlPairLedgerStore,
  LedgerConflictError,
  replayPairProjection,
} from '@pair-agent/ledger';
import {
  ImmutablePairRequestMaterialRegistry,
  type PairRequestMaterialEntry,
} from './request-material-registry.js';

const DELIVERY_PLUGIN = 'pair-agent:delivery';
const PROJECTION_PLUGIN = 'pair-agent:request-projection';

interface DshMessage {
  readonly id: string;
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: readonly JsonObject[];
  readonly source: JsonObject;
}

interface DshSessionEvent {
  readonly type: string;
  readonly seq: number;
  readonly data: JsonValue;
  readonly surfaceOp?: JsonValue;
}

interface DshSession {
  readonly id: string;
  readonly events: readonly DshSessionEvent[];
  readonly surface: { readonly nodes: readonly number[] };
}

interface DshAgent {
  readonly id: string;
  readonly session: DshSession;
}

export interface DshRequestLayoutPayload {
  readonly agent: DshAgent;
  readonly sessionId: string;
  readonly turn: number;
  readonly step: number;
  readonly attempt: number;
  readonly config: Readonly<JsonObject>;
  readonly system?: string;
  readonly tools: readonly JsonObject[];
  readonly messages: readonly DshMessage[];
  readonly signal: AbortSignal;
}

interface PairScopedContext {
  readonly agent?: DshAgent;
  readonly systemPrompt: {
    section(input: {
      name: string;
      order: number;
      text: string;
      complete: true;
    }): () => void;
    suppressRuntimeContext(): () => void;
  };
  on(
    name: 'agent/request-layout',
    listener: (
      payload: DshRequestLayoutPayload,
      next: () => Promise<{ messages: readonly DshMessage[] }>,
    ) => Promise<{ messages: readonly DshMessage[] }>,
  ): () => void;
}

export interface PairRequestPluginBinding {
  readonly pairId: PairId;
  readonly role: PairRole;
  readonly sessionId: string;
}

export interface PairRequestPluginOptions {
  readonly store: JsonlPairLedgerStore;
  readonly binding: PairRequestPluginBinding;
  readonly materialRegistry: ImmutablePairRequestMaterialRegistry;
  readonly onLedgerAdvanced?: (pairId: PairId) => Promise<void> | void;
  readonly onRequestPersisted?: (
    request: PersistedPairRequest,
    signal: AbortSignal,
  ) => void;
}

export interface PersistedPairRequest {
  readonly requestId: string;
  readonly snapshotLedgerSeq: number;
  readonly messages: readonly DshMessage[];
  readonly snapshot: JsonObject;
  readonly fullRequestDigest: string;
}

export class PairRequestBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairRequestBindingError';
  }
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(canonicalJsonStringify(value), 'utf8')
    .digest('hex')}`;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function eventMessage(event: DshSessionEvent): DshMessage | undefined {
  const data = plainRecord(event.data);
  if (event.type === 'user/message') return data as unknown as DshMessage;
  if (event.type === 'assistant/message' || event.type === 'tool/result') {
    return plainRecord(data?.message) as unknown as DshMessage | undefined;
  }
  return undefined;
}

function dshToNormalized(message: DshMessage): NormalizedMessage {
  if (
    message.role === 'user' &&
    message.source.kind === 'tool' &&
    typeof message.source.callId === 'string'
  ) {
    const block = message.content.find((candidate) => candidate.type === 'tool-result');
    if (block === undefined || !Array.isArray(block.content)) {
      throw new PairRequestBindingError('DSH tool message is malformed');
    }
    return {
      role: 'tool',
      content: block.content as JsonValue,
      toolCallId: message.source.callId,
    };
  }
  if (message.role === 'assistant') {
    const calls = message.content.filter((block) => block.type === 'tool-call');
    const content = message.content.filter((block) => block.type !== 'tool-call');
    return {
      role: 'assistant',
      content,
      ...(calls.length === 0
        ? {}
        : {
            toolCalls: calls.map((call) => {
              if (
                typeof call.id !== 'string' ||
                typeof call.name !== 'string' ||
                typeof call.arguments !== 'string'
              ) {
                throw new PairRequestBindingError('DSH tool call is malformed');
              }
              const args: unknown = JSON.parse(call.arguments);
              if (plainRecord(args) === undefined) {
                throw new PairRequestBindingError(
                  'DSH tool call arguments must be a JSON object',
                );
              }
              return { id: call.id, name: call.name, arguments: args as JsonObject };
            }),
          }),
    };
  }
  return { role: message.role, content: message.content as JsonValue };
}

function pairEventId(event: Pick<PairEvent, 'pairId' | 'seq'>): string {
  return `${event.pairId}:${event.seq}`;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function activeSessionLinkPayload(
  event: PairEvent,
  activeSessionId: string,
): Record<string, unknown> | undefined {
  if (event.type !== 'session_event.linked') return undefined;
  const payload = plainRecord(event.payload);
  const sessionId = payload?.sessionId;
  const ids = createPairSessionIds(event.pairId);
  const role: PairRole | undefined = sessionId === ids.navigatorSessionId
    ? 'navigator'
    : sessionId === ids.pilotSessionId
      ? 'pilot'
      : undefined;
  if (
    payload?.schemaVersion !== 1 ||
    role === undefined ||
    event.actor.kind !== 'host' ||
    event.source !== `${role}-session` ||
    event.channel !== role ||
    event.visibility !== 'infrastructure' ||
    event.authority !== 'host'
  ) {
    throw new PairRequestBindingError(
      `Session link ${pairEventId(event)} has a non-canonical envelope or Session identity`,
    );
  }
  return sessionId === activeSessionId ? payload : undefined;
}

function isCanonicalTaskAssignment(event: PairEvent): boolean {
  if (
    event.type !== 'task.assigned' ||
    event.actor.kind !== 'agent' ||
    event.actor.role !== 'navigator' ||
    event.source !== 'navigator-session' ||
    event.channel !== 'shared-control' ||
    event.authority !== 'navigator'
  ) {
    return false;
  }
  const task = plainRecord(plainRecord(event.payload)?.task);
  return (
    task !== undefined &&
    nonEmptyString(task.id) &&
    Number.isSafeInteger(task.revision) &&
    (task.revision as number) > 0 &&
    nonEmptyString(task.summary) &&
    task.state === 'queued' &&
    event.refs.task?.id === task.id &&
    event.refs.task.revision === task.revision
  );
}

function isRepresentableSharedEvent(event: PairEvent, activeRole: PairRole): boolean {
  if (event.visibility !== 'shared') return false;
  if (isCanonicalTaskAssignment(event)) return activeRole === 'pilot';
  if (event.channel !== 'navigator' && event.channel !== 'pilot') return false;
  if (event.type === 'user.message') {
    return (
      event.channel === activeRole &&
      (event.source === 'pair' || event.source === `${event.channel}-session`)
    );
  }
  if (event.type === 'agent.message' && event.actor.kind === 'agent') {
    if (isCanonicalDirectedPeerMessage(event)) return event.channel === activeRole;
    return (
      event.channel === activeRole &&
      event.source === `${event.actor.role}-session` &&
      event.channel === event.actor.role
    );
  }
  return false;
}

export function persistentSessionLinks(
  pairEvents: readonly PairEvent[],
  activeSessionId: string,
): readonly SessionEventPairSpanLink[] {
  const activeRole: PairRole = activeSessionId.endsWith(':navigator')
    ? 'navigator'
    : 'pilot';
  const eventsById = new Map(
    pairEvents.map((event) => [pairEventId(event), event] as const),
  );
  return pairEvents.flatMap((event): readonly SessionEventPairSpanLink[] => {
    const payload = activeSessionLinkPayload(event, activeSessionId);
    if (payload === undefined) return [];
    const fromSessionSeq = payload.fromSessionSeq;
    const throughSessionSeq = payload.throughSessionSeq;
    const messageIds = payload.messageIds;
    const representedId = payload.pairEventId;
    const representation = payload.representation;
    if (
      (representation !== 'full' &&
        representation !== 'summary' &&
        representation !== 'artifact-ref') ||
      !Number.isSafeInteger(fromSessionSeq) ||
      (fromSessionSeq as number) <= 0 ||
      !Number.isSafeInteger(throughSessionSeq) ||
      (throughSessionSeq as number) < (fromSessionSeq as number) ||
      !Array.isArray(messageIds) ||
      messageIds.length === 0 ||
      !messageIds.every(nonEmptyString) ||
      new Set(messageIds).size !== messageIds.length ||
      !nonEmptyString(representedId)
    ) {
      throw new PairRequestBindingError(
        `Persisted Session link ${pairEventId(event)} is malformed`,
      );
    }
    const represented = eventsById.get(representedId);
    if (
      represented === undefined ||
      pairEventId(represented) !== representedId ||
      represented.seq >= event.seq ||
      !isRepresentableSharedEvent(represented, activeRole)
    ) {
      throw new PairRequestBindingError(
        `Persisted Session link ${pairEventId(event)} has no earlier canonical represented Pair message`,
      );
    }
    return [
      {
        sessionId: activeSessionId,
        fromSessionSeq: fromSessionSeq as number,
        throughSessionSeq: throughSessionSeq as number,
        messageIds: messageIds as string[],
        representation,
        pairEventId: representedId,
      },
    ];
  });
}

function hasExactPersistentFullLink(
  links: readonly SessionEventPairSpanLink[],
  boundary: LocalBoundaryMessage,
  representedPairEventId: string,
): boolean {
  return links.some(
    (link) =>
      link.representation === 'full' &&
      link.sessionId === boundary.sessionId &&
      link.fromSessionSeq === boundary.sessionSeq &&
      link.throughSessionSeq === boundary.sessionSeq &&
      link.messageIds.length === 1 &&
      link.messageIds[0] === boundary.messageId &&
      link.pairEventId === representedPairEventId,
  );
}

function expectedDeliveryTrigger(event: PairEvent): JsonObject | undefined {
  const payload = plainRecord(event.payload);
  if (payload === undefined) return undefined;
  if (
    event.type === 'user.message' &&
    (event.channel === 'navigator' || event.channel === 'pilot') &&
    nonEmptyString(payload.text)
  ) {
    return {
      kind: event.type,
      role: event.channel,
      text: payload.text,
      pairEventId: pairEventId(event),
    };
  }
  if (isCanonicalTaskAssignment(event)) {
    return {
      kind: event.type,
      pairEventId: pairEventId(event),
      task: payload.task as JsonObject,
    };
  }
  if (isCanonicalDirectedPeerMessage(event)) {
    return {
      kind: event.type,
      role: event.channel,
      text: payload.text as string,
      pairEventId: pairEventId(event),
      causalRootId: payload.causalRootId as string,
      hop: payload.hop as number,
    };
  }
  return undefined;
}

function deliveryTargetRole(event: PairEvent): PairRole | undefined {
  if (
    event.type === 'user.message' &&
    (event.channel === 'navigator' || event.channel === 'pilot')
  ) {
    return event.channel;
  }
  if (isCanonicalTaskAssignment(event)) return 'pilot';
  if (isCanonicalDirectedPeerMessage(event)) return event.channel as PairRole;
  return undefined;
}

function compactCurrentTrigger(
  event: PairEvent,
  deliveryId: string,
): PairCurrentTrigger {
  const payload = plainRecord(event.payload);
  return {
    kind: event.type,
    pairEventId: pairEventId(event),
    deliveryId,
    ...(nonEmptyString(payload?.causalRootId)
      ? { causalRootId: payload.causalRootId }
      : {}),
    ...(Number.isSafeInteger(payload?.hop) ? { hop: payload?.hop as number } : {}),
  };
}

function validateDeliveryProof(
  message: DshMessage,
  eventsById: ReadonlyMap<string, PairEvent>,
  activeRole: PairRole,
): {
  readonly pairEvent: PairEvent;
  readonly proof: RequestLocalSessionLink['proof'];
  readonly currentTrigger: PairCurrentTrigger;
} {
  const deliveryId = message.source.deliveryId;
  const representedId = message.source.pairEventId;
  const trigger = message.source.trigger;
  if (
    message.role !== 'user' ||
    !nonEmptyString(deliveryId) ||
    !nonEmptyString(representedId) ||
    deliveryId !== representedId ||
    plainRecord(trigger) === undefined
  ) {
    throw new PairRequestBindingError('Pair delivery message has invalid provenance');
  }
  const represented = eventsById.get(representedId);
  const expectedTrigger = represented === undefined
    ? undefined
    : expectedDeliveryTrigger(represented);
  if (
    represented === undefined ||
    represented.visibility !== 'shared' ||
    deliveryTargetRole(represented) !== activeRole ||
    pairEventId(represented) !== representedId ||
    expectedTrigger === undefined ||
    canonicalJsonStringify(trigger) !== canonicalJsonStringify(expectedTrigger)
  ) {
    throw new PairRequestBindingError(
      'Pair delivery provenance does not match its durable Pair Event',
    );
  }
  const expectedInput = createPairDeliveryMessageInput(
    deliveryId,
    trigger as JsonObject,
  );
  if (
    canonicalJsonStringify(message.content) !==
    canonicalJsonStringify(expectedInput.content)
  ) {
    throw new PairRequestBindingError(
      'Pair delivery normalized payload does not match its durable provenance',
    );
  }
  return {
    pairEvent: represented,
    proof: { kind: 'pair-delivery', pairEventId: representedId, deliveryId },
    currentTrigger: compactCurrentTrigger(represented, deliveryId),
  };
}

function validateNativeComposerProof(
  boundary: LocalBoundaryMessage,
  pairEvent: PairEvent,
  sourceEventId: string,
  role: PairRole,
): void {
  const payload = plainRecord(pairEvent.payload);
  const origin = plainRecord(payload?.origin);
  const expectedSource = role === 'navigator'
    ? 'navigator-session'
    : 'pilot-session';
  const normalizedPairMessage = payload === undefined
    ? undefined
    : { role: 'user', content: payload.content };
  if (
    pairEvent.type !== 'user.message' ||
    pairEvent.visibility !== 'shared' ||
    pairEvent.source !== expectedSource ||
    pairEvent.channel !== role ||
    pairEvent.authority !== 'user-derived' ||
    !pairEvent.refs.sourceEventIds?.includes(sourceEventId) ||
    origin?.schemaVersion !== 1 ||
    origin.sessionId !== boundary.sessionId ||
    origin.sessionEventSeq !== boundary.sessionSeq ||
    origin.messageId !== boundary.messageId ||
    canonicalJsonStringify(normalizedPairMessage) !==
      canonicalJsonStringify(boundary.message)
  ) {
    throw new PairRequestBindingError(
      'Native composer provenance does not match its durable Pair Event',
    );
  }
}

function textContent(content: JsonValue): readonly JsonObject[] {
  if (
    Array.isArray(content) &&
    content.every((entry) => plainRecord(entry) !== undefined)
  ) {
    return content as readonly JsonObject[];
  }
  return [{ type: 'text', text: canonicalJsonStringify(content) }];
}

function syntheticMessage(message: NormalizedMessage): DshMessage {
  const source: JsonObject = { kind: 'plugin', plugin: PROJECTION_PLUGIN };
  const content =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : textContent(message.content);
  const basis = { role: message.role, content, source };
  if (message.role === 'tool') {
    throw new PairRequestBindingError(
      'Pair-generated request prefix cannot contain a tool result',
    );
  }
  return {
    id: `pair-projection:${sha256(basis).slice('sha256:'.length, 38)}`,
    role: message.role,
    content,
    source,
  };
}

function boundaryProjection(
  payload: DshRequestLayoutPayload,
  pairEvents: readonly PairEvent[],
  role: PairRole,
): {
  boundary: readonly LocalBoundaryMessage[];
  links: readonly SessionEventPairSpanLink[];
  requestLocalLinks: readonly RequestLocalSessionLink[];
  currentTrigger?: PairCurrentTrigger;
  localSurfaceThroughSeq: number;
  originals: ReadonlyMap<string, DshMessage>;
} {
  const eventSeqByMessageId = new Map<string, number>();
  for (const seq of payload.agent.session.surface.nodes) {
    const event = payload.agent.session.events[seq];
    if (event === undefined) continue;
    const message = eventMessage(event);
    if (message !== undefined) eventSeqByMessageId.set(message.id, seq);
  }
  const originals = new Map(payload.messages.map((message) => [message.id, message]));
  const boundary = payload.messages.map((message): LocalBoundaryMessage => {
    const sessionSeq = eventSeqByMessageId.get(message.id);
    if (sessionSeq === undefined) {
      throw new PairRequestBindingError(
        `DSH boundary message ${message.id} is absent from the Session surface`,
      );
    }
    return {
      sessionId: payload.sessionId,
      sessionSeq,
      messageId: message.id,
      message: dshToNormalized(message),
    };
  });
  const links = persistentSessionLinks(pairEvents, payload.sessionId);
  const requestLocalLinks: RequestLocalSessionLink[] = [];
  let currentTrigger: PairCurrentTrigger | undefined;
  const current = payload.step === 1 ? boundary.at(-1) : undefined;
  const currentOriginal = current === undefined
    ? undefined
    : originals.get(current.messageId);
  if (current !== undefined && currentOriginal !== undefined) {
    if (
      currentOriginal.source.kind === 'plugin' &&
      currentOriginal.source.plugin === DELIVERY_PLUGIN
    ) {
      const eventsById = new Map(
        pairEvents.map((event) => [pairEventId(event), event] as const),
      );
      const verified = validateDeliveryProof(
        currentOriginal,
        eventsById,
        role,
      );
      currentTrigger = verified.currentTrigger;
      const hasPersistentProof = hasExactPersistentFullLink(
        links,
        current,
        pairEventId(verified.pairEvent),
      );
      if (!hasPersistentProof) {
        requestLocalLinks.push({
          sessionId: payload.sessionId,
          fromSessionSeq: current.sessionSeq,
          throughSessionSeq: current.sessionSeq,
          messageIds: [current.messageId],
          representation: 'full',
          pairEventId: pairEventId(verified.pairEvent),
          persistence: 'request-local',
          proof: verified.proof,
        });
      }
    } else if (currentOriginal.source.kind === 'user') {
      const sourceEventId =
        `dsh:${payload.sessionId}:${current.sessionSeq}:user.message`;
      const candidates = pairEvents.filter((event) =>
        event.refs.sourceEventIds?.includes(sourceEventId),
      );
      if (candidates.length > 1) {
        throw new PairRequestBindingError(
          `Native composer source ${sourceEventId} has multiple durable claims`,
        );
      }
      const represented = candidates[0];
      if (represented !== undefined) {
        validateNativeComposerProof(current, represented, sourceEventId, role);
        const hasPersistentProof = hasExactPersistentFullLink(
          links,
          current,
          pairEventId(represented),
        );
        if (!hasPersistentProof) {
          requestLocalLinks.push({
            sessionId: payload.sessionId,
            fromSessionSeq: current.sessionSeq,
            throughSessionSeq: current.sessionSeq,
            messageIds: [current.messageId],
            representation: 'full',
            pairEventId: pairEventId(represented),
            persistence: 'request-local',
            proof: { kind: 'native-composer', sourceEventId },
          });
        }
      }
    }
  }
  return {
    boundary,
    links,
    requestLocalLinks,
    ...(currentTrigger === undefined ? {} : { currentTrigger }),
    localSurfaceThroughSeq: Math.max(0, ...boundary.map((item) => item.sessionSeq)),
    originals,
  };
}

function materializeMessages(
  layout: PairRequestLayout,
  originals: ReadonlyMap<string, DshMessage>,
  hasTrigger: boolean,
): readonly DshMessage[] {
  const retainedIds = layout.manifest.spans.flatMap((span) =>
    span.decision === 'retained' ? [...span.messageIds] : [],
  );
  const local = retainedIds.map((messageId) => {
    const original = originals.get(messageId);
    if (original === undefined) {
      throw new PairRequestBindingError(
        `Retained DSH message ${messageId} is unavailable`,
      );
    }
    return original;
  });
  const prefixCount = 3;
  const syntheticPrefix = layout.messages.slice(0, prefixCount).map(syntheticMessage);
  const trigger = hasTrigger ? layout.messages.at(-1) : undefined;
  if (hasTrigger && trigger === undefined) {
    throw new PairRequestBindingError('Pair request layout omitted its trigger');
  }
  return [
    ...syntheticPrefix,
    ...local,
    ...(trigger === undefined ? [] : [syntheticMessage(trigger)]),
  ];
}

function requestId(payload: DshRequestLayoutPayload): string {
  return [
    payload.sessionId,
    payload.turn,
    payload.step,
    payload.attempt,
  ].join(':');
}

function storedRequest(
  events: readonly PairEvent[],
  id: string,
): PairEvent | undefined {
  return events.find((event) => {
    if (event.type !== 'pair.request_built') return false;
    return plainRecord(event.payload)?.requestId === id;
  });
}

function assertBinding(
  payload: DshRequestLayoutPayload,
  binding: PairRequestPluginBinding,
): void {
  if (
    payload.sessionId !== binding.sessionId ||
    payload.agent.id !== binding.sessionId ||
    payload.agent.session.id !== binding.sessionId
  ) {
    throw new PairRequestBindingError(
      `Request session does not match the authoritative ${binding.role} binding`,
    );
  }
}

export class PairRequestPlugin {
  readonly #inFlight = new Map<string, Promise<PersistedPairRequest>>();

  constructor(readonly options: PairRequestPluginOptions) {}

  install(context: PairScopedContext): void {
    context.systemPrompt.section({
      name: 'pair-agent:common-system',
      order: -1000,
      text: this.options.materialRegistry.active.commonSystem.content,
      complete: true,
    });
    context.systemPrompt.suppressRuntimeContext();
    // Pair scopes intentionally own the final Provider boundary exclusively.
    // Not calling `next` prevents a later listener from mutating the audited
    // layout after its durable snapshot has been written.
    context.on('agent/request-layout', async (payload, _next) => {
      const result = await this.layout(payload);
      return { messages: result.messages };
    });
  }

  layout(payload: DshRequestLayoutPayload): Promise<PersistedPairRequest> {
    assertBinding(payload, this.options.binding);
    if (payload.system !== this.options.materialRegistry.active.commonSystem.content) {
      return Promise.reject(
        new PairRequestBindingError(
          'DSH complete System Prompt does not match the Pair common prompt',
        ),
      );
    }
    const id = requestId(payload);
    const prior = this.#inFlight.get(id);
    if (prior !== undefined) return prior;
    const pending = this.#buildAndPersist(payload, id);
    this.#inFlight.set(id, pending);
    void pending.finally(() => {
      if (this.#inFlight.get(id) === pending) this.#inFlight.delete(id);
    }).catch(() => undefined);
    return pending;
  }

  /** Test-visible boundedness probe; request payloads are never exposed. */
  inFlightCount(): number {
    return this.#inFlight.size;
  }

  rebuild(
    payload: DshRequestLayoutPayload,
    id: string,
    events: readonly PairEvent[],
    materials: PairRequestMaterialEntry,
  ): PersistedPairRequest & { readonly manifest: JsonObject } {
    return this.#compose(payload, id, events, materials);
  }

  async #buildAndPersist(
    payload: DshRequestLayoutPayload,
    id: string,
  ): Promise<PersistedPairRequest> {
    const pairId = this.options.binding.pairId;
    while (true) {
      payload.signal.throwIfAborted();
      const events = await this.options.store.replay(pairId);
      const duplicate = storedRequest(events, id);
      if (duplicate !== undefined) {
        throw new PairRequestBindingError(
          `Request ${id} was already persisted outside this live attempt`,
        );
      }
      const projection = replayPairProjection(events);
      const composed = this.#compose(payload, id, events);
      try {
        const event = await this.options.store.append(
          pairId,
          {
            type: 'pair.request_built',
            actor: { kind: 'host' },
            source: 'pair',
            channel: 'shared-control',
            visibility: 'infrastructure',
            authority: 'host',
            refs: {},
            payload: {
              requestId: id,
              snapshot: composed.snapshot,
              manifest: composed.manifest,
            },
          },
          projection.header.ledgerHead,
        );
        await this.options.onLedgerAdvanced?.(pairId);
        const persisted = {
          requestId: id,
          snapshotLedgerSeq: event.seq,
          messages: composed.messages,
          snapshot: composed.snapshot,
          fullRequestDigest: composed.fullRequestDigest,
        };
        this.options.onRequestPersisted?.(persisted, payload.signal);
        return persisted;
      } catch (error) {
        if (error instanceof LedgerConflictError) continue;
        throw error;
      }
    }
  }

  #compose(
    payload: DshRequestLayoutPayload,
    id: string,
    events: readonly PairEvent[],
    selectedMaterials: PairRequestMaterialEntry = this.options.materialRegistry.active,
  ): PersistedPairRequest & { readonly manifest: JsonObject } {
    const projection = replayPairProjection(events);
    const sharedEvents = events.filter(
      (event) => event.visibility === 'shared',
    );
    const local = boundaryProjection(
      payload,
      events,
      this.options.binding.role,
    );
    const materials = selectedMaterials;
    if (
      payload.system !== materials.commonSystem.content ||
      canonicalJsonStringify(payload.tools) !== canonicalJsonStringify(materials.tools) ||
      canonicalJsonStringify(payload.config) !== canonicalJsonStringify(materials.config)
    ) {
      throw new PairRequestBindingError(
        'Actual Provider boundary does not match its immutable request material registry entry',
      );
    }
    const layout = buildPairRequestLayout({
      role: this.options.binding.role,
      sessionId: this.options.binding.sessionId,
      turn: payload.turn,
      step: payload.step,
      attempt: payload.attempt,
      sourceLedgerHead: projection.header.ledgerHead,
      sharedHead: projection.header.sharedHead,
      localSurfaceThroughSeq: local.localSurfaceThroughSeq,
      promptVersion: materials.promptVersion,
      toolSetVersion: materials.toolSetVersion,
      requestConfigVersion: materials.requestConfigVersion,
      commonSystem: materials.commonSystem,
      commonSystemPlacement: 'request-system',
      sharedEvents,
      projection,
      boundaryMessages: local.boundary,
      links: local.links,
      requestLocalLinks: local.requestLocalLinks,
      roleToolGuidance: materials.roleToolGuidance[this.options.binding.role],
        ...(payload.step === 1 && local.currentTrigger !== undefined
          ? { currentTrigger: local.currentTrigger }
          : {}),
      tools: payload.tools,
      config: payload.config,
    });
    const messages = materializeMessages(
      layout,
      local.originals,
      payload.step === 1 && local.currentTrigger !== undefined,
    );
    const messagesDigest = sha256(messages);
    const providerBoundary = {
      system: payload.system,
      messages,
      ...(payload.tools.length === 0 ? {} : { tools: payload.tools }),
      config: payload.config,
    } as unknown as JsonObject;
    const fullRequestDigest = sha256(providerBoundary);
    const snapshot: JsonObject = {
      ...layout.snapshot,
      requestId: id,
      messagesDigest,
      fullRequestDigest,
    };
    return {
      requestId: id,
      snapshotLedgerSeq: 0,
      messages,
      snapshot,
      fullRequestDigest,
      manifest: layout.manifest as unknown as JsonObject,
    };
  }
}

export function createPairDeliveryMessageInput(
  deliveryId: string,
  trigger: JsonObject,
): {
  content: readonly [{ readonly type: 'text'; readonly text: string }];
  source: JsonObject;
} {
  const pairEventId = trigger.pairEventId;
  if (typeof pairEventId !== 'string' || pairEventId.length === 0) {
    throw new PairRequestBindingError('Pair trigger requires pairEventId');
  }
  return {
    content: [
      {
        type: 'text',
        text: `<pair-delivery>${canonicalJsonStringify(trigger)}</pair-delivery>`,
      },
    ],
    source: {
      kind: 'plugin',
      plugin: DELIVERY_PLUGIN,
      deliveryId,
      pairEventId,
      trigger,
    },
  };
}
