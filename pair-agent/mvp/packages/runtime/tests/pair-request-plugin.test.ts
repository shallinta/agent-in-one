import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPairSessionIds,
  parsePairId,
  type JsonObject,
  type PairEvent,
} from '@pair-agent/contracts';
import { JsonlPairLedgerStore } from '@pair-agent/ledger';
import {
  createRepresentedContentDigest,
  SHARED_EVENT_CONTEXT_TEXT_DEDUP_V1,
} from '@pair-agent/context';
import { vi, describe, expect, test } from 'vitest';

import {
  createPairDeliveryMessageInput,
  PairRequestBindingError,
  PairRequestPlugin,
  persistentSessionLinks,
  rebuildAcceptedPairDeliveryIds,
} from '../src/pair-request-plugin.js';
import { ImmutablePairRequestMaterialRegistry } from '../src/request-material-registry.js';

function materialRegistry(): ImmutablePairRequestMaterialRegistry {
  return new ImmutablePairRequestMaterialRegistry({
    sharedEventContextFormat: SHARED_EVENT_CONTEXT_TEXT_DEDUP_V1,
    promptVersion: 'pair-prompt/v1',
    commonSystem: { version: 'pair-prompt/v1', content: 'complete prompt' },
    roleToolGuidance: { navigator: 'govern', pilot: 'execute' },
    toolSetVersion: 'tools/v1',
    tools: [],
    requestConfigVersion: 'request/v1',
    config: {},
  });
}

function pairCreated(pairId: string): PairEvent {
  const ids = createPairSessionIds(pairId);
  return {
    pairId: parsePairId(pairId),
    seq: 1,
    type: 'pair.created',
    actor: { kind: 'pair' },
    source: 'pair',
    channel: 'shared-control',
    visibility: 'shared',
    authority: 'host',
    refs: {},
    payload: {
      schemaVersion: 1,
      pairProtocol: 'pair-agent/p0.5',
      ...ids,
    },
    occurredAt: '2026-08-31T00:00:01.000Z',
  };
}

function sharedUserMessage(
  pairId: string,
  sessionId: string,
  messageId: string,
  text: string,
  refs: PairEvent['refs'] = {},
): PairEvent {
  return {
    pairId: parsePairId(pairId),
    seq: 2,
    type: 'user.message',
    actor: { kind: 'user' },
    source: sessionId.endsWith(':navigator')
      ? 'navigator-session'
      : 'pilot-session',
    channel: sessionId.endsWith(':navigator') ? 'navigator' : 'pilot',
    visibility: 'shared',
    authority: 'user-derived',
    refs,
    payload: {
      schemaVersion: 1,
      kind: 'user-input',
      text,
      content: [{ type: 'text', text }],
      origin: {
        schemaVersion: 1,
        sessionId,
        sessionEventSeq: 1,
        turn: 1,
        messageId,
      },
    },
    occurredAt: '2026-08-31T00:00:02.000Z',
  };
}

function directedPeerMessage(
  pairId: string,
  overrides: Partial<PairEvent> = {},
): PairEvent {
  return {
    pairId: parsePairId(pairId),
    seq: 2,
    type: 'agent.message',
    actor: { kind: 'agent', role: 'navigator' },
    source: 'navigator-session',
    channel: 'pilot',
    visibility: 'shared',
    authority: 'navigator',
    refs: {
      sourceEventIds: [`dsh:pair:${pairId}:navigator:turn:1:peer-message`],
    },
    payload: {
      schemaVersion: 1,
      kind: 'peer-message',
      text: 'bounded peer input',
      content: [{ type: 'text', text: 'bounded peer input' }],
      causalRootId: `${pairId}:root`,
      hop: 2,
    },
    occurredAt: '2026-08-31T00:00:02.000Z',
    ...overrides,
  };
}

function directedPeerTrigger(pairId: string): JsonObject {
  return {
    kind: 'agent.message',
    role: 'pilot',
    text: 'bounded peer input',
    pairEventId: `${pairId}:2`,
    causalRootId: `${pairId}:root`,
    hop: 2,
  };
}

function completionHandoff(
  pairId: string,
  overrides: Partial<PairEvent> = {},
): PairEvent {
  const sessionId = createPairSessionIds(pairId).pilotSessionId;
  const sessionEventSeq = 42;
  return {
    pairId: parsePairId(pairId),
    seq: 2,
    type: 'agent.message',
    actor: { kind: 'agent', role: 'pilot' },
    source: 'pilot-session',
    channel: 'navigator',
    visibility: 'shared',
    authority: 'pilot',
    refs: {
      sourceEventIds: [
        `dsh:${sessionId}:${String(sessionEventSeq)}:agent.message`,
      ],
    },
    payload: {
      schemaVersion: 1,
      kind: 'completion-handoff',
      text: 'complete delegated report',
      content: [{ type: 'text', text: 'complete delegated report' }],
      completion: 'complete',
      causalRootId: `${pairId}:root`,
      hop: 2,
      origin: {
        schemaVersion: 1,
        sessionId,
        sessionEventSeq,
        turn: 7,
        messageId: 'completion-message-42',
      },
    },
    occurredAt: '2026-09-03T00:00:02.000Z',
    ...overrides,
  };
}

function completionTrigger(pairId: string): JsonObject {
  return {
    kind: 'completion-handoff',
    pairEventId: `${pairId}:2`,
    senderRole: 'pilot',
    senderTurn: 7,
  };
}

function pilotTurnFailure(pairId: string): PairEvent {
  const sessionId = createPairSessionIds(pairId).pilotSessionId;
  return {
    pairId: parsePairId(pairId),
    seq: 2,
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
        sessionId,
        sessionEventSeq: 42,
      },
    },
    occurredAt: '2026-09-03T00:00:02.000Z',
  };
}

function pilotTurnFailureTrigger(pairId: string): JsonObject {
  return {
    kind: 'agent.turn_failed',
    pairEventId: `${pairId}:2`,
    failedRole: 'pilot',
    failedTurn: 4,
    code: 'UNKNOWN',
  };
}

function deliveryMessage(deliveryId: string, trigger: JsonObject) {
  const input = createPairDeliveryMessageInput(deliveryId, trigger);
  return {
    id: `delivery-${deliveryId}`,
    role: 'user' as const,
    content: input.content,
    source: input.source,
  };
}

function persistedLink(
  pairId: string,
  sessionId: string,
  messageId: string,
  overrides: Partial<PairEvent> = {},
): PairEvent {
  return {
    pairId: parsePairId(pairId),
    seq: 3,
    type: 'session_event.linked',
    actor: { kind: 'host' },
    source: sessionId.endsWith(':navigator')
      ? 'navigator-session'
      : 'pilot-session',
    channel: sessionId.endsWith(':navigator') ? 'navigator' : 'pilot',
    visibility: 'infrastructure',
    authority: 'host',
    refs: {},
    payload: {
      schemaVersion: 1,
      sessionId,
      fromSessionSeq: 1,
      throughSessionSeq: 1,
      messageIds: [messageId],
      pairEventId: `${pairId}:2`,
      representation: 'full',
    },
    occurredAt: '2026-08-31T00:00:03.000Z',
    ...overrides,
  };
}

function dshUserMessage(
  id: string,
  text: string,
  source: JsonObject,
): {
  readonly id: string;
  readonly role: 'user';
  readonly content: readonly JsonObject[];
  readonly source: JsonObject;
} {
  return { id, role: 'user', content: [{ type: 'text', text }], source };
}

function requestPayload(
  sessionId: string,
  message: ReturnType<typeof dshUserMessage>,
) {
  return {
    agent: {
      id: sessionId,
      session: {
        id: sessionId,
        events: [
          { type: 'ignored', seq: 0, data: null },
          { type: 'user/message', seq: 1, data: message },
        ],
        surface: { nodes: [1] },
      },
    },
    sessionId,
    turn: 1,
    step: 1,
    attempt: 1,
    config: {},
    system: 'complete prompt',
    tools: [],
    messages: [message],
    signal: new AbortController().signal,
  } as const;
}

function rebuild(
  pairId: string,
  events: readonly PairEvent[],
  payload: ReturnType<typeof requestPayload>,
) {
  const registry = materialRegistry();
  const plugin = new PairRequestPlugin({
    store: {} as never,
    binding: {
      pairId: parsePairId(pairId),
      role: payload.sessionId.endsWith(':navigator') ? 'navigator' : 'pilot',
      sessionId: payload.sessionId,
    },
    materialRegistry: registry,
  });
  return plugin.rebuild(payload as never, `${payload.sessionId}:1:1:1`, events, registry.active);
}

