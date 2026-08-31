import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type DshBuildRef,
  type JsonObject,
  type PairEvent,
  type PairEventDraft,
  type PairId,
  parsePairId,
} from '@pair-agent/contracts';
import { JsonlPairLedgerStore } from '@pair-agent/ledger';
import { afterEach, describe, expect, test } from 'vitest';

import {
  DerivedEventConflictError,
  type DerivedEventSpec,
  PairDerivedEventWriter,
} from '../src/pair-derived-event-writer.js';
import {
  type AgentAdapter,
  type AgentHandle,
  PairRegistry,
  type PreparePairAgentInput,
  type PreparedPairAgent,
} from '../src/pair-registry.js';

const roots: string[] = [];
const registries: PairRegistry[] = [];

const dshBuild: DshBuildRef = {
  upstreamRepository: 'openai/deepseek-harness',
  upstreamCommit: 'a'.repeat(40),
  sourceRepository: 'example/pair-agent',
  sourceCommit: 'b'.repeat(40),
  requestLayoutSeamVersion: 1,
};

class FakeAdapter implements AgentAdapter {
  getDshRuntimeAttestation() {
    return {
      dshBuild,
      runtimeArtifacts: {
        schemaVersion: 1 as const,
        buildProfile: 'official' as const,
        roots: ['apps', 'native', 'packages', 'vendor'] as const,
        fileCount: 1,
        digest: `sha256:${'c'.repeat(64)}`,
      },
    };
  }

  async preparePairAgent(
    input: PreparePairAgentInput,
  ): Promise<PreparedPairAgent> {
    return {
      handle: { sessionId: input.sessionId },
      descriptor: {
        role: input.role,
        source: `${input.role}-session`,
        sessionId: input.sessionId,
      },
    };
  }

  resumePairAgent(input: PreparePairAgentInput): Promise<PreparedPairAgent> {
    return this.preparePairAgent(input);
  }

  async release(_handle: AgentHandle): Promise<void> {}
  async followup(): Promise<void> {}
  async close(): Promise<void> {}
}

class ConflictOnceStore extends JsonlPairLedgerStore {
  #injectConflict = true;

  override async append<TPayload extends JsonObject>(
    pairIdInput: string,
    draft: PairEventDraft<TPayload>,
    expectedLedgerHead: number,
  ): Promise<PairEvent<TPayload>> {
    if (this.#injectConflict && draft.type === 'agent.message') {
      this.#injectConflict = false;
      await super.append(
        pairIdInput,
        {
          type: 'pair.request_built',
          actor: { kind: 'host' },
          source: 'pair',
          channel: 'shared-control',
          visibility: 'infrastructure',
          authority: 'host',
          refs: {},
          payload: { injectedConflict: true },
        },
        expectedLedgerHead,
      );
    }
    return super.append(pairIdInput, draft, expectedLedgerHead);
  }
}

