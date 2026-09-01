import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';

import { SessionEventsDrawer } from '../src/session-events-drawer.js';

function pairEvent(seq: number, patch: Record<string, unknown> = {}) {
  return {
    pairId: 'pair-drawer',
    seq,
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
      text: `Readable message ${seq}`,
      content: [],
    },
    occurredAt: '2026-09-01T00:00:00.000Z',
    ...patch,
  };
}

function page(
  events: unknown[],
  nextAfterSeq: number,
  options: { hasMore?: boolean; throughLedgerHead?: number; sharedHead?: number } = {},
) {
  const throughLedgerHead = options.throughLedgerHead ?? nextAfterSeq;
  return {
    pairId: 'pair-drawer',
    throughLedgerHead,
    sharedHead: options.sharedHead ?? throughLedgerHead,
    events,
    nextAfterSeq,
    hasMore: options.hasMore ?? false,
  };
}

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function Harness({
  fetcher,
  targetLedgerHead = 2,
  pairId = 'pair-drawer',
  onDegraded = vi.fn(),
}: {
  fetcher: typeof fetch;
  targetLedgerHead?: number;
  pairId?: string;
  onDegraded?: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [connectionState, setConnectionState] = useState<'ready' | 'degraded'>('ready');
  const openerRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <span role="status" aria-label="Host connection status">{connectionState}</span>
      <button ref={openerRef} onClick={() => setOpen(true)}>Session Events</button>
      <SessionEventsDrawer
        apiBase="https://pair.example"
        pairId={pairId}
        targetLedgerHead={targetLedgerHead}
        fetcher={fetcher}
        open={open}
        onClose={() => setOpen(false)}
        openerRef={openerRef}
        onDegraded={(reason) => {
          setConnectionState('degraded');
          onDegraded(reason);
        }}
      />
    </>
  );
}

