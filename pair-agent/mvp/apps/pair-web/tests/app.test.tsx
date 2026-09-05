import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  parsePairId,
  type GetPairResponse,
  type PairProjection,
} from '@pair-agent/contracts';

import { App, type PairEventSource } from '../src/app.js';
import {
  LedgerConflictError,
  sendPairMessage,
  validateListPairSessionEventsResponse,
} from '../src/pair-client.js';

const baseProjection: PairProjection = {
  header: {
    pairId: parsePairId('pair-web'),
    schemaVersion: 1,
    pairProtocol: 'pair-agent/p0.5',
    navigatorSessionId: 'pair:pair-web:navigator',
    pilotSessionId: 'pair:pair-web:pilot',
    ledgerHead: 2,
    sharedHead: 2,
  },
  attention: { requested: false },
  pause: { paused: false, changedAtSeq: 2 },
};

const runtimeCapabilities = {
  schemaVersion: 1,
  stage: 'P0.5',
  sharedConversation: true,
  peerMessaging: true,
  completionHandoff: true,
  requestAudit: true,
  pilotWebSearch: true,
  goalControl: false,
  taskControl: false,
  executionPlanControl: false,
  attentionControl: false,
  pauseControl: false,
  subagents: false,
} as const;

function responseFor(
  projection: PairProjection = baseProjection,
  panes: GetPairResponse['panes'] = [
    {
      role: 'navigator',
      source: 'navigator-session',
      sessionId: projection.header.navigatorSessionId,
    },
    {
      role: 'pilot',
      source: 'pilot-session',
      sessionId: projection.header.pilotSessionId,
    },
  ],
): GetPairResponse {
  return { projection, panes, capabilities: runtimeCapabilities } as GetPairResponse;
}

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

class FakeEventSource implements PairEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readonly close = vi.fn();

  emit(projection: unknown): void {
    this.onmessage?.({ data: JSON.stringify(projection) } as MessageEvent<string>);
  }

  fail(): void {
    this.onerror?.(new Event('error'));
  }

  reconnect(): void {
    this.onopen?.(new Event('open'));
  }
}

