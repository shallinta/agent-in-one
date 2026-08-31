import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPairSessionIds } from '@pair-agent/contracts';
import { JsonlPairLedgerStore } from '@pair-agent/ledger';
import { vi, describe, expect, test } from 'vitest';

import { PairRequestPlugin } from '../src/pair-request-plugin.js';
import { ImmutablePairRequestMaterialRegistry } from '../src/request-material-registry.js';

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
