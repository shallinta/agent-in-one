import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  parsePairId,
  type GetPairResponse,
  type PairProjection,
} from '@pair-agent/contracts';

import { App, type PairEventSource } from '../src/app.js';

const baseProjection: PairProjection = {
  header: {
    pairId: parsePairId('pair-web'),
    schemaVersion: 1,
    navigatorSessionId: 'pair:pair-web:navigator',
    pilotSessionId: 'pair:pair-web:pilot',
    ledgerHead: 2,
    sharedHead: 2,
  },
  attention: { requested: false },
  pause: { paused: false, changedAtSeq: 2 },
};

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
  return { projection, panes };
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
    expect(screen.getByText('No committed goal')).toBeInTheDocument();
    expect(screen.getByText('No assigned task')).toBeInTheDocument();
    expect(screen.getByText('No execution plan')).toBeInTheDocument();
    expect(screen.getByText(/shared head 2/i)).toBeInTheDocument();
    expect(screen.getByText(/ledger head 2/i)).toBeInTheDocument();
    expect(screen.getByText(/shared Pair Projection/i)).toBeInTheDocument();
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
    expect(screen.getByText(/Connect UI.*active.*r7/i)).toBeInTheDocument();
    expect(screen.getByText(/Phase 0.*r4/i)).toBeInTheDocument();
    expect(screen.getByText('Need user choice')).toBeInTheDocument();
    expect(screen.getByText('Awaiting user')).toBeInTheDocument();
    expect(screen.getByText('Ship <img src=x onerror=alert(1)> safely')).toBeInTheDocument();
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
    expect(await screen.findByText('Newest goal')).toBeInTheDocument();

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

    expect(screen.getByText('Newest goal')).toBeInTheDocument();
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
    await screen.findByText('Current goal');

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
    expect(screen.getByText('Current goal')).toBeInTheDocument();
    expect(screen.getByText(/Current task.*r4/i)).toBeInTheDocument();
    expect(screen.getByText(/Current plan.*r4/i)).toBeInTheDocument();
    expect(screen.getByText('Current attention')).toBeInTheDocument();
    expect(screen.getByText('Current pause')).toBeInTheDocument();
  });

  test('allows same-revision task state changes and attention clearing at a higher shared head', async () => {
    const { eventSource } = renderApp({
      fetcher: vi.fn(async () => okJson(responseFor(versionedProjection))),
    });
    await screen.findByText('Current goal');

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
    expect(screen.getByText(/Current task.*paused.*r4/i)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: /attention status/i })).toHaveTextContent(
      'Clear',
    );
    expect(screen.getByRole('status', { name: /pause status/i })).toHaveTextContent(
      'Running',
    );
  });

  test('rejects an old attention request that tries to revive a cleared projection', async () => {
    const clearedProjection: PairProjection = {
      ...versionedProjection,
      attention: { requested: false },
    };
    const { eventSource } = renderApp({
      fetcher: vi.fn(async () => okJson(responseFor(clearedProjection))),
    });
    await screen.findByText('Current goal');

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
    expect(screen.getByRole('status', { name: /attention status/i })).toHaveTextContent(
      'Clear',
    );
    expect(screen.queryByText('Old request replayed')).not.toBeInTheDocument();
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

  test('exposes restrained live status regions for connection, attention and pause', async () => {
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
    expect(screen.getByRole('status', { name: /attention status/i })).toHaveAttribute(
      'aria-live',
      'polite',
    );
    expect(screen.getByRole('status', { name: /attention status/i })).toHaveAttribute(
      'aria-atomic',
      'true',
    );
    expect(screen.getByRole('status', { name: /attention status/i })).toHaveTextContent(
      'Requested Review required',
    );
    expect(screen.getByRole('status', { name: /pause status/i })).toHaveAttribute(
      'aria-live',
      'polite',
    );
    expect(screen.getByRole('status', { name: /pause status/i })).toHaveAttribute(
      'aria-atomic',
      'true',
    );
    expect(screen.getByRole('status', { name: /pause status/i })).toHaveTextContent(
      'Paused Awaiting approval',
    );
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
