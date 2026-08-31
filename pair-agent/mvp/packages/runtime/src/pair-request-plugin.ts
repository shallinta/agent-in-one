import { createHash } from 'node:crypto';

import {
  canonicalJsonStringify,
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
  type PairRequestLayout,
  type SessionEventPairSpanLink,
} from '@pair-agent/context';
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

function deliveryFromMessage(message: DshMessage): JsonObject | undefined {
  if (
    message.source.kind !== 'plugin' ||
    message.source.plugin !== DELIVERY_PLUGIN
  ) {
    return undefined;
  }
  const deliveryId = message.source.deliveryId;
  const pairEventId = message.source.pairEventId;
  const trigger = message.source.trigger;
  if (
    typeof deliveryId !== 'string' ||
    typeof pairEventId !== 'string' ||
    plainRecord(trigger) === undefined
  ) {
    throw new PairRequestBindingError('Pair delivery message has invalid provenance');
  }
  return trigger as JsonObject;
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
): {
  boundary: readonly LocalBoundaryMessage[];
  links: readonly SessionEventPairSpanLink[];
  currentTrigger?: JsonObject;
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
  const links: SessionEventPairSpanLink[] = [];
  let currentTrigger: JsonObject | undefined;
  for (const item of boundary) {
    const original = originals.get(item.messageId)!;
    const trigger = deliveryFromMessage(original);
    if (trigger === undefined) continue;
    const pairEventId = original.source.pairEventId as string;
    links.push({
      sessionId: payload.sessionId,
      fromSessionSeq: item.sessionSeq,
      throughSessionSeq: item.sessionSeq,
      messageIds: [item.messageId],
      representation: 'full',
      pairEventId,
    });
    currentTrigger = trigger;
  }
  return {
    boundary,
    links,
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
    const local = boundaryProjection(payload);
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