afterEach(async () => {
  await Promise.allSettled(registries.splice(0).map((registry) => registry.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function createHarness(Store = JsonlPairLedgerStore): Promise<{
  pairId: PairId;
  store: JsonlPairLedgerStore;
  registry: PairRegistry;
  writer: PairDerivedEventWriter;
}> {
  const root = await mkdtemp(join(tmpdir(), 'pair-derived-writer-'));
  roots.push(root);
  const store = new Store(root);
  const registry = new PairRegistry(store, new FakeAdapter());
  registries.push(registry);
  const pairId = parsePairId('pair-derived');
  await registry.createPair({ pairId, dshBuild, expectedLedgerHead: 0 });
  return {
    pairId,
    store,
    registry,
    writer: new PairDerivedEventWriter(registry),
  };
}

const messageSourceId =
  'dsh:pair:pair-derived:navigator:6:agent.message';
const linkSourceId =
  'dsh:pair:pair-derived:navigator:6:session_event.linked';

function messageSpec(text = 'durable answer'): DerivedEventSpec {
  return {
    sourceId: messageSourceId,
    draft: {
      type: 'agent.message',
      actor: { kind: 'agent', role: 'navigator' },
      source: 'navigator-session',
      channel: 'navigator',
      visibility: 'shared',
      authority: 'navigator',
      refs: {},
      payload: {
        schemaVersion: 1,
        kind: 'turn-output',
        text,
        content: [{ type: 'text', text }],
        completion: 'complete',
        origin: {
          schemaVersion: 1,
          sessionId: 'pair:pair-derived:navigator',
          sessionEventSeq: 6,
          turn: 1,
          messageId: 'message-6',
        },
      },
    },
  };
}

function linkSpec(): DerivedEventSpec {
  return {
    sourceId: linkSourceId,
    representedSourceId: messageSourceId,
    draft: {
      type: 'session_event.linked',
      actor: { kind: 'host' },
      source: 'navigator-session',
      channel: 'navigator',
      visibility: 'infrastructure',
      authority: 'host',
      refs: {},
      payload: {
        schemaVersion: 1,
        sessionId: 'pair:pair-derived:navigator',
        fromSessionSeq: 6,
        throughSessionSeq: 7,
        messageIds: ['message-6'],
        pairEventId: 'resolved-by-writer',
        representation: 'full',
      },
    },
  };
}

describe('PairDerivedEventWriter', () => {
  test('appends a missing message before its link and resolves the Pair event ID', async () => {
    const { pairId, store, writer } = await createHarness();

    const result = await writer.appendGroup(pairId, [messageSpec(), linkSpec()]);

    expect(result.map(({ seq, type }) => [seq, type])).toEqual([
      [3, 'agent.message'],
      [4, 'session_event.linked'],
    ]);
    expect(result[1]?.payload).toMatchObject({ pairEventId: `${pairId}:3` });
    expect((await store.read(pairId)).map((event) => event.type)).toEqual([
      'pair.created',
      'pair.agent_ready',
      'agent.message',
      'session_event.linked',
    ]);
  });

  test('links a Pair delivery directly to an existing Pair message ID', async () => {
    const { pairId, store, writer } = await createHarness();
    const represented = await store.append(
      pairId,
      {
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
          text: 'delivered input',
          content: [{ type: 'text', text: 'delivered input' }],
          deliveryId: `${pairId}:3`,
        },
      },
      2,
    );
    const deliveryLink: DerivedEventSpec = {
      sourceId: 'dsh:pair:pair-derived:navigator:8:session_event.linked',
      representedPairEventId: `${pairId}:${represented.seq}`,
      draft: {
        type: 'session_event.linked',
        actor: { kind: 'host' },
        source: 'navigator-session',
        channel: 'navigator',
        visibility: 'infrastructure',
        authority: 'host',
        refs: {},
        payload: {
          schemaVersion: 1,
          sessionId: 'pair:pair-derived:navigator',
          fromSessionSeq: 8,
          throughSessionSeq: 8,
          messageIds: ['delivery-message'],
          pairEventId: 'resolved-by-writer',
          representation: 'full',
        },
      },
    };

    const [link] = await writer.appendGroup(pairId, [deliveryLink]);

    expect(link?.payload).toMatchObject({ pairEventId: `${pairId}:3` });
    expect(await store.read(pairId)).toHaveLength(4);
  });

  test('rejects a direct Pair event link when its target is absent', async () => {
    const { pairId, writer } = await createHarness();

    await expect(
      writer.appendGroup(pairId, [
        {
          ...linkSpec(),
          representedSourceId: undefined,
          representedPairEventId: `${pairId}:999`,
        },
      ]),
    ).rejects.toBeInstanceOf(DerivedEventConflictError);
  });

  test('repairs a message-only half write by appending only the link', async () => {
    const { pairId, store, writer } = await createHarness();
    const [message] = await writer.appendGroup(pairId, [messageSpec()]);

    const result = await writer.appendGroup(pairId, [messageSpec(), linkSpec()]);

    expect(result[0]).toEqual(message);
    expect(result[1]).toMatchObject({ seq: 4, type: 'session_event.linked' });
    expect(await store.read(pairId)).toHaveLength(4);
  });

  test('treats a complete canonical group as an idempotent no-op', async () => {
    const { pairId, store, writer } = await createHarness();
    const first = await writer.appendGroup(pairId, [messageSpec(), linkSpec()]);

    const second = await writer.appendGroup(pairId, [messageSpec(), linkSpec()]);

    expect(second).toEqual(first);
    expect(await store.read(pairId)).toHaveLength(4);
  });

  test('fails closed on an orphan link without its represented message', async () => {
    const { pairId, store, writer } = await createHarness();
    const orphan = linkSpec();
    await store.append(
      pairId,
      {
        ...orphan.draft,
        refs: { sourceEventIds: [orphan.sourceId] },
      },
      2,
    );

    await expect(
      writer.appendGroup(pairId, [messageSpec(), linkSpec()]),
    ).rejects.toBeInstanceOf(DerivedEventConflictError);
    expect(await store.read(pairId)).toHaveLength(3);
  });

  test('fails closed when one source ID maps to different canonical content', async () => {
    const { pairId, store, writer } = await createHarness();
    await writer.appendGroup(pairId, [messageSpec()]);

    await expect(
      writer.appendGroup(pairId, [messageSpec('different answer')]),
    ).rejects.toBeInstanceOf(DerivedEventConflictError);
    expect(await store.read(pairId)).toHaveLength(3);
  });

  test('rejects a draft that tries to claim an existing foreign source ID', async () => {
    const { pairId, store, writer } = await createHarness();
    await writer.appendGroup(pairId, [messageSpec()]);
    const foreign = messageSpec('second answer');

    await expect(
      writer.appendGroup(pairId, [
        {
          ...foreign,
          sourceId: `${messageSourceId}:second`,
          draft: {
            ...foreign.draft,
            refs: { sourceEventIds: [messageSourceId] },
          },
        },
      ]),
    ).rejects.toBeInstanceOf(DerivedEventConflictError);
    expect(await store.read(pairId)).toHaveLength(3);
  });

  test('rejects duplicate persisted source IDs even when records are equivalent', async () => {
    const { pairId, store, writer } = await createHarness();
    const [message] = await writer.appendGroup(pairId, [messageSpec()]);
    await store.append(
      pairId,
      {
        type: message!.type,
        actor: message!.actor,
        source: message!.source,
        channel: message!.channel,
        visibility: message!.visibility,
        authority: message!.authority,
        refs: message!.refs,
        payload: message!.payload as JsonObject,
      },
      message!.seq,
    );

    await expect(
      writer.appendGroup(pairId, [messageSpec()]),
    ).rejects.toBeInstanceOf(DerivedEventConflictError);
  });

  test('replays after an external CAS conflict without duplicating derived events', async () => {
    const { pairId, store, writer, registry } = await createHarness(
      ConflictOnceStore,
    );
    const observedHeads: number[] = [];
    const unsubscribe = registry.subscribe(pairId, (projection) => {
      observedHeads.push(projection.header.ledgerHead);
    });

    const result = await writer.appendGroup(pairId, [messageSpec(), linkSpec()]);
    unsubscribe();

    expect(result.map((event) => event.seq)).toEqual([4, 5]);
    const events = await store.read(pairId);
    expect(
      events.filter((event) => event.type === 'agent.message'),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'session_event.linked'),
    ).toHaveLength(1);
    expect(observedHeads.at(-1)).toBe(5);
  });

  test('publishes a durable half write when a later non-CAS validation fails', async () => {
    const { pairId, store, writer, registry } = await createHarness();
    const heads: number[] = [];
    const unsubscribe = registry.subscribe(pairId, (projection) => {
      heads.push(projection.header.ledgerHead);
    });
    const invalidLink = linkSpec();

    await expect(
      writer.appendGroup(pairId, [
        messageSpec(),
        {
          ...invalidLink,
          draft: {
            ...invalidLink.draft,
            payload: {
              ...invalidLink.draft.payload,
              fromSessionSeq: 7,
              throughSessionSeq: 6,
            },
          },
        },
      ]),
    ).rejects.toThrow(/throughSessionSeq/);
    unsubscribe();

    expect(await store.read(pairId)).toHaveLength(3);
    expect(heads.at(-1)).toBe(3);
    expect(
      await registry.readSnapshot(pairId, ({ projection }) =>
        projection.header.ledgerHead,
      ),
    ).toBe(3);
  });

  test('returns snapshot-consistent events and projection through Registry reads', async () => {
    const { pairId, writer, registry } = await createHarness();
    await writer.appendGroup(pairId, [messageSpec(), linkSpec()]);

    const events = await registry.readEvents(pairId);
    const snapshot = await registry.readSnapshot(pairId, (value) => value);

    expect(events).toHaveLength(4);
    expect(snapshot.events).toEqual(events);
    expect(snapshot.projection.header.ledgerHead).toBe(4);
  });

  test('rejects an async snapshot selector before it can reenter the Pair queue', async () => {
    const { pairId, registry } = await createHarness();

    await expect(
      registry.readSnapshot(pairId, () => Promise.resolve('not synchronous')),
    ).rejects.toThrow(/synchronous|Promise|thenable/);
  });
});