describe('PairRequestPlugin request-layout ownership', () => {
  test('installs the complete Pair prompt and terminates the waterfall at the audited layout', async () => {
    let listener:
      | ((
          payload: unknown,
          next: () => Promise<{ messages: readonly unknown[] }>,
        ) => Promise<{ messages: readonly unknown[] }>)
      | undefined;
    const section = vi.fn(() => vi.fn());
    const suppressRuntimeContext = vi.fn(() => vi.fn());
    const context = {
      systemPrompt: { section, suppressRuntimeContext },
      on: vi.fn((_name: string, registered: typeof listener) => {
        listener = registered;
        return vi.fn();
      }),
    };
    const plugin = new PairRequestPlugin({
      store: {} as never,
      binding: {
        pairId: 'pair-plugin-exclusive' as never,
        role: 'navigator',
        sessionId: 'pair:pair-plugin-exclusive:navigator',
      },
      materialRegistry: new ImmutablePairRequestMaterialRegistry({
        sharedEventContextFormat: SHARED_EVENT_CONTEXT_TEXT_DEDUP_V1,
        promptVersion: 'pair-prompt/v1',
        commonSystem: { version: 'pair-prompt/v1', content: 'complete prompt' },
        roleToolGuidance: { navigator: 'govern', pilot: 'execute' },
        toolSetVersion: 'tools/v1',
        tools: [],
        requestConfigVersion: 'request/v1',
        config: {},
      }),
    });
    const messages = [{ id: 'audited' }] as never;
    vi.spyOn(plugin, 'layout').mockResolvedValue({
      requestId: 'request-1',
      snapshotLedgerSeq: 3,
      messages,
      snapshot: {},
      fullRequestDigest: `sha256:${'0'.repeat(64)}`,
    });
    plugin.install(context as never);
    const next = vi.fn(async () => ({ messages: [] as unknown[] }));

    const result = await listener!({}, next);

    expect(section).toHaveBeenCalledWith({
      name: 'pair-agent:common-system',
      order: -1000,
      text: 'complete prompt',
      complete: true,
    });
    expect(suppressRuntimeContext).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
    expect(result.messages).toBe(messages);
  });

  test('shares one live attempt and removes it after settlement', async () => {
    const materialRegistry = new ImmutablePairRequestMaterialRegistry({
      sharedEventContextFormat: SHARED_EVENT_CONTEXT_TEXT_DEDUP_V1,
      promptVersion: 'pair-prompt/v1',
      commonSystem: { version: 'pair-prompt/v1', content: 'complete prompt' },
      roleToolGuidance: { navigator: 'govern', pilot: 'execute' },
      toolSetVersion: 'tools/v1',
      tools: [],
      requestConfigVersion: 'request/v1',
      config: {},
    });
    const plugin = new PairRequestPlugin({
      store: {} as never,
      binding: {
        pairId: 'pair-plugin-bounded' as never,
        role: 'navigator',
        sessionId: 'pair:pair-plugin-bounded:navigator',
      },
      materialRegistry,
    });
    const payload = {
      agent: {
        id: 'pair:pair-plugin-bounded:navigator',
        session: {
          id: 'pair:pair-plugin-bounded:navigator',
          events: [],
          surface: { nodes: [] },
        },
      },
      sessionId: 'pair:pair-plugin-bounded:navigator',
      turn: 1,
      step: 1,
      attempt: 1,
      config: {},
      system: 'complete prompt',
      tools: [],
      messages: [],
      signal: new AbortController().signal,
    } as never;

    const first = plugin.layout(payload);
    const second = plugin.layout(payload);
    expect(second).toBe(first);
    expect(plugin.inFlightCount()).toBe(1);
    await expect(first).rejects.toThrow();
    await Promise.resolve();
    expect(plugin.inFlightCount()).toBe(0);
    await expect(plugin.layout(payload)).rejects.toThrow();
    expect(plugin.inFlightCount()).toBe(0);
  });

  test('clears a successful attempt and then fails closed on its durable duplicate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pair-plugin-success-'));
    try {
      const pairId = 'pair-plugin-success';
      const ids = createPairSessionIds(pairId);
      const store = new JsonlPairLedgerStore(root);
      await store.append(
        pairId,
        {
          type: 'pair.created',
          actor: { kind: 'pair' },
          source: 'pair',
          channel: 'shared-control',
          visibility: 'shared',
          authority: 'host',
          refs: {},
          payload: {
            schemaVersion: 1,
            pairProtocol: 'pair-agent/p0.5',
            ...ids,
          },
        },
        0,
      );
      const materialRegistry = new ImmutablePairRequestMaterialRegistry({
        sharedEventContextFormat: SHARED_EVENT_CONTEXT_TEXT_DEDUP_V1,
        promptVersion: 'pair-prompt/v1',
        commonSystem: { version: 'pair-prompt/v1', content: 'complete prompt' },
        roleToolGuidance: { navigator: 'govern', pilot: 'execute' },
        toolSetVersion: 'tools/v1',
        tools: [],
        requestConfigVersion: 'request/v1',
        config: {},
      });
      const plugin = new PairRequestPlugin({
        store,
        binding: {
          pairId: pairId as never,
          role: 'navigator',
          sessionId: ids.navigatorSessionId,
        },
        materialRegistry,
      });
      const payload = {
        agent: {
          id: ids.navigatorSessionId,
          session: { id: ids.navigatorSessionId, events: [], surface: { nodes: [] } },
        },
        sessionId: ids.navigatorSessionId,
        turn: 1,
        step: 1,
        attempt: 1,
        config: {},
        system: 'complete prompt',
        tools: [],
        messages: [],
        signal: new AbortController().signal,
      } as never;

      const first = plugin.layout(payload);
      expect(plugin.layout(payload)).toBe(first);
      await expect(first).resolves.toMatchObject({ snapshotLedgerSeq: 2 });
      expect(plugin.inFlightCount()).toBe(0);
      await expect(plugin.layout(payload)).rejects.toThrow(/already persisted/i);
      expect(plugin.inFlightCount()).toBe(0);
      expect((await store.read(pairId)).filter(({ type }) => type === 'pair.request_built'))
        .toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('PairRequestPlugin exactly-once request projection', () => {
  test('materializes a digest-proven summary link across trailing non-message events', () => {
    const pairId = 'pair-summary-materialization';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const text = 'shared visible result';
    const assistant = {
      id: 'assistant-summary',
      role: 'assistant' as const,
      content: [
        { type: 'reasoning', text: 'retain local reasoning' },
        { type: 'text', text },
        { type: 'image', attachment: { attachmentId: 'image-1' } },
      ],
      source: { kind: 'model', provider: 'capture', model: 'capture' },
    };
    const current = dshUserMessage('current-user', 'continue', { kind: 'user' });
    const represented: PairEvent = {
      ...sharedUserMessage(pairId, sessionId, assistant.id, text),
      type: 'agent.message',
      actor: { kind: 'agent', role: 'navigator' },
      authority: 'navigator',
      payload: {
        schemaVersion: 1,
        kind: 'turn-output',
        text,
        content: [{ type: 'text', text }],
        completion: 'complete',
        origin: {
          schemaVersion: 1,
          sessionId,
          sessionEventSeq: 1,
          turn: 1,
          messageId: assistant.id,
        },
      },
    };
    const base = persistedLink(pairId, sessionId, assistant.id);
    const summaryLink: PairEvent = {
      ...base,
      payload: {
        ...(base.payload as JsonObject),
        fromSessionSeq: 1,
        throughSessionSeq: 3,
        representation: 'summary',
        representedContentDigest: createRepresentedContentDigest(
          represented.payload.content as readonly JsonObject[],
        ),
      },
    };
    const events = [
      { type: 'ignored', seq: 0, data: null },
      { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: assistant } },
      { type: 'step/end', seq: 2, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'user/message', seq: 4, data: current },
    ] as const;
    const payload = {
      ...requestPayload(sessionId, current),
      agent: {
        id: sessionId,
        session: { id: sessionId, events, surface: { nodes: [1, 4] } },
      },
      messages: [assistant, current],
      turn: 2,
    } as const;

    const result = rebuild(
      pairId,
      [pairCreated(pairId), represented, summaryLink],
      payload as never,
    );

    expect(result.messages.find(({ id }) => id === assistant.id)?.content).toEqual([
      { type: 'reasoning', text: 'retain local reasoning' },
      { type: 'image', attachment: { attachmentId: 'image-1' } },
    ]);
    expect(result.manifest.spans).toContainEqual(
      expect.objectContaining({
        messageIds: [assistant.id],
        reason: 'summary-text-deduplicated',
      }),
    );
  });

  test('retains a summary link without dedup proof when its digest disagrees with the Pair Event', () => {
    const pairId = 'pair-summary-wrong-digest';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const represented = sharedUserMessage(
      pairId,
      sessionId,
      'message-1',
      'canonical shared text',
    );
    const base = persistedLink(pairId, sessionId, 'message-1');
    const summaryLink: PairEvent = {
      ...base,
      payload: {
        ...(base.payload as JsonObject),
        representation: 'summary',
        representedContentDigest: createRepresentedContentDigest([
          { type: 'text', text: 'different text' },
        ]),
      },
    };

    const links = persistentSessionLinks(
      [pairCreated(pairId), represented, summaryLink],
      sessionId,
    );
    expect(links).toEqual([
      expect.objectContaining({
        representation: 'summary',
        pairEventId: `${pairId}:2`,
      }),
    ]);
    expect(links[0]).not.toHaveProperty('representedContentDigest');
  });

  test('retains a legacy summary link without a content digest as non-deduplicating proof', () => {
    const pairId = 'pair-summary-legacy-no-digest';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const represented = sharedUserMessage(
      pairId,
      sessionId,
      'message-1',
      'canonical shared text',
    );
    const base = persistedLink(pairId, sessionId, 'message-1');
    const legacySummaryLink: PairEvent = {
      ...base,
      payload: {
        ...(base.payload as JsonObject),
        representation: 'summary',
      },
    };

    const links = persistentSessionLinks(
      [pairCreated(pairId), represented, legacySummaryLink],
      sessionId,
    );
    expect(links).toEqual([
      expect.objectContaining({
        representation: 'summary',
      }),
    ]);
    expect(links[0]).not.toHaveProperty('representedContentDigest');
  });

  test('rejects a summary link whose message identity disagrees with represented origin', () => {
    const pairId = 'pair-summary-wrong-message';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const represented = sharedUserMessage(
      pairId,
      sessionId,
      'represented-message',
      'canonical shared text',
    );
    const base = persistedLink(pairId, sessionId, 'different-message');
    const summaryLink: PairEvent = {
      ...base,
      payload: {
        ...(base.payload as JsonObject),
        representation: 'summary',
        representedContentDigest: createRepresentedContentDigest(
          represented.payload.content as readonly JsonObject[],
        ),
      },
    };

    expect(() =>
      persistentSessionLinks(
        [pairCreated(pairId), represented, summaryLink],
        sessionId,
      ),
    ).toThrow(/origin/i);
  });

  test('rejects a summary link backed by a Pair-origin message instead of its own Session', () => {
    const pairId = 'pair-summary-wrong-source';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const text = 'canonical shared text';
    const represented: PairEvent = {
      ...sharedUserMessage(pairId, sessionId, 'message-1', text),
      source: 'pair',
      authority: 'user',
    };
    const base = persistedLink(pairId, sessionId, 'message-1');
    const summaryLink: PairEvent = {
      ...base,
      payload: {
        ...(base.payload as JsonObject),
        representation: 'summary',
        representedContentDigest: createRepresentedContentDigest(
          represented.payload.content as readonly JsonObject[],
        ),
      },
    };

    expect(() =>
      persistentSessionLinks(
        [pairCreated(pairId), represented, summaryLink],
        sessionId,
      ),
    ).toThrow(/summary source/i);
  });

  test('rejects a summary link whose represented origin is not the start of its range', () => {
    const pairId = 'pair-summary-origin-not-start';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const text = 'canonical shared text';
    const baseRepresented = sharedUserMessage(
      pairId,
      sessionId,
      'message-2',
      text,
    );
    const represented: PairEvent = {
      ...baseRepresented,
      payload: {
        ...(baseRepresented.payload as JsonObject),
        origin: {
          schemaVersion: 1,
          sessionId,
          sessionEventSeq: 2,
          turn: 1,
          messageId: 'message-2',
        },
      },
    };
    const base = persistedLink(pairId, sessionId, 'message-2');
    const summaryLink: PairEvent = {
      ...base,
      payload: {
        ...(base.payload as JsonObject),
        fromSessionSeq: 1,
        throughSessionSeq: 3,
        representation: 'summary',
        representedContentDigest: createRepresentedContentDigest(
          represented.payload.content as readonly JsonObject[],
        ),
      },
    };

    expect(() =>
      persistentSessionLinks(
        [pairCreated(pairId), represented, summaryLink],
        sessionId,
      ),
    ).toThrow(/origin/i);
  });

  test('rejects a summary link backed by a non-canonical visible-text payload', () => {
    const pairId = 'pair-summary-wrong-visible-text';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const baseRepresented = sharedUserMessage(
      pairId,
      sessionId,
      'message-1',
      'canonical content',
    );
    const represented: PairEvent = {
      ...baseRepresented,
      payload: {
        ...(baseRepresented.payload as JsonObject),
        text: 'different payload text',
      },
    };
    const base = persistedLink(pairId, sessionId, 'message-1');
    const summaryLink: PairEvent = {
      ...base,
      payload: {
        ...(base.payload as JsonObject),
        representation: 'summary',
        representedContentDigest: createRepresentedContentDigest(
          represented.payload.content as readonly JsonObject[],
        ),
      },
    };

    expect(() =>
      persistentSessionLinks(
        [pairCreated(pairId), represented, summaryLink],
        sessionId,
      ),
    ).toThrow(/visible text/i);
  });

  test('uses the immutable material-selected shared-event projection format', () => {
    const pairId = 'pair-model-projection-format';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const text = 'Keep this text once in the model projection.';

    const result = rebuild(
      pairId,
      [pairCreated(pairId), sharedUserMessage(pairId, sessionId, 'message-1', text)],
      requestPayload(sessionId, dshUserMessage('message-1', text, { kind: 'user' })),
    );

    const sharedEvents = String(result.messages[0]?.content[0]?.text);
    expect(sharedEvents).toContain('schema="pair-event-context/text-dedup-v1"');
    expect(sharedEvents).toContain(`"text":"${text}"`);
    expect(sharedEvents).not.toContain(`"content":[{"text":"${text}","type":"text"}]`);
    expect(result.snapshot).toMatchObject({
      sharedEventContextFormat: SHARED_EVENT_CONTEXT_TEXT_DEDUP_V1,
    });
    expect(result.manifest).toMatchObject({
      sharedEventContextFormat: SHARED_EVENT_CONTEXT_TEXT_DEDUP_V1,
    });
  });

  test('accepts a canonical directed peer delivery as request-local proof', () => {
    const pairId = 'pair-peer-delivery-proof';
    const sessionId = createPairSessionIds(pairId).pilotSessionId;
    const durableId = `${pairId}:2`;
    const delivery = createPairDeliveryMessageInput(
      durableId,
      directedPeerTrigger(pairId),
    );
    const message = {
      id: 'peer-delivery-message',
      role: 'user' as const,
      content: delivery.content,
      source: delivery.source,
    };

    const result = rebuild(
      pairId,
      [pairCreated(pairId), directedPeerMessage(pairId)],
      requestPayload(sessionId, message),
    );

    expect(result.messages.some(({ id }) => id === message.id)).toBe(false);
    expect(result.manifest.spans).toEqual([
      expect.objectContaining({
        messageIds: [message.id],
        decision: 'excluded',
        linkedPairEventIds: [durableId],
      }),
    ]);
    expect(result.messages.at(-1)?.content[0]?.text).toBe(
      `<pair-trigger schema="pair-trigger/v1">\n` +
      `{"causalRootId":"${pairId}:root","deliveryId":"${durableId}","hop":2,"kind":"agent.message","pairEventId":"${durableId}"}\n` +
      '</pair-trigger>',
    );
  });

  test('accepts only a reference-only Pilot completion delivery with a covering snapshot', () => {
    const pairId = 'pair-completion-delivery-proof';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const durableId = `${pairId}:2`;
    const hostTrigger = completionTrigger(pairId);
    const delivery = createPairDeliveryMessageInput(durableId, hostTrigger);
    const message = {
      id: 'completion-delivery-message',
      role: 'user' as const,
      content: delivery.content,
      source: delivery.source,
    };

    const result = rebuild(
      pairId,
      [pairCreated(pairId), completionHandoff(pairId)],
      requestPayload(sessionId, message),
    );

    expect(delivery.source.trigger).toEqual(hostTrigger);
    expect(Object.keys(delivery.source.trigger as JsonObject).sort()).toEqual([
      'kind',
      'pairEventId',
      'senderRole',
      'senderTurn',
    ]);
    expect(JSON.stringify(delivery.source.trigger)).not.toContain(
      'complete delegated report',
    );
    expect(result.snapshot).toMatchObject({ sourceLedgerHead: 2 });
    expect(result.messages.some(({ id }) => id === message.id)).toBe(false);
    expect(result.messages.at(-1)?.content[0]?.text).toBe(
      `<pair-trigger schema="pair-trigger/v1">\n` +
      `{"kind":"completion-handoff","pairEventId":"${durableId}","senderRole":"pilot","senderTurn":7}\n` +
      '</pair-trigger>',
    );
    expect(
      JSON.stringify(result.messages).split('complete delegated report'),
    ).toHaveLength(2);
  });

  test('accepts a reference-only Pilot Turn failure delivery for Navigator', () => {
    const pairId = 'pair-pilot-turn-failure-delivery';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const durableId = `${pairId}:2`;
    const trigger = pilotTurnFailureTrigger(pairId);
    const message = deliveryMessage(durableId, trigger);

    const result = rebuild(
      pairId,
      [pairCreated(pairId), pilotTurnFailure(pairId)],
      requestPayload(sessionId, message),
    );

    expect(result.messages.some(({ id }) => id === message.id)).toBe(false);
    expect(result.messages.at(-1)?.content[0]?.text).toBe(
      `<pair-trigger schema="pair-trigger/v1">\n` +
      `{"code":"UNKNOWN","failedRole":"pilot","failedTurn":4,"kind":"agent.turn_failed","pairEventId":"${durableId}"}\n` +
      '</pair-trigger>',
    );
    expect(JSON.stringify(result.messages)).toContain('request layout rejected');
  });

  test.each([
    ['Navigator sender', { actor: { kind: 'agent', role: 'navigator' } }],
    ['Pilot receiver', { channel: 'pilot' }],
    ['missing canonical origin', {
      payload: {
        schemaVersion: 1,
        kind: 'completion-handoff',
        text: 'complete delegated report',
        content: [{ type: 'text', text: 'complete delegated report' }],
        completion: 'complete',
        causalRootId: 'root',
        hop: 2,
      },
    }],
  ] as const)('rejects a completion delivery with %s', (_label, override) => {
    const pairId = 'pair-completion-delivery-strict';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const durableId = `${pairId}:2`;
    const delivery = createPairDeliveryMessageInput(
      durableId,
      completionTrigger(pairId),
    );
    const message = {
      id: 'completion-delivery-message',
      role: 'user' as const,
      content: delivery.content,
      source: delivery.source,
    };

    expect(() =>
      rebuild(
        pairId,
        [
          pairCreated(pairId),
          completionHandoff(pairId, override as Partial<PairEvent>),
        ],
        requestPayload(sessionId, message),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test('accepts only a canonical directed peer event as persistent full-link proof', () => {
    const pairId = 'pair-peer-persistent-proof';
    const sessionId = createPairSessionIds(pairId).pilotSessionId;
    const message = dshUserMessage('peer-linked-message', 'already represented', {
      kind: 'plugin',
      plugin: 'pair-agent:delivery-replay',
    });
    const link = persistedLink(pairId, sessionId, message.id);

    const result = rebuild(
      pairId,
      [pairCreated(pairId), directedPeerMessage(pairId), link],
      requestPayload(sessionId, message),
    );

    expect(result.messages.some(({ id }) => id === message.id)).toBe(false);
    expect(result.manifest.spans).toEqual([
      expect.objectContaining({
        decision: 'excluded',
        linkedPairEventIds: [`${pairId}:2`],
      }),
    ]);
  });

  test('rejects a whitespace-only directed peer event as persistent full-link proof', () => {
    const pairId = 'pair-peer-whitespace-persistent-proof';
    const sessionId = createPairSessionIds(pairId).pilotSessionId;
    const text = '   ';
    const message = dshUserMessage('peer-linked-whitespace', 'already represented', {
      kind: 'plugin',
      plugin: 'pair-agent:delivery-replay',
    });
    const durable = directedPeerMessage(pairId, {
      payload: {
        schemaVersion: 1,
        kind: 'peer-message',
        text,
        content: [{ type: 'text', text }],
        causalRootId: `${pairId}:root`,
        hop: 2,
      },
    });

    expect(() =>
      rebuild(
        pairId,
        [pairCreated(pairId), durable, persistedLink(pairId, sessionId, message.id)],
        requestPayload(sessionId, message),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test('rejects a canonical peer persistent link owned by the non-receiver Session', () => {
    const pairId = 'pair-peer-wrong-persistent-owner';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const message = dshUserMessage('wrong-owner-message', 'must not deduplicate', {
      kind: 'plugin',
      plugin: 'pair-agent:delivery-replay',
    });
    const link = persistedLink(pairId, sessionId, message.id);

    expect(() =>
      rebuild(
        pairId,
        [pairCreated(pairId), directedPeerMessage(pairId), link],
        requestPayload(sessionId, message),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test.each([
    ['actor', { actor: { kind: 'user' } }],
    ['source', { source: 'pilot-session' }],
    ['channel', { channel: 'pilot' }],
    ['visibility', { visibility: 'shared' }],
    ['authority', { authority: 'user' }],
    [
      'missing payload.schemaVersion',
      {
        payload: {
          sessionId: 'pair:pair-link-envelope:navigator',
          fromSessionSeq: 1,
          throughSessionSeq: 1,
          messageIds: ['linked-message'],
          pairEventId: 'pair-link-envelope:2',
          representation: 'full',
        },
      },
    ],
    [
      'wrong payload.schemaVersion',
      {
        payload: {
          schemaVersion: 2,
          sessionId: 'pair:pair-link-envelope:navigator',
          fromSessionSeq: 1,
          throughSessionSeq: 1,
          messageIds: ['linked-message'],
          pairEventId: 'pair-link-envelope:2',
          representation: 'full',
        },
      },
    ],
    [
      'payload.sessionId',
      {
        payload: {
          schemaVersion: 1,
          sessionId: 'pair:pair-link-envelope:pilot',
          fromSessionSeq: 1,
          throughSessionSeq: 1,
          messageIds: ['linked-message'],
          pairEventId: 'pair-link-envelope:2',
          representation: 'full',
        },
      },
    ],
  ] as const)(
    'rejects session_event.linked with mismatched %s envelope or payload',
    (_name, overrides) => {
      const pairId = 'pair-link-envelope';
      const sessionId = createPairSessionIds(pairId).navigatorSessionId;
      const message = dshUserMessage('linked-message', 'already represented', {
        kind: 'plugin',
        plugin: 'pair-agent:linked-history',
      });
      const link = persistedLink(pairId, sessionId, message.id, overrides as Partial<PairEvent>);

      expect(() =>
        rebuild(
          pairId,
          [
            pairCreated(pairId),
            sharedUserMessage(pairId, sessionId, message.id, 'already represented'),
            link,
          ],
          requestPayload(sessionId, message),
        ),
      ).toThrow(PairRequestBindingError);
    },
  );

  test.each([
    ['actor', { actor: { kind: 'host' } }],
    ['source', { source: 'pilot-session' }],
    ['authority', { authority: 'pilot' }],
    ['channel', { channel: 'navigator' }],
    ['visibility', { visibility: 'local' }],
    ['sourceEventIds', { refs: {} }],
    [
      'sourceEventId binding',
      {
        refs: {
          sourceEventIds: [
            'dsh:pair:pair-peer-malformed:pilot:turn:1:peer-message',
          ],
        },
      },
    ],
    [
      'payload.kind',
      {
        payload: {
          schemaVersion: 1,
          kind: 'turn-output',
          text: 'bounded peer input',
          content: [{ type: 'text', text: 'bounded peer input' }],
          completion: 'complete',
          causalRootId: 'pair-peer-malformed:root',
          hop: 2,
        },
      },
    ],
    [
      'payload.causalRootId',
      {
        payload: {
          schemaVersion: 1,
          kind: 'peer-message',
          text: 'bounded peer input',
          content: [{ type: 'text', text: 'bounded peer input' }],
          causalRootId: '',
          hop: 2,
        },
      },
    ],
    [
      'payload.hop',
      {
        payload: {
          schemaVersion: 1,
          kind: 'peer-message',
          text: 'bounded peer input',
          content: [{ type: 'text', text: 'bounded peer input' }],
          causalRootId: 'pair-peer-malformed:root',
          hop: 5,
        },
      },
    ],
    [
      'payload.text',
      {
        payload: {
          schemaVersion: 1,
          kind: 'peer-message',
          text: '',
          content: [{ type: 'text', text: '' }],
          causalRootId: 'pair-peer-malformed:root',
          hop: 2,
        },
      },
    ],
    [
      'payload UTF-8 byte bound',
      {
        payload: {
          schemaVersion: 1,
          kind: 'peer-message',
          text: '🙂'.repeat(16_385),
          content: [{ type: 'text', text: '🙂'.repeat(16_385) }],
          causalRootId: 'pair-peer-malformed:root',
          hop: 2,
        },
      },
    ],
    [
      'payload content',
      {
        payload: {
          schemaVersion: 1,
          kind: 'peer-message',
          text: 'bounded peer input',
          content: [{ type: 'text', text: 'different content' }],
          causalRootId: 'pair-peer-malformed:root',
          hop: 2,
        },
      },
    ],
  ] as const)(
    'rejects directed peer delivery with malformed %s',
    (_name, overrides) => {
      const pairId = 'pair-peer-malformed';
      const sessionId = createPairSessionIds(pairId).pilotSessionId;
      const durableId = `${pairId}:2`;
      const delivery = createPairDeliveryMessageInput(
        durableId,
        directedPeerTrigger(pairId),
      );
      const message = {
        id: 'peer-delivery-message',
        role: 'user' as const,
        content: delivery.content,
        source: delivery.source,
      };

      expect(() =>
        rebuild(
          pairId,
          [pairCreated(pairId), directedPeerMessage(pairId, overrides as Partial<PairEvent>)],
          requestPayload(sessionId, message),
        ),
      ).toThrow(PairRequestBindingError);
    },
  );

  test('rejects a self-consistent directed peer delivery over the UTF-8 byte bound', () => {
    const pairId = 'pair-peer-oversized-proof';
    const sessionId = createPairSessionIds(pairId).pilotSessionId;
    const durableId = `${pairId}:2`;
    const text = '🙂'.repeat(16_385);
    const durable = directedPeerMessage(pairId, {
      payload: {
        schemaVersion: 1,
        kind: 'peer-message',
        text,
        content: [{ type: 'text', text }],
        causalRootId: `${pairId}:root`,
        hop: 2,
      },
    });
    const delivery = createPairDeliveryMessageInput(durableId, {
      kind: 'agent.message',
      role: 'pilot',
      text,
      pairEventId: durableId,
      causalRootId: `${pairId}:root`,
      hop: 2,
    });
    const message = {
      id: 'oversized-peer-delivery',
      role: 'user' as const,
      content: delivery.content,
      source: delivery.source,
    };

    expect(() =>
      rebuild(
        pairId,
        [pairCreated(pairId), durable],
        requestPayload(sessionId, message),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test('rejects a self-consistent whitespace-only directed peer delivery', () => {
    const pairId = 'pair-peer-whitespace-proof';
    const sessionId = createPairSessionIds(pairId).pilotSessionId;
    const durableId = `${pairId}:2`;
    const text = '   ';
    const durable = directedPeerMessage(pairId, {
      payload: {
        schemaVersion: 1,
        kind: 'peer-message',
        text,
        content: [{ type: 'text', text }],
        causalRootId: `${pairId}:root`,
        hop: 2,
      },
    });
    const delivery = createPairDeliveryMessageInput(durableId, {
      kind: 'agent.message',
      role: 'pilot',
      text,
      pairEventId: durableId,
      causalRootId: `${pairId}:root`,
      hop: 2,
    });
    const message = {
      id: 'whitespace-peer-delivery',
      role: 'user' as const,
      content: delivery.content,
      source: delivery.source,
    };

    expect(() =>
      rebuild(
        pairId,
        [pairCreated(pairId), durable],
        requestPayload(sessionId, message),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test.each([
    [
      'trigger',
      (delivery: ReturnType<typeof createPairDeliveryMessageInput>) => ({
        content: delivery.content,
        source: {
          ...delivery.source,
          trigger: { ...directedPeerTrigger('pair-peer-proof-tamper'), hop: 3 },
        },
      }),
    ],
    [
      'content',
      (delivery: ReturnType<typeof createPairDeliveryMessageInput>) => ({
        content: [{ type: 'text', text: 'tampered peer delivery' }],
        source: delivery.source,
      }),
    ],
  ] as const)('rejects directed peer delivery with malformed Host %s proof', (_name, mutate) => {
    const pairId = 'pair-peer-proof-tamper';
    const sessionId = createPairSessionIds(pairId).pilotSessionId;
    const durableId = `${pairId}:2`;
    const delivery = createPairDeliveryMessageInput(
      durableId,
      directedPeerTrigger(pairId),
    );
    const changed = mutate(delivery);
    const message = {
      id: 'peer-delivery-message',
      role: 'user' as const,
      content: changed.content,
      source: changed.source,
    };

    expect(() =>
      rebuild(
        pairId,
        [pairCreated(pairId), directedPeerMessage(pairId)],
        requestPayload(sessionId, message as never),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test('uses a verified current Pair delivery as request-local proof and emits only a reference trigger', () => {
    const pairId = 'pair-delivery-proof';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const durableId = `${pairId}:2`;
    const text = 'durable shared input';
    const durable: PairEvent = {
      ...sharedUserMessage(pairId, sessionId, 'not-a-native-message', text),
      source: 'pair',
      authority: 'user',
      payload: {
        schemaVersion: 1,
        kind: 'user-input',
        text,
        content: [{ type: 'text', text }],
      },
    };
    const hostTrigger = {
      kind: 'user.message',
      role: 'navigator',
      text,
      pairEventId: durableId,
    } as const;
    const delivery = createPairDeliveryMessageInput(durableId, hostTrigger);
    const message = {
      id: 'dsh-delivery-message',
      role: 'user' as const,
      content: delivery.content,
      source: delivery.source,
    };

    const result = rebuild(
      pairId,
      [pairCreated(pairId), durable],
      requestPayload(sessionId, message),
    );

    expect(delivery.source.trigger).toEqual(hostTrigger);
    expect(result.messages.some(({ id }) => id === message.id)).toBe(false);
    expect(result.manifest.spans).toEqual([
      expect.objectContaining({
        messageIds: [message.id],
        decision: 'excluded',
        linkedPairEventIds: [durableId],
      }),
    ]);
    const triggerText = result.messages.at(-1)?.content[0]?.text;
    expect(triggerText).toBe(
      `<pair-trigger schema="pair-trigger/v1">\n` +
      `{"deliveryId":"${durableId}","kind":"user.message","pairEventId":"${durableId}"}\n` +
      '</pair-trigger>',
    );
    expect(triggerText).not.toContain(text);
    expect(triggerText).not.toContain('role');
  });

  test('rebuilds accepted delivery IDs only from messages proven against the current Pair ledger and role', () => {
    const pairId = 'pair-recovery-admission';
    const ids = createPairSessionIds(pairId);
    const completion = completionHandoff(pairId);
    const completionId = `${pairId}:2`;
    const valid = deliveryMessage(completionId, completionTrigger(pairId));

    expect(
      rebuildAcceptedPairDeliveryIds(
        [valid],
        [pairCreated(pairId), completion],
        'navigator',
      ),
    ).toEqual(new Set([completionId]));

    expect(() =>
      rebuildAcceptedPairDeliveryIds([valid], [pairCreated(pairId)], 'navigator'),
    ).toThrow(PairRequestBindingError);
    expect(() =>
      rebuildAcceptedPairDeliveryIds(
        [valid],
        [pairCreated(pairId), completion],
        'pilot',
      ),
    ).toThrow(PairRequestBindingError);

    const verboseTrigger = {
      ...completionTrigger(pairId),
      text: 'complete delegated report',
    };
    expect(() =>
      rebuildAcceptedPairDeliveryIds(
        [deliveryMessage(completionId, verboseTrigger)],
        [pairCreated(pairId), completion],
        'navigator',
      ),
    ).toThrow(PairRequestBindingError);

    const otherPairId = 'pair-recovery-admission-other';
    expect(() =>
      rebuildAcceptedPairDeliveryIds(
        [deliveryMessage(`${otherPairId}:2`, completionTrigger(otherPairId))],
        [pairCreated(pairId), completion],
        'navigator',
      ),
    ).toThrow(PairRequestBindingError);

    expect(ids.navigatorSessionId).toContain(pairId);
  });

  test('keeps canonical user, task, and peer deliveries compatible with recovery admission', () => {
    const pairId = 'pair-recovery-compatible';
    const ids = createPairSessionIds(pairId);
    const user = {
      ...sharedUserMessage(pairId, ids.navigatorSessionId, 'user-source', 'user input'),
      source: 'pair' as const,
      authority: 'user' as const,
      payload: {
        schemaVersion: 1,
        kind: 'user-input',
        text: 'user input',
        content: [{ type: 'text', text: 'user input' }],
      },
    };
    const task: PairEvent = {
      pairId: parsePairId(pairId),
      seq: 3,
      type: 'task.assigned',
      actor: { kind: 'agent', role: 'navigator' },
      source: 'navigator-session',
      channel: 'shared-control',
      visibility: 'shared',
      authority: 'navigator',
      refs: {
        sourceEventIds: ['task-source'],
        task: { id: 'task-1', revision: 1 },
      },
      payload: {
        schemaVersion: 1,
        task: { id: 'task-1', revision: 1, summary: 'do work', state: 'queued' },
      },
      occurredAt: '2026-09-03T00:00:03.000Z',
    };
    const peer = { ...directedPeerMessage(pairId), seq: 4 };
    const events = [pairCreated(pairId), user, task, peer];
    const userId = `${pairId}:2`;
    const taskId = `${pairId}:3`;
    const peerId = `${pairId}:4`;

    expect(rebuildAcceptedPairDeliveryIds([
      deliveryMessage(userId, {
        kind: 'user.message', role: 'navigator', text: 'user input', pairEventId: userId,
      }),
    ], events, 'navigator')).toEqual(new Set([userId]));
    expect(rebuildAcceptedPairDeliveryIds([
      deliveryMessage(taskId, {
        kind: 'task.assigned', pairEventId: taskId, task: task.payload.task as JsonObject,
      }),
      deliveryMessage(peerId, { ...directedPeerTrigger(pairId), pairEventId: peerId }),
    ], events, 'pilot')).toEqual(new Set([taskId, peerId]));
  });

  test('rejects a self-consistent task delivery backed by a non-canonical Task Event', () => {
    const pairId = 'pair-delivery-noncanonical-task';
    const sessionId = createPairSessionIds(pairId).pilotSessionId;
    const durableId = `${pairId}:2`;
    const task = {
      id: 'task-1',
      revision: 1,
      summary: 'Perform harmless work',
      state: 'queued',
    } as const;
    const nonCanonical: PairEvent = {
      pairId: parsePairId(pairId),
      seq: 2,
      type: 'task.assigned',
      actor: { kind: 'host' },
      source: 'pair',
      channel: 'shared-control',
      visibility: 'shared',
      authority: 'host',
      refs: {},
      payload: { task },
      occurredAt: '2026-08-31T00:00:02.000Z',
    };
    const delivery = createPairDeliveryMessageInput(durableId, {
      kind: 'task.assigned',
      pairEventId: durableId,
      task,
    });
    const message = {
      id: 'task-delivery-message',
      role: 'user' as const,
      content: delivery.content,
      source: delivery.source,
    };

    expect(() =>
      rebuild(
        pairId,
        [pairCreated(pairId), nonCanonical],
        requestPayload(sessionId, message),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test.each([
    {
      name: 'durable Pair Event ID',
      mutate: (source: Record<string, unknown>) => {
        source.pairEventId = 'pair-delivery-proof:999';
      },
    },
    {
      name: 'deliveryId',
      mutate: (source: Record<string, unknown>) => {
        source.deliveryId = 'pair-delivery-proof:999';
      },
    },
    {
      name: 'normalized payload',
      mutate: (source: Record<string, unknown>) => {
        source.trigger = {
          kind: 'user.message',
          role: 'navigator',
          text: 'forged text',
          pairEventId: 'pair-delivery-proof:2',
        };
      },
    },
  ])('rejects claimed Pair delivery proof with mismatched $name', ({ mutate }) => {
    const pairId = 'pair-delivery-proof';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const durableId = `${pairId}:2`;
    const text = 'durable shared input';
    const durable: PairEvent = {
      ...sharedUserMessage(pairId, sessionId, 'not-native', text),
      source: 'pair',
      authority: 'user',
      payload: {
        schemaVersion: 1,
        kind: 'user-input',
        text,
        content: [{ type: 'text', text }],
      },
    };
    const delivery = createPairDeliveryMessageInput(durableId, {
      kind: 'user.message',
      role: 'navigator',
      text,
      pairEventId: durableId,
    });
    const source = structuredClone(delivery.source) as Record<string, unknown>;
    mutate(source);
    const message = {
      id: 'dsh-delivery-message',
      role: 'user' as const,
      content: delivery.content,
      source: source as JsonObject,
    };

    expect(() =>
      rebuild(
        pairId,
        [pairCreated(pairId), durable],
        requestPayload(sessionId, message),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test('rejects Pair delivery proof targeting the peer role', () => {
    const pairId = 'pair-delivery-peer-role';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const durableId = `${pairId}:2`;
    const text = 'wrong role target';
    const durable: PairEvent = {
      ...sharedUserMessage(pairId, sessionId, 'not-native', text),
      source: 'pair',
      channel: 'pilot',
      authority: 'user',
      payload: {
        schemaVersion: 1,
        kind: 'user-input',
        text,
        content: [{ type: 'text', text }],
      },
    };
    const delivery = createPairDeliveryMessageInput(durableId, {
      kind: 'user.message',
      role: 'pilot',
      text,
      pairEventId: durableId,
    });
    const message = {
      id: 'dsh-delivery-message',
      role: 'user' as const,
      content: delivery.content,
      source: delivery.source,
    };

    expect(() =>
      rebuild(
        pairId,
        [pairCreated(pairId), durable],
        requestPayload(sessionId, message),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test('rejects Pair delivery provenance attached to a non-user DSH message', () => {
    const pairId = 'pair-delivery-message-role';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const durableId = `${pairId}:2`;
    const text = 'durable shared input';
    const durable: PairEvent = {
      ...sharedUserMessage(pairId, sessionId, 'not-native', text),
      source: 'pair',
      authority: 'user',
      payload: {
        schemaVersion: 1,
        kind: 'user-input',
        text,
        content: [{ type: 'text', text }],
      },
    };
    const delivery = createPairDeliveryMessageInput(durableId, {
      kind: 'user.message',
      role: 'navigator',
      text,
      pairEventId: durableId,
    });
    const message = {
      id: 'dsh-delivery-message',
      role: 'assistant' as const,
      content: delivery.content,
      source: delivery.source,
    };

    expect(() =>
      rebuild(
        pairId,
        [pairCreated(pairId), durable],
        requestPayload(sessionId, message as never),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test('rejects Pair delivery with a correct trigger but tampered DSH content', () => {
    const pairId = 'pair-delivery-tampered-content';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const durableId = `${pairId}:2`;
    const text = 'durable shared input';
    const durable: PairEvent = {
      ...sharedUserMessage(pairId, sessionId, 'not-native', text),
      source: 'pair',
      authority: 'user',
      payload: {
        schemaVersion: 1,
        kind: 'user-input',
        text,
        content: [{ type: 'text', text }],
      },
    };
    const delivery = createPairDeliveryMessageInput(durableId, {
      kind: 'user.message',
      role: 'navigator',
      text,
      pairEventId: durableId,
    });
    const message = {
      id: 'dsh-delivery-message',
      role: 'user' as const,
      content: [{ type: 'text', text: 'tampered delivery content' }],
      source: delivery.source,
    };

    expect(() =>
      rebuild(
        pairId,
        [pairCreated(pairId), durable],
        requestPayload(sessionId, message),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test('retains a native-composer message when no durable dedup proof exists', () => {
    const pairId = 'pair-native-window-none';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const message = dshUserMessage('native-current', 'local only', { kind: 'user' });

    const result = rebuild(
      pairId,
      [pairCreated(pairId)],
      requestPayload(sessionId, message),
    );

    expect(result.messages.some(({ id }) => id === message.id)).toBe(true);
    expect(result.manifest.spans).toEqual([
      expect.objectContaining({
        messageIds: [message.id],
        decision: 'retained',
        reason: 'unlinked',
        linkedPairEventIds: [],
      }),
    ]);
  });

  test.each([
    { name: 'before its persisted link', withLink: false },
    { name: 'after its persisted link', withLink: true },
  ])('deduplicates a native-composer message $name', ({ withLink }) => {
    const pairId = `pair-native-window-${withLink ? 'linked' : 'event'}`;
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const message = dshUserMessage('native-current', 'shared once', { kind: 'user' });
    const sourceEventId = `dsh:${sessionId}:1:user.message`;
    const represented = sharedUserMessage(
      pairId,
      sessionId,
      message.id,
      'shared once',
      { sourceEventIds: [sourceEventId] },
    );
    const events = [
      pairCreated(pairId),
      represented,
      ...(withLink ? [persistedLink(pairId, sessionId, message.id)] : []),
    ];

    const result = rebuild(pairId, events, requestPayload(sessionId, message));

    expect(result.messages.some(({ id }) => id === message.id)).toBe(false);
    expect(result.manifest.spans).toEqual([
      expect.objectContaining({
        messageIds: [message.id],
        decision: 'excluded',
        linkedPairEventIds: [`${pairId}:2`],
      }),
    ]);
    expect(
      result.messages.filter((item) =>
        JSON.stringify(item.content).includes('shared once'),
      ),
    ).toHaveLength(1);
  });

  test('rejects a claimed native-composer proof whose origin or normalized payload differs', () => {
    const pairId = 'pair-native-invalid';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const message = dshUserMessage('native-current', 'actual local payload', {
      kind: 'user',
    });
    const sourceEventId = `dsh:${sessionId}:1:user.message`;
    const forged = sharedUserMessage(
      pairId,
      sessionId,
      message.id,
      'different durable payload',
      { sourceEventIds: [sourceEventId] },
    );

    expect(() =>
      rebuild(
        pairId,
        [pairCreated(pairId), forged],
        requestPayload(sessionId, message),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test('rebuilds full persisted links from all Pair Events for the active Session only', () => {
    const pairId = 'pair-persistent-active-only';
    const ids = createPairSessionIds(pairId);
    const message = dshUserMessage('active-local', 'active local', {
      kind: 'plugin',
      plugin: 'bootstrap',
    });
    const peerLink = persistedLink(pairId, ids.pilotSessionId, message.id);

    const peerOnly = rebuild(
      pairId,
      [
        pairCreated(pairId),
        sharedUserMessage(pairId, ids.pilotSessionId, 'peer-message', 'peer history'),
        peerLink,
      ],
      requestPayload(ids.navigatorSessionId, message),
    );
    const activeLink = {
      ...peerLink,
      source: 'navigator-session' as const,
      channel: 'navigator' as const,
      payload: {
        ...(peerLink.payload as JsonObject),
        sessionId: ids.navigatorSessionId,
      },
    };
    const active = rebuild(
      pairId,
      [
        pairCreated(pairId),
        sharedUserMessage(pairId, ids.navigatorSessionId, 'represented', 'shared'),
        activeLink,
      ],
      requestPayload(ids.navigatorSessionId, message),
    );

    expect(peerOnly.messages.some(({ id }) => id === message.id)).toBe(true);
    expect(JSON.stringify(peerOnly.messages)).toContain('peer history');
    expect(active.messages.some(({ id }) => id === message.id)).toBe(false);
  });

  test.each([
    {
      name: 'missing represented Pair Event',
      mutate: (link: PairEvent) => ({
        ...link,
        payload: { ...(link.payload as JsonObject), pairEventId: 'pair-link-invalid:999' },
      }),
    },
    {
      name: 'non-canonical represented Pair Event ID',
      mutate: (link: PairEvent) => ({
        ...link,
        payload: { ...(link.payload as JsonObject), pairEventId: 'other-pair:2' },
      }),
    },
    {
      name: 'invalid Session range',
      mutate: (link: PairEvent) => ({
        ...link,
        payload: { ...(link.payload as JsonObject), fromSessionSeq: 2, throughSessionSeq: 1 },
      }),
    },
    {
      name: 'invalid message IDs',
      mutate: (link: PairEvent) => ({
        ...link,
        payload: { ...(link.payload as JsonObject), messageIds: [] },
      }),
    },
  ])('fails closed on an active persisted link with $name', ({ mutate }) => {
    const pairId = 'pair-link-invalid';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const message = dshUserMessage('local-message', 'local', {
      kind: 'plugin',
      plugin: 'bootstrap',
    });
    const link = mutate(persistedLink(pairId, sessionId, message.id));

    expect(() =>
      rebuild(
        pairId,
        [
          pairCreated(pairId),
          sharedUserMessage(pairId, sessionId, 'represented', 'shared'),
          link,
        ],
        requestPayload(sessionId, message),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test('rejects a persisted link represented by pair.created', () => {
    const pairId = 'pair-link-wrong-pair-created';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const message = dshUserMessage('local-message', 'must remain local', {
      kind: 'plugin',
      plugin: 'bootstrap',
    });
    const created = pairCreated(pairId);
    const base = persistedLink(pairId, sessionId, message.id);
    const link = {
      ...base,
      seq: 2,
      payload: {
        ...(base.payload as JsonObject),
        pairEventId: `${pairId}:${created.seq}`,
      },
    };

    expect(() =>
      rebuild(
        pairId,
        [created, link],
        requestPayload(sessionId, message),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test('accepts a canonical task delivery full-link as persisted dedup proof', () => {
    const pairId = 'pair-link-task-delivery';
    const sessionId = createPairSessionIds(pairId).pilotSessionId;
    const durableId = `${pairId}:2`;
    const task = {
      id: 'task-1',
      revision: 1,
      summary: 'Perform harmless work',
      state: 'queued',
    } as const;
    const assigned: PairEvent = {
      pairId: parsePairId(pairId),
      seq: 2,
      type: 'task.assigned',
      actor: { kind: 'agent', role: 'navigator' },
      source: 'navigator-session',
      channel: 'shared-control',
      visibility: 'shared',
      authority: 'navigator',
      refs: { task: { id: task.id, revision: task.revision } },
      payload: { task },
      occurredAt: '2026-08-31T00:00:02.000Z',
    };
    const delivery = createPairDeliveryMessageInput(durableId, {
      kind: 'task.assigned',
      pairEventId: durableId,
      task,
    });
    const message = {
      id: 'task-delivery-message',
      role: 'user' as const,
      content: delivery.content,
      source: delivery.source,
    };
    const link = persistedLink(pairId, sessionId, message.id);

    const result = rebuild(
      pairId,
      [pairCreated(pairId), assigned, link],
      requestPayload(sessionId, message),
    );

    expect(result.messages.some(({ id }) => id === message.id)).toBe(false);
    expect(result.manifest.spans).toEqual([
      expect.objectContaining({
        messageIds: [message.id],
        decision: 'excluded',
        linkedPairEventIds: [durableId],
      }),
    ]);
  });

  test('allows Pilot to rebuild after its Navigator-directed completion handoff', () => {
    const pairId = 'pair-link-pilot-after-completion';
    const sessionId = createPairSessionIds(pairId).pilotSessionId;
    const message = dshUserMessage('next-pilot-input', 'start the next task', {
      kind: 'user',
    });
    const base = persistedLink(
      pairId,
      sessionId,
      'completion-message-42',
    );
    const completion = completionHandoff(pairId);
    const completionLink = {
      ...base,
      payload: {
        ...(base.payload as JsonObject),
        fromSessionSeq: 42,
        throughSessionSeq: 44,
        representation: 'summary',
        representedContentDigest: createRepresentedContentDigest(
          completion.payload.content as readonly JsonObject[],
        ),
      },
    };

    const result = rebuild(
      pairId,
      [pairCreated(pairId), completion, completionLink],
      requestPayload(sessionId, message),
    );

    expect(result.messages.some(({ id }) => id === message.id)).toBe(true);
    expect(result.manifest.spans).toEqual([
      expect.objectContaining({
        messageIds: [message.id],
        decision: 'retained',
        reason: 'unlinked',
      }),
    ]);
  });

  test('rejects a persisted link represented by an ordinary cross-channel agent.message', () => {
    const pairId = 'pair-link-cross-channel-agent';
    const ids = createPairSessionIds(pairId);
    const message = dshUserMessage('local-message', 'must remain local', {
      kind: 'plugin',
      plugin: 'bootstrap',
    });
    const represented: PairEvent = {
      ...sharedUserMessage(pairId, ids.pilotSessionId, 'agent-message', 'peer'),
      type: 'agent.message',
      actor: { kind: 'agent', role: 'pilot' },
      source: 'pilot-session',
      channel: 'navigator',
      authority: 'pilot',
      payload: {
        schemaVersion: 1,
        kind: 'turn-output',
        text: 'peer',
        content: [{ type: 'text', text: 'peer' }],
        completion: 'complete',
      },
    };
    const link = persistedLink(pairId, ids.navigatorSessionId, message.id);

    expect(() =>
      rebuild(
        pairId,
        [pairCreated(pairId), represented, link],
        requestPayload(ids.navigatorSessionId, message),
      ),
    ).toThrow(PairRequestBindingError);
  });

  test.each(['summary', 'artifact-ref'] as const)(
    'retains local history for a persisted %s representation',
    (representation) => {
      const pairId = `pair-link-${representation.replace('-', '')}`;
      const sessionId = createPairSessionIds(pairId).navigatorSessionId;
      const message = dshUserMessage('local-message', 'must remain local', {
        kind: 'plugin',
        plugin: 'bootstrap',
      });
      const base = persistedLink(pairId, sessionId, message.id);
      const represented = sharedUserMessage(
        pairId,
        sessionId,
        message.id,
        'summary only',
      );
      const nonFull = {
        ...base,
        payload: {
          ...(base.payload as JsonObject),
          representation,
          ...(representation === 'summary'
            ? {
                representedContentDigest: createRepresentedContentDigest(
                  represented.payload.content as readonly JsonObject[],
                ),
              }
            : {}),
        },
      };

      const result = rebuild(
        pairId,
        [
          pairCreated(pairId),
          represented,
          nonFull,
        ],
        requestPayload(sessionId, message),
      );

      expect(result.messages.some(({ id }) => id === message.id)).toBe(true);
      expect(result.manifest.spans).toEqual([
        expect.objectContaining({
          decision: 'retained',
          reason: `${representation}-representation`,
          linkedPairEventIds: [`${pairId}:2`],
        }),
      ]);
    },
  );

  test.each(['artifact-ref'] as const)(
    'still request-locally deduplicates a current Pair delivery with a persisted %s link',
    (representation) => {
      const pairId = `pair-delivery-${representation.replace('-', '')}`;
      const sessionId = createPairSessionIds(pairId).navigatorSessionId;
      const durableId = `${pairId}:2`;
      const text = 'shared delivery once';
      const durable: PairEvent = {
        ...sharedUserMessage(pairId, sessionId, 'not-native', text),
        source: 'pair',
        authority: 'user',
        payload: {
          schemaVersion: 1,
          kind: 'user-input',
          text,
          content: [{ type: 'text', text }],
        },
      };
      const delivery = createPairDeliveryMessageInput(durableId, {
        kind: 'user.message',
        role: 'navigator',
        text,
        pairEventId: durableId,
      });
      const message = {
        id: 'delivery-current',
        role: 'user' as const,
        content: delivery.content,
        source: delivery.source,
      };
      const base = persistedLink(pairId, sessionId, message.id);
      const nonFull = {
        ...base,
        payload: { ...(base.payload as JsonObject), representation },
      };

      const result = rebuild(
        pairId,
        [pairCreated(pairId), durable, nonFull],
        requestPayload(sessionId, message),
      );

      expect(result.messages.some(({ id }) => id === message.id)).toBe(false);
      expect(result.manifest.spans).toEqual([
        expect.objectContaining({
          decision: 'excluded',
          reason: 'fully-represented-in-pair',
          linkedPairEventIds: [durableId],
        }),
      ]);
    },
  );

  test.each(['artifact-ref'] as const)(
    'still request-locally deduplicates current native composer input with a persisted %s link',
    (representation) => {
      const pairId = `pair-native-${representation.replace('-', '')}`;
      const sessionId = createPairSessionIds(pairId).navigatorSessionId;
      const message = dshUserMessage('native-current', 'shared native once', {
        kind: 'user',
      });
      const sourceEventId = `dsh:${sessionId}:1:user.message`;
      const represented = sharedUserMessage(
        pairId,
        sessionId,
        message.id,
        'shared native once',
        { sourceEventIds: [sourceEventId] },
      );
      const base = persistedLink(pairId, sessionId, message.id);
      const nonFull = {
        ...base,
        payload: { ...(base.payload as JsonObject), representation },
      };

      const result = rebuild(
        pairId,
        [pairCreated(pairId), represented, nonFull],
        requestPayload(sessionId, message),
      );

      expect(result.messages.some(({ id }) => id === message.id)).toBe(false);
      expect(result.manifest.spans).toEqual([
        expect.objectContaining({
          decision: 'excluded',
          reason: 'fully-represented-in-pair',
          linkedPairEventIds: [`${pairId}:2`],
        }),
      ]);
    },
  );

  test('uses request-local delivery proof when a full persisted link does not exactly match the boundary', () => {
    const pairId = 'pair-delivery-inexact-full';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const durableId = `${pairId}:2`;
    const text = 'inexact delivery once';
    const durable: PairEvent = {
      ...sharedUserMessage(pairId, sessionId, 'not-native', text),
      source: 'pair',
      authority: 'user',
      payload: {
        schemaVersion: 1,
        kind: 'user-input',
        text,
        content: [{ type: 'text', text }],
      },
    };
    const delivery = createPairDeliveryMessageInput(durableId, {
      kind: 'user.message',
      role: 'navigator',
      text,
      pairEventId: durableId,
    });
    const message = {
      id: 'delivery-current',
      role: 'user' as const,
      content: delivery.content,
      source: delivery.source,
    };
    const base = persistedLink(pairId, sessionId, message.id);
    const inexact = {
      ...base,
      payload: { ...(base.payload as JsonObject), throughSessionSeq: 2 },
    };

    const result = rebuild(
      pairId,
      [pairCreated(pairId), durable, inexact],
      requestPayload(sessionId, message),
    );

    expect(result.messages.some(({ id }) => id === message.id)).toBe(false);
    expect(result.manifest).toMatchObject({
      spans: [
        expect.objectContaining({
          decision: 'excluded',
          linkedPairEventIds: [durableId],
        }),
      ],
    });
  });

  test('uses request-local native proof when a full persisted link does not exactly match the boundary', () => {
    const pairId = 'pair-native-inexact-full';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const message = dshUserMessage('native-current', 'inexact native once', {
      kind: 'user',
    });
    const sourceEventId = `dsh:${sessionId}:1:user.message`;
    const represented = sharedUserMessage(
      pairId,
      sessionId,
      message.id,
      'inexact native once',
      { sourceEventIds: [sourceEventId] },
    );
    const base = persistedLink(pairId, sessionId, message.id);
    const inexact = {
      ...base,
      payload: { ...(base.payload as JsonObject), throughSessionSeq: 2 },
    };

    const result = rebuild(
      pairId,
      [pairCreated(pairId), represented, inexact],
      requestPayload(sessionId, message),
    );

    expect(result.messages.some(({ id }) => id === message.id)).toBe(false);
    expect(result.manifest).toMatchObject({
      spans: [
        expect.objectContaining({
          decision: 'excluded',
          linkedPairEventIds: [`${pairId}:2`],
        }),
      ],
    });
  });

  test('does not accept an exact delivery span linked to a different Pair Event as its proof', () => {
    const pairId = 'pair-delivery-wrong-event';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const durableId = `${pairId}:2`;
    const text = 'correct delivery event';
    const durable: PairEvent = {
      ...sharedUserMessage(pairId, sessionId, 'not-native', text),
      source: 'pair',
      authority: 'user',
      payload: {
        schemaVersion: 1,
        kind: 'user-input',
        text,
        content: [{ type: 'text', text }],
      },
    };
    const unrelated: PairEvent = {
      ...sharedUserMessage(pairId, sessionId, 'unrelated', 'other event'),
      seq: 3,
      occurredAt: '2026-08-31T00:00:03.000Z',
    };
    const delivery = createPairDeliveryMessageInput(durableId, {
      kind: 'user.message',
      role: 'navigator',
      text,
      pairEventId: durableId,
    });
    const message = {
      id: 'delivery-current',
      role: 'user' as const,
      content: delivery.content,
      source: delivery.source,
    };
    const base = persistedLink(pairId, sessionId, message.id);
    const wrongLink = {
      ...base,
      seq: 4,
      occurredAt: '2026-08-31T00:00:04.000Z',
      payload: { ...(base.payload as JsonObject), pairEventId: `${pairId}:3` },
    };

    const result = rebuild(
      pairId,
      [pairCreated(pairId), durable, unrelated, wrongLink],
      requestPayload(sessionId, message),
    );

    expect(result.messages.some(({ id }) => id === message.id)).toBe(false);
    expect(result.manifest).toMatchObject({
      spans: [
        expect.objectContaining({
          decision: 'excluded',
          linkedPairEventIds: expect.arrayContaining([durableId]),
        }),
      ],
    });
  });

  test('does not accept an exact native span linked to a different Pair Event as its proof', () => {
    const pairId = 'pair-native-wrong-event';
    const sessionId = createPairSessionIds(pairId).navigatorSessionId;
    const message = dshUserMessage('native-current', 'correct native event', {
      kind: 'user',
    });
    const sourceEventId = `dsh:${sessionId}:1:user.message`;
    const represented = sharedUserMessage(
      pairId,
      sessionId,
      message.id,
      'correct native event',
      { sourceEventIds: [sourceEventId] },
    );
    const unrelated: PairEvent = {
      ...sharedUserMessage(pairId, sessionId, 'unrelated', 'other event'),
      seq: 3,
      occurredAt: '2026-08-31T00:00:03.000Z',
    };
    const base = persistedLink(pairId, sessionId, message.id);
    const wrongLink = {
      ...base,
      seq: 4,
      occurredAt: '2026-08-31T00:00:04.000Z',
      payload: { ...(base.payload as JsonObject), pairEventId: `${pairId}:3` },
    };

    const result = rebuild(
      pairId,
      [pairCreated(pairId), represented, unrelated, wrongLink],
      requestPayload(sessionId, message),
    );

    expect(result.messages.some(({ id }) => id === message.id)).toBe(false);
    expect(result.manifest).toMatchObject({
      spans: [
        expect.objectContaining({
          decision: 'excluded',
          linkedPairEventIds: expect.arrayContaining([`${pairId}:2`]),
        }),
      ],
    });
  });
});