function renderApp(options: {
  search?: string;
  fetcher?: typeof fetch;
  eventSource?: FakeEventSource;
  dshWebOrigin?: string;
  shellOrigin?: string;
} = {}) {
  const eventSource = options.eventSource ?? new FakeEventSource();
  const eventSourceFactory = vi.fn(() => eventSource);
  const fetcher =
    options.fetcher ?? vi.fn(async () => okJson(responseFor()));
  const view = render(
    <App
      config={{
        apiBase: 'https://pair.example',
        dshWebOrigin: options.dshWebOrigin ?? 'https://dsh.example',
        shellOrigin: options.shellOrigin ?? window.location.origin,
      }}
      locationSearch={options.search ?? '?pairId=pair-web'}
      fetcher={fetcher}
      eventSourceFactory={eventSourceFactory}
    />,
  );
  return { ...view, eventSource, eventSourceFactory, fetcher };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Pair Web App', () => {
  test('rejects a missing or invalid pairId through the contracts parser', () => {
    const fetcher = vi.fn();
    const missing = renderApp({ search: '', fetcher });
    expect(screen.getByRole('alert')).toHaveTextContent(/pairid/i);
    expect(fetcher).not.toHaveBeenCalled();
    missing.unmount();

    renderApp({ search: '?pairId=bad%20pair', fetcher });
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid PairId');
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('shows loading and then renders header plus two distinct native DSH panes', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetcher = vi.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    renderApp({ fetcher });
    expect(screen.getByText('Loading Pair projection…')).toBeInTheDocument();

    resolveFetch(okJson(responseFor()));

    const navigator = await screen.findByTitle('Navigator DSH session');
    const pilot = screen.getByTitle('Pilot DSH session');
    expect(navigator).toHaveAttribute('src');
    expect(pilot).toHaveAttribute('src');
    expect(navigator.getAttribute('src')).not.toBe(pilot.getAttribute('src'));
    expect(screen.getByText('pair-web')).toBeInTheDocument();
    expect(screen.getByText('P0.5')).toBeInTheDocument();
    expect(screen.getByText('Shared context')).toBeInTheDocument();
    expect(screen.getByText('Peer messaging')).toBeInTheDocument();
    expect(screen.getByText('Completion handoff')).toBeInTheDocument();
    expect(screen.getByText('Request audit')).toBeInTheDocument();
    expect(screen.getByText('Pilot web search')).toBeInTheDocument();
    expect(screen.getByText(/Goal\/Task\/Plan control unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('No committed goal')).not.toBeInTheDocument();
    expect(screen.queryByText('No assigned task')).not.toBeInTheDocument();
    expect(screen.queryByText('No execution plan')).not.toBeInTheDocument();
    expect(screen.getByText(/shared head 2/i)).toBeInTheDocument();
    expect(screen.getByText(/ledger head 2/i)).toBeInTheDocument();
    expect(screen.getByText(/Runtime-reported capabilities/i)).toBeInTheDocument();
    expect(document.body.textContent?.toLowerCase()).not.toContain('merged transcript');
  });

  test('ignores query-string session and pane overrides', async () => {
    renderApp({
      search:
        '?pairId=pair-web&session=attacker-session&navigatorSessionId=attacker-nav&pane=pilot',
    });

    const navigator = await screen.findByTitle('Navigator DSH session');
    const pilot = screen.getByTitle('Pilot DSH session');
    expect(new URL(navigator.getAttribute('src')!).searchParams.get('session')).toBe(
      'pair:pair-web:navigator',
    );
    expect(new URL(pilot.getAttribute('src')!).searchParams.get('session')).toBe(
      'pair:pair-web:pilot',
    );
    expect(document.body.innerHTML).not.toContain('attacker-session');
    expect(document.body.innerHTML).not.toContain('attacker-nav');
  });

  test.each([
    {
      name: 'same sessions',
      response: responseFor({
        ...baseProjection,
        header: {
          ...baseProjection.header,
          pilotSessionId: baseProjection.header.navigatorSessionId,
        },
      }),
    },
    {
      name: 'descriptor role mismatch',
      response: responseFor(baseProjection, [
        {
          role: 'pilot',
          source: 'pilot-session',
          sessionId: baseProjection.header.navigatorSessionId,
        },
        {
          role: 'navigator',
          source: 'navigator-session',
          sessionId: baseProjection.header.pilotSessionId,
        },
      ]),
    },
    {
      name: 'descriptor session mismatch',
      response: responseFor(baseProjection, [
        {
          role: 'navigator',
          source: 'navigator-session',
          sessionId: 'wrong-session',
        },
        {
          role: 'pilot',
          source: 'pilot-session',
          sessionId: baseProjection.header.pilotSessionId,
        },
      ]),
    },
    {
      name: 'self-consistent sessions belonging to another Pair',
      response: responseFor(
        {
          ...baseProjection,
          header: {
            ...baseProjection.header,
            navigatorSessionId: 'pair:other-pair:navigator',
            pilotSessionId: 'pair:other-pair:pilot',
          },
        },
        [
          {
            role: 'navigator',
            source: 'navigator-session',
            sessionId: 'pair:other-pair:navigator',
          },
          {
            role: 'pilot',
            source: 'pilot-session',
            sessionId: 'pair:other-pair:pilot',
          },
        ],
      ),
    },
  ])('fails closed for invalid Host DTO: $name', async ({ response }) => {
    renderApp({ fetcher: vi.fn(async () => okJson(response)) });

    expect(await screen.findByRole('alert')).toHaveTextContent('Pair Host response');
    expect(screen.queryByTitle(/DSH session/)).not.toBeInTheDocument();
  });

  test.each([
    ['zero ledger head', () => ({ ...baseProjection, header: { ...baseProjection.header, ledgerHead: 0, sharedHead: 0 } })],
    ['empty dsh repository', () => ({
      ...baseProjection,
      header: {
        ...baseProjection.header,
        dshBuild: {
          upstreamRepository: '',
          upstreamCommit: 'a'.repeat(40),
          sourceRepository: 'example/pair-agent',
          sourceCommit: 'b'.repeat(40),
          requestLayoutSeamVersion: 1,
        },
      },
    })],
    ['short dsh commit', () => ({
      ...baseProjection,
      header: {
        ...baseProjection.header,
        dshBuild: {
          upstreamRepository: 'openai/dsh',
          upstreamCommit: 'abc',
          sourceRepository: 'example/pair-agent',
          sourceCommit: 'b'.repeat(40),
          requestLayoutSeamVersion: 1,
        },
      },
    })],
    ['coerced dsh commit', () => ({
      ...baseProjection,
      header: {
        ...baseProjection.header,
        dshBuild: {
          upstreamRepository: 'openai/dsh',
          upstreamCommit: ['a'.repeat(40)],
          sourceRepository: 'example/pair-agent',
          sourceCommit: 'b'.repeat(40),
          requestLayoutSeamVersion: 1,
        },
      },
    })],
    ['wrong dsh seam', () => ({
      ...baseProjection,
      header: {
        ...baseProjection.header,
        dshBuild: {
          upstreamRepository: 'openai/dsh',
          upstreamCommit: 'a'.repeat(40),
          sourceRepository: 'example/pair-agent',
          sourceCommit: 'b'.repeat(40),
          requestLayoutSeamVersion: 2,
        },
      },
    })],
    ['empty goal id', () => ({ ...baseProjection, goal: { id: '', version: 1, summary: 'Goal' } })],
    ['zero goal version', () => ({ ...baseProjection, goal: { id: 'goal-1', version: 0, summary: 'Goal' } })],
    ['invalid goal refs', () => ({ ...baseProjection, goal: { id: 'goal-1', version: 1, summary: 'Goal', constraints: [42] } })],
    ['zero task revision', () => ({ ...baseProjection, task: { id: 'task-1', revision: 0, summary: 'Task', state: 'active' } })],
    ['invalid task state', () => ({ ...baseProjection, task: { id: 'task-1', revision: 1, summary: 'Task', state: 'invented' } })],
    ['zero plan revision', () => ({ ...baseProjection, executionPlan: { id: 'plan-1', revision: 0, steps: [] } })],
    ['empty plan summary', () => ({ ...baseProjection, executionPlan: { id: 'plan-1', revision: 1, summary: '', steps: [] } })],
    ['invalid attention role', () => ({ ...baseProjection, attention: { requested: true, requestedBy: 'observer', requestedAtSeq: 2 } })],
    ['missing attention sequence', () => ({ ...baseProjection, attention: { requested: true, requestedBy: 'navigator' } })],
    ['future attention sequence', () => ({ ...baseProjection, attention: { requested: true, requestedBy: 'pilot', requestedAtSeq: 3 } })],
    ['zero pause sequence', () => ({ ...baseProjection, pause: { paused: true, changedAtSeq: 0 } })],
    ['future pause sequence', () => ({ ...baseProjection, pause: { paused: true, changedAtSeq: 3 } })],
  ])('fully validates Host DTO field: %s', async (_name, buildProjection) => {
    const projection = buildProjection() as unknown as PairProjection;
    renderApp({ fetcher: vi.fn(async () => okJson(responseFor(projection))) });

    expect(await screen.findByRole('alert')).toHaveTextContent('Pair Host response');
    expect(screen.queryByTitle(/DSH session/)).not.toBeInTheDocument();
  });

  test('renders an API error without mounting panes', async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { message: 'host unavailable' } }),
    }) as Response);
    renderApp({ fetcher });

    expect(await screen.findByRole('alert')).toHaveTextContent('host unavailable');
    expect(screen.queryByTitle(/DSH session/)).not.toBeInTheDocument();
  });

  test('marks a loaded Pair degraded when its SSE stream errors', async () => {
    const { eventSource } = renderApp();
    await screen.findByTitle('Navigator DSH session');

    act(() => eventSource.fail());

    expect(screen.getByRole('status', { name: /connection status/i })).toHaveTextContent(
      /degraded/i,
    );
    expect(screen.getByTitle('Navigator DSH session')).toBeInTheDocument();
  });

  test('applies valid SSE projection updates to the shared header', async () => {
    const { eventSource } = renderApp();
    await screen.findByText(/ledger head 2/i);

    act(() => {
      eventSource.emit({
        ...baseProjection,
        header: { ...baseProjection.header, ledgerHead: 5, sharedHead: 5 },
        goal: {
          id: 'goal-1',
          version: 3,
          summary: 'Ship <img src=x onerror=alert(1)> safely',
        },
        task: {
          id: 'task-1',
          revision: 7,
          summary: 'Connect UI',
          state: 'active',
        },
        executionPlan: {
          id: 'plan-1',
          revision: 4,
          summary: 'Phase 0',
          steps: ['Load', 'Stream'],
        },
        attention: {
          requested: true,
          reason: 'Need user choice',
          requestedBy: 'navigator',
          requestedAtSeq: 4,
        },
        pause: { paused: true, reason: 'Awaiting user', changedAtSeq: 5 },
      });
    });

    expect(await screen.findByText(/ledger head 5/i)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: /connection status/i })).toHaveTextContent(
      'ready',
    );
    expect(screen.queryByText(/Connect UI.*active.*r7/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Need user choice')).not.toBeInTheDocument();
    expect(screen.queryByText('Awaiting user')).not.toBeInTheDocument();
    expect(screen.queryByText('Ship <img src=x onerror=alert(1)> safely'))
      .not.toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  test('never rolls the shared projection back on stale or conflicting same-head SSE frames', async () => {
    const { eventSource } = renderApp();
    await screen.findByText(/ledger head 2/i);

    act(() => {
      eventSource.emit({
        ...baseProjection,
        header: { ...baseProjection.header, ledgerHead: 5, sharedHead: 5 },
        goal: { id: 'goal-new', version: 2, summary: 'Newest goal' },
      });
    });
    expect(await screen.findByText(/ledger head 5/i)).toBeInTheDocument();

    act(() => {
      eventSource.emit({
        ...baseProjection,
        header: { ...baseProjection.header, ledgerHead: 3, sharedHead: 3 },
        goal: { id: 'goal-stale', version: 1, summary: 'Stale goal' },
      });
      eventSource.emit({
        ...baseProjection,
        header: { ...baseProjection.header, ledgerHead: 5, sharedHead: 5 },
        goal: { id: 'goal-conflict', version: 9, summary: 'Conflicting goal' },
      });
      eventSource.emit({
        ...baseProjection,
        header: { ...baseProjection.header, ledgerHead: 6, sharedHead: 4 },
        goal: { id: 'goal-shared-rollback', version: 9, summary: 'Shared rollback' },
      });
      eventSource.emit({
        ...baseProjection,
        header: { ...baseProjection.header, ledgerHead: 7, sharedHead: 5 },
        goal: { id: 'goal-shared-conflict', version: 9, summary: 'Shared conflict' },
      });
    });

    expect(screen.getByRole('status', { name: /connection status/i })).toHaveTextContent(
      'degraded',
    );
    expect(screen.queryByText('Stale goal')).not.toBeInTheDocument();
    expect(screen.queryByText('Conflicting goal')).not.toBeInTheDocument();
    expect(screen.queryByText('Shared rollback')).not.toBeInTheDocument();
    expect(screen.queryByText('Shared conflict')).not.toBeInTheDocument();
    expect(screen.getByText(/ledger head 5/i)).toBeInTheDocument();
  });

  const versionedProjection: PairProjection = {
    ...baseProjection,
    header: { ...baseProjection.header, ledgerHead: 10, sharedHead: 10 },
    goal: { id: 'goal-1', version: 4, summary: 'Current goal' },
    task: {
      id: 'task-1',
      revision: 4,
      summary: 'Current task',
      state: 'active',
    },
    executionPlan: {
      id: 'plan-1',
      revision: 4,
      summary: 'Current plan',
      steps: ['Current step'],
    },
    attention: {
      requested: true,
      reason: 'Current attention',
      requestedBy: 'navigator',
      requestedAtSeq: 8,
    },
    pause: { paused: true, reason: 'Current pause', changedAtSeq: 9 },
  };

  test.each([
    ['goal version', { goal: { id: 'goal-1', version: 3, summary: 'Old goal' } }],
    ['task revision', { task: { id: 'task-1', revision: 3, summary: 'Old task', state: 'active' } }],
    ['plan revision', { executionPlan: { id: 'plan-1', revision: 3, summary: 'Old plan', steps: [] } }],
    ['attention sequence', { attention: { requested: true, requestedBy: 'pilot', requestedAtSeq: 7 } }],
    ['attention sequence on clearing', { attention: { requested: false, requestedAtSeq: 7 } }],
    ['pause sequence', { pause: { paused: false, changedAtSeq: 8 } }],
  ])('degrades instead of applying a high-head rollback of %s', async (_name, patch) => {
    const { eventSource } = renderApp({
      fetcher: vi.fn(async () => okJson(responseFor(versionedProjection))),
    });
    await screen.findByText(/ledger head 10/i);

    act(() => {
      eventSource.emit({
        ...versionedProjection,
        ...patch,
        header: {
          ...versionedProjection.header,
          ledgerHead: 11,
          sharedHead: 11,
        },
      });
    });

    expect(screen.getByRole('status', { name: /connection status/i })).toHaveTextContent(
      'degraded',
    );
    expect(screen.getByText(/ledger head 10/i)).toBeInTheDocument();
    expect(screen.queryByText('Current goal')).not.toBeInTheDocument();
  });

  test('allows same-revision task state changes and attention clearing at a higher shared head', async () => {
    const { eventSource } = renderApp({
      fetcher: vi.fn(async () => okJson(responseFor(versionedProjection))),
    });
    await screen.findByText(/ledger head 10/i);

    act(() => {
      eventSource.emit({
        ...versionedProjection,
        header: {
          ...versionedProjection.header,
          ledgerHead: 11,
          sharedHead: 11,
        },
        task: { ...versionedProjection.task!, state: 'paused' },
        attention: { requested: false },
        pause: { paused: false, changedAtSeq: 11 },
      });
    });

    expect(screen.getByRole('status', { name: /connection status/i })).toHaveTextContent(
      'ready',
    );
    expect(screen.getByText(/ledger head 11/i)).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /attention status/i }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /pause status/i }))
      .not.toBeInTheDocument();
  });

  test('rejects an old attention request that tries to revive a cleared projection', async () => {
    const clearedProjection: PairProjection = {
      ...versionedProjection,
      attention: { requested: false },
    };
    const { eventSource } = renderApp({
      fetcher: vi.fn(async () => okJson(responseFor(clearedProjection))),
    });
    await screen.findByText(/ledger head 10/i);

    act(() => {
      eventSource.emit({
        ...clearedProjection,
        header: { ...clearedProjection.header, ledgerHead: 11, sharedHead: 11 },
        attention: {
          requested: true,
          requestedBy: 'pilot',
          requestedAtSeq: 9,
          reason: 'Old request replayed',
        },
        pause: { ...clearedProjection.pause, changedAtSeq: 11 },
      });
    });

    expect(screen.getByRole('status', { name: /connection status/i })).toHaveTextContent(
      'degraded',
    );
    expect(screen.getByText(/ledger head 10/i)).toBeInTheDocument();
    expect(screen.queryByText('Old request replayed')).not.toBeInTheDocument();
  });

  test('integrates the Events trigger and role forms without changing native DSH Session URLs', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') {
        return {
          ok: true,
          status: 202,
          json: async () => ({
            acceptedAtLedgerHead: 3,
            deliveryId: 'pair-web:3',
            delivery: 'delivered',
          }),
        } as Response;
      }
      if (url.pathname.endsWith('/session-events')) {
        return okJson({
          pairId: 'pair-web',
          throughLedgerHead: 2,
          sharedHead: 2,
          events: [],
          nextAfterSeq: 2,
          hasMore: false,
        });
      }
      return okJson(responseFor());
    });
    renderApp({ fetcher });
    const iframe = await screen.findByTitle('Navigator DSH session');
    const sessionUrl = iframe.getAttribute('src');

    fireEvent.click(screen.getByRole('button', { name: 'Session Events' }));
    expect(screen.getByRole('dialog', { name: 'Session Events' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close session events' }));

    const input = screen.getByRole('textbox', { name: 'Message navigator' });
    fireEvent.change(input, { target: { value: 'pair-level input' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to navigator' }));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        'https://pair.example/api/pairs/pair-web/messages/navigator',
        expect.objectContaining({
          body: JSON.stringify({ text: 'pair-level input', expectedLedgerHead: 2 }),
        }),
      ),
    );
    expect(iframe).toHaveAttribute('src', sessionUrl);
  });

  test('keeps a Session Events integrity fault sticky across SSE reconnects', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/session-events')) {
        return okJson({
          pairId: 'pair-web',
          throughLedgerHead: 2,
          sharedHead: 2,
          events: [],
          nextAfterSeq: 0,
          hasMore: true,
        });
      }
      return okJson(responseFor());
    });
    const { eventSource } = renderApp({ fetcher });
    await screen.findByTitle('Navigator DSH session');
    fireEvent.click(screen.getByRole('button', { name: 'Session Events' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/cursor/i);
    expect(screen.getByRole('status', { name: /connection status/i })).toHaveTextContent(
      'degraded',
    );

    act(() => eventSource.reconnect());

    expect(screen.getByRole('status', { name: /connection status/i })).toHaveTextContent(
      'degraded',
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/cursor/i);
  });

  test('does not make an ordinary Session Events network failure sticky', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/session-events')) {
        throw new TypeError('network unavailable');
      }
      return okJson(responseFor());
    });
    renderApp({ fetcher });
    await screen.findByTitle('Navigator DSH session');
    fireEvent.click(screen.getByRole('button', { name: 'Session Events' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('network unavailable');
    expect(screen.getByRole('status', { name: /connection status/i })).toHaveTextContent(
      'ready',
    );
  });

  test('atomically isolates panes, forms and drafts while Pair identity changes', async () => {
    const projectionA: PairProjection = {
      ...baseProjection,
      header: {
        ...baseProjection.header,
        pairId: parsePairId('pair-a'),
        navigatorSessionId: 'pair:pair-a:navigator',
        pilotSessionId: 'pair:pair-a:pilot',
      },
    };
    const projectionB: PairProjection = {
      ...baseProjection,
      header: {
        ...baseProjection.header,
        pairId: parsePairId('pair-b'),
        navigatorSessionId: 'pair:pair-b:navigator',
        pilotSessionId: 'pair:pair-b:pilot',
        ledgerHead: 5,
        sharedHead: 5,
      },
      pause: { paused: false, changedAtSeq: 5 },
    };
    const pending = new Map<string, (response: Response) => void>();
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return new Promise<Response>((resolve) => pending.set(url, resolve));
    });
    const config = {
      apiBase: 'https://pair.example',
      dshWebOrigin: 'https://dsh.example',
      shellOrigin: window.location.origin,
    };
    const view = render(
      <App
        config={config}
        locationSearch="?pairId=pair-a"
        fetcher={fetcher}
        eventSourceFactory={() => new FakeEventSource()}
      />,
    );
    await waitFor(() =>
      expect(pending.has('https://pair.example/api/pairs/pair-a')).toBe(true),
    );
    await act(async () => {
      pending.get('https://pair.example/api/pairs/pair-a')!(okJson(responseFor(projectionA)));
    });
    const oldDraft = await screen.findByRole('textbox', { name: 'Message navigator' });
    fireEvent.change(oldDraft, { target: { value: 'pair A only' } });

    view.rerender(
      <App
        config={config}
        locationSearch="?pairId=pair-b"
        fetcher={fetcher}
        eventSourceFactory={() => new FakeEventSource()}
      />,
    );

    expect(screen.getByText('Loading Pair projection…')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message navigator' })).toBeNull();
    expect(screen.queryByText('pair A only')).toBeNull();
    await waitFor(() =>
      expect(pending.has('https://pair.example/api/pairs/pair-b')).toBe(true),
    );
    await act(async () => {
      pending.get('https://pair.example/api/pairs/pair-b')!(okJson(responseFor(projectionB)));
    });

    const newDraft = await screen.findByRole('textbox', { name: 'Message navigator' });
    expect(newDraft).toHaveValue('');
    expect(screen.getByTitle('Navigator DSH session').getAttribute('src')).toContain(
      'pairId=pair-b',
    );
  });

  test('closes the EventSource when unmounted', async () => {
    const { eventSource, unmount } = renderApp();
    await screen.findByTitle('Navigator DSH session');

    unmount();

    expect(eventSource.close).toHaveBeenCalledTimes(1);
  });

  test('requires a valid configured DSH origin before loading production UI', () => {
    const fetcher = vi.fn();
    renderApp({ dshWebOrigin: '', fetcher });

    expect(screen.getByRole('alert')).toHaveTextContent('DSH Web origin');
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('rejects a configured DSH origin equal to the browser Shell origin', () => {
    const fetcher = vi.fn();
    renderApp({
      dshWebOrigin: window.location.origin,
      shellOrigin: window.location.origin,
      fetcher,
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/separate origin/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('rejects a configured Shell origin that does not equal the actual browser origin', () => {
    const fetcher = vi.fn();
    renderApp({ shellOrigin: 'https://spoofed-shell.example', fetcher });

    expect(screen.getByRole('alert')).toHaveTextContent(/actual browser origin/i);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('keeps unimplemented attention and pause controls out of the live status surface', async () => {
    const { eventSource } = renderApp();

    await screen.findByTitle('Navigator DSH session');
    act(() => {
      eventSource.emit({
        ...baseProjection,
        header: { ...baseProjection.header, ledgerHead: 4, sharedHead: 4 },
        attention: {
          requested: true,
          requestedBy: 'navigator',
          requestedAtSeq: 3,
          reason: 'Review required',
        },
        pause: { paused: true, changedAtSeq: 4, reason: 'Awaiting approval' },
      });
    });
    expect(screen.getByRole('status', { name: /connection status/i })).toHaveAttribute(
      'aria-live',
      'polite',
    );
    expect(screen.queryByRole('status', { name: /attention status/i }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /pause status/i }))
      .not.toBeInTheDocument();
    expect(screen.queryByText('Review required')).not.toBeInTheDocument();
    expect(screen.queryByText('Awaiting approval')).not.toBeInTheDocument();
  });

  test('rejects a missing or malformed runtime capability contract', async () => {
    const malformed = {
      ...responseFor(),
      capabilities: { ...runtimeCapabilities, schemaVersion: 2 },
    };
    renderApp({ fetcher: vi.fn(async () => okJson(malformed)) });

    expect(await screen.findByRole('alert')).toHaveTextContent('Pair Host response');
    expect(screen.queryByTitle(/DSH session/)).not.toBeInTheDocument();
  });

  test('uses an explicit same-origin API default', async () => {
    const fetcher = vi.fn(async () => okJson(responseFor()));
    const eventSourceFactory = vi.fn(() => new FakeEventSource());
    render(
      <App
        config={{
          dshWebOrigin: 'https://dsh.example',
          shellOrigin: window.location.origin,
        }}
        locationSearch="?pairId=pair-web"
        fetcher={fetcher}
        eventSourceFactory={eventSourceFactory}
      />,
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(fetcher).toHaveBeenCalledWith(
      `${window.location.origin}/api/pairs/pair-web`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(eventSourceFactory).toHaveBeenCalledWith(
      `${window.location.origin}/api/pairs/pair-web/events`,
    );
  });

  test('keeps default browser transports stable across state renders', async () => {
    const fetcher = vi.fn(async () => okJson(responseFor()));
    const sources: FakeEventSource[] = [];
    class BrowserEventSource extends FakeEventSource {
      constructor(readonly url: string) {
        super();
        sources.push(this);
      }
    }
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('EventSource', BrowserEventSource);

    render(
      <App
        config={{
          dshWebOrigin: 'https://dsh.example',
          shellOrigin: window.location.origin,
        }}
        locationSearch="?pairId=pair-web"
      />,
    );

    await screen.findByTitle('Navigator DSH session');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(1);
  });
});

describe('Pair Web typed clients', () => {
  const event = (seq: number, text = `message-${seq}`) => ({
    pairId: 'pair-web',
    seq,
    type: 'user.message',
    actor: { kind: 'user' },
    source: 'pair',
    channel: 'navigator',
    visibility: 'shared',
    authority: 'user',
    refs: {},
    payload: { schemaVersion: 1, kind: 'user-input', text, content: [] },
    occurredAt: '2026-09-01T00:00:00.000Z',
  });

  const page = (patch: Record<string, unknown> = {}) => ({
    pairId: 'pair-web',
    throughLedgerHead: 4,
    sharedHead: 4,
    events: [event(3), event(4)],
    nextAfterSeq: 4,
    hasMore: false,
    ...patch,
  });

  test('validates exact Pair identity, ascending events and snapshot heads', () => {
    expect(validateListPairSessionEventsResponse(page(), 'pair-web', 2)).toEqual(page());

    expect(() =>
      validateListPairSessionEventsResponse(page({ pairId: 'other' }), 'pair-web', 2),
    ).toThrow(/pairId/i);
    expect(() =>
      validateListPairSessionEventsResponse(
        page({ events: [event(4), event(3)] }),
        'pair-web',
        2,
      ),
    ).toThrow(/ascending/i);
    expect(() =>
      validateListPairSessionEventsResponse(
        page({ throughLedgerHead: 3, events: [event(3), event(4)] }),
        'pair-web',
        2,
      ),
    ).toThrow(/throughLedgerHead/i);
    expect(() =>
      validateListPairSessionEventsResponse(page({ sharedHead: 5 }), 'pair-web', 2),
    ).toThrow(/sharedHead/i);
  });

  test('rejects invalid physical cursor progression and unknown response fields', () => {
    expect(() =>
      validateListPairSessionEventsResponse(page({ nextAfterSeq: 1 }), 'pair-web', 2),
    ).toThrow(/cursor/i);
    expect(() =>
      validateListPairSessionEventsResponse(
        page({ events: [], nextAfterSeq: 2, throughLedgerHead: 4, hasMore: true }),
        'pair-web',
        2,
      ),
    ).toThrow(/cursor|advance/i);
    expect(() =>
      validateListPairSessionEventsResponse(
        page({ nextAfterSeq: 3, events: [event(4)] }),
        'pair-web',
        2,
      ),
    ).toThrow(/cursor/i);
    expect(() =>
      validateListPairSessionEventsResponse(page({ surprise: true }), 'pair-web', 2),
    ).toThrow(/unexpected/i);
  });

  test.each([
    ['non-object goal ref', { goal: 1 }],
    ['goal ref unknown field', { goal: { id: 'goal-1', version: 1, extra: true } }],
    ['invalid task revision', { task: { id: 'task-1', revision: 0 } }],
    ['invalid execution plan id', { executionPlan: { id: '', revision: 1 } }],
    ['non-array source event IDs', { sourceEventIds: 'source-1' }],
    ['non-string source event ID', { sourceEventIds: ['source-1', 2] }],
    ['empty source event ID', { sourceEventIds: [''] }],
  ])('rejects malformed PairEvent refs: %s', (_name, refs) => {
    expect(() =>
      validateListPairSessionEventsResponse(
        page({ events: [{ ...event(3), refs }, event(4)] }),
        'pair-web',
        2,
      ),
    ).toThrow(/refs/i);
  });

  test.each([
    ['an empty sourceEventIds array', []],
    ['duplicate non-empty sourceEventIds', ['source-1', 'source-1']],
  ])('accepts contract-valid PairEvent refs with %s', (_name, sourceEventIds) => {
    expect(() =>
      validateListPairSessionEventsResponse(
        page({
          events: [{ ...event(3), refs: { sourceEventIds } }, event(4)],
        }),
        'pair-web',
        2,
      ),
    ).not.toThrow();
  });

  test('sends a role message and validates the 202 response', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 202,
      json: async () => ({
        acceptedAtLedgerHead: 5,
        deliveryId: 'pair-web:5',
        delivery: 'pending',
      }),
    }) as Response);

    await expect(
      sendPairMessage(
        fetcher,
        'https://pair.example',
        'pair-web',
        'pilot',
        { text: 'hello', expectedLedgerHead: 4 },
      ),
    ).resolves.toEqual({
      acceptedAtLedgerHead: 5,
      deliveryId: 'pair-web:5',
      delivery: 'pending',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://pair.example/api/pairs/pair-web/messages/pilot',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello', expectedLedgerHead: 4 }),
      }),
    );
  });

  test('surfaces a structured 409 ledger conflict', async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: 'LEDGER_CONFLICT',
          message: 'Ledger head conflict',
          details: { expectedLedgerHead: 4, actualLedgerHead: 6 },
        },
      }),
    }) as Response);

    await expect(
      sendPairMessage(
        fetcher,
        'https://pair.example',
        'pair-web',
        'navigator',
        { text: 'hello', expectedLedgerHead: 4 },
      ),
    ).rejects.toMatchObject({
      name: 'LedgerConflictError',
      expectedLedgerHead: 4,
      actualLedgerHead: 6,
    } satisfies Partial<LedgerConflictError>);
  });

  test('rejects malformed success bodies and preserves abort errors', async () => {
    const malformed = vi.fn(async () => ({
      ok: true,
      status: 202,
      json: async () => ({ delivery: 'delivered' }),
    }) as Response);
    await expect(
      sendPairMessage(
        malformed,
        'https://pair.example',
        'pair-web',
        'navigator',
        { text: 'hello', expectedLedgerHead: 4 },
      ),
    ).rejects.toBeInstanceOf(TypeError);

    const aborted = new DOMException('aborted', 'AbortError');
    const aborting = vi.fn(async () => Promise.reject(aborted));
    await expect(
      sendPairMessage(
        aborting,
        'https://pair.example',
        'pair-web',
        'navigator',
        { text: 'hello', expectedLedgerHead: 4 },
        new AbortController().signal,
      ),
    ).rejects.toBe(aborted);
  });
});