describe('SessionEventsDrawer', () => {
  test('is closed by default, opens as a modal with Semantic selected, and restores focus', async () => {
    const fetcher = vi.fn(async () => response(page([pairEvent(1), pairEvent(2)], 2)));
    render(<Harness fetcher={fetcher} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const opener = screen.getByRole('button', { name: 'Session Events' });
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Session Events' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Semantic' })).toBeChecked();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Close session events' })).toHaveFocus(),
    );

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  test('switches to All/Audit by resetting the physical cursor and refetching view=all', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      return response(page([pairEvent(1), pairEvent(2)], 2));
    });
    render(<Harness fetcher={fetcher} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session Events' }));
    await screen.findByText('Readable message 1');

    fireEvent.click(screen.getByRole('radio', { name: 'All / Audit' }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const allUrl = new URL(String(fetcher.mock.calls[1]![0]));
    expect(allUrl.searchParams.get('afterSeq')).toBe('0');
    expect(allUrl.searchParams.get('view')).toBe('all');
  });

  test('shows event metadata, a readable summary and escaped expandable JSON', async () => {
    const malicious = pairEvent(1, {
      actor: { kind: 'agent', role: 'pilot' },
      source: 'pilot-session',
      channel: 'navigator',
      visibility: 'shared',
      payload: {
        schemaVersion: 1,
        kind: 'peer-message',
        text: '<img src=x onerror=alert(1)>',
        content: [],
        causalRootId: 'root',
        hop: 1,
      },
    });
    render(<Harness targetLedgerHead={1} fetcher={vi.fn(async () => response(page([malicious], 1)))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session Events' }));

    expect(await screen.findByText('#1')).toBeInTheDocument();
    expect(screen.getByText('user.message')).toBeInTheDocument();
    expect(screen.getByText('agent:pilot')).toBeInTheDocument();
    expect(screen.getByText('pilot-session')).toBeInTheDocument();
    expect(screen.getByText('navigator')).toBeInTheDocument();
    expect(screen.getByText('shared')).toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    const occurredAt = document.querySelector('time');
    expect(occurredAt).toHaveAttribute('datetime', malicious.occurredAt);
    expect(occurredAt).toHaveAttribute('title', malicious.occurredAt);
    expect(occurredAt?.textContent).not.toBe('');
    expect(document.querySelector('img')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Expand event 1' }));
    const pre = document.querySelector('pre');
    expect(pre?.textContent).toBe(JSON.stringify(malicious, null, 2));
    expect(document.querySelector('[dangerouslySetInnerHTML]')).toBeNull();
  });

  test('uses Projection head jumps only as tail high-watermarks and catches up every page', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(page([pairEvent(1)], 1, { hasMore: false, throughLedgerHead: 1 })))
      .mockResolvedValueOnce(response(page([pairEvent(2), pairEvent(3)], 3, { hasMore: true, throughLedgerHead: 5 })))
      .mockResolvedValueOnce(response(page([pairEvent(3), pairEvent(4), pairEvent(5)], 5, { throughLedgerHead: 5 })));
    const view = render(<Harness targetLedgerHead={1} fetcher={fetcher} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session Events' }));
    await screen.findByText('Readable message 1');

    view.rerender(<Harness targetLedgerHead={5} fetcher={fetcher} />);

    expect(await screen.findByText('Readable message 5')).toBeInTheDocument();
    expect(screen.getAllByText('Readable message 3')).toHaveLength(1);
    const urls = fetcher.mock.calls.map((call) => new URL(String(call[0])));
    expect(urls.slice(1).map((url) => url.searchParams.get('afterSeq'))).toEqual(['1', '3']);
  });

  test('retains a Semantic page physical cursor even when filtered records produce no rows', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(page([], 3, { hasMore: true, throughLedgerHead: 4, sharedHead: 2 })))
      .mockResolvedValueOnce(response(page([pairEvent(4)], 4, { throughLedgerHead: 4 })));
    render(<Harness targetLedgerHead={4} fetcher={fetcher} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session Events' }));

    expect(await screen.findByText('Readable message 4')).toBeInTheDocument();
    expect(new URL(String(fetcher.mock.calls[1]![0])).searchParams.get('afterSeq')).toBe('3');
  });

  test('keeps the bounded page cap local and resumes from its physical cursor after reopen', async () => {
    const onDegraded = vi.fn();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const afterSeq = Number(new URL(String(input)).searchParams.get('afterSeq'));
      const nextAfterSeq = afterSeq + 1;
      return response(
        page([pairEvent(nextAfterSeq)], nextAfterSeq, {
          hasMore: nextAfterSeq < 65,
          throughLedgerHead: 65,
          sharedHead: 65,
        }),
      );
    });
    render(
      <Harness
        targetLedgerHead={65}
        fetcher={fetcher}
        onDegraded={onDegraded}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Session Events' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/bounded page limit/i);
    expect(fetcher).toHaveBeenCalledTimes(64);
    expect(onDegraded).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: 'Host connection status' })).toHaveTextContent(
      'ready',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close session events' }));
    fireEvent.click(screen.getByRole('button', { name: 'Session Events' }));

    expect(await screen.findByText('Readable message 65')).toBeInTheDocument();
    expect(new URL(String(fetcher.mock.calls[64]![0])).searchParams.get('afterSeq')).toBe(
      '64',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onDegraded).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: 'Host connection status' })).toHaveTextContent(
      'ready',
    );
  });

  test.each([
    ['a backward cursor', page([], 0, { hasMore: true, throughLedgerHead: 2 })],
    [
      'the same sequence with different content',
      page([pairEvent(1, { payload: { text: 'changed' } })], 1, { throughLedgerHead: 2 }),
    ],
  ])('degrades on %s while catching up', async (_name, badPage) => {
    const onDegraded = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(page([pairEvent(1)], 1, { throughLedgerHead: 1 })))
      .mockResolvedValueOnce(response(badPage));
    const view = render(<Harness targetLedgerHead={1} fetcher={fetcher} onDegraded={onDegraded} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session Events' }));
    await screen.findByText('Readable message 1');
    view.rerender(<Harness targetLedgerHead={2} fetcher={fetcher} onDegraded={onDegraded} />);

    await waitFor(() => expect(onDegraded).toHaveBeenCalled());
  });

  test('degrades on an unexplained physical gap in All/Audit mode', async () => {
    const onDegraded = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(page([pairEvent(1)], 1, { throughLedgerHead: 1 })))
      .mockResolvedValueOnce(response(page([pairEvent(1)], 1, { throughLedgerHead: 1 })))
      .mockResolvedValueOnce(response(page([pairEvent(3)], 3, { throughLedgerHead: 3 })));
    const view = render(<Harness targetLedgerHead={1} fetcher={fetcher} onDegraded={onDegraded} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session Events' }));
    await screen.findByText('Readable message 1');
    fireEvent.click(screen.getByRole('radio', { name: 'All / Audit' }));
    await screen.findByText('Readable message 1');
    view.rerender(<Harness targetLedgerHead={3} fetcher={fetcher} onDegraded={onDegraded} />);

    await waitFor(() => expect(onDegraded).toHaveBeenCalled());
  });

  test('aborts outstanding fetches on view switch, close, Pair identity change and unmount', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init!.signal as AbortSignal);
      return new Promise<Response>(() => undefined);
    });
    const view = render(<Harness fetcher={fetcher} />);
    fireEvent.click(screen.getByRole('button', { name: 'Session Events' }));
    await waitFor(() => expect(signals).toHaveLength(1));

    fireEvent.click(screen.getByRole('radio', { name: 'All / Audit' }));
    await waitFor(() => expect(signals[0]!.aborted).toBe(true));
    await waitFor(() => expect(signals).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: 'Close session events' }));
    expect(signals[1]!.aborted).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Session Events' }));
    await waitFor(() => expect(signals).toHaveLength(3));

    view.rerender(<Harness fetcher={fetcher} pairId="new-pair" />);
    expect(signals[2]!.aborted).toBe(true);
    await waitFor(() => expect(signals).toHaveLength(4));

    view.unmount();
    expect(signals[3]!.aborted).toBe(true);
  });
});
