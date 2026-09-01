import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  canonicalJsonStringify,
  type PairEvent,
  type SessionEventsView,
} from '@pair-agent/contracts';

import {
  InvalidPairHostResponseError,
  listPairSessionEvents,
} from './pair-client.js';

const PAGE_SIZE = 100;
const MAX_CATCH_UP_PAGES = 64;

export interface SessionEventsDrawerProps {
  readonly apiBase: string;
  readonly pairId: string;
  readonly targetLedgerHead: number;
  readonly fetcher: typeof fetch;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly openerRef: RefObject<HTMLButtonElement>;
  readonly onDegraded: (reason: string) => void;
}

function actorLabel(event: PairEvent): string {
  return event.actor.kind === 'agent'
    ? `agent:${event.actor.role}`
    : event.actor.kind;
}

function summaryFor(event: PairEvent): string {
  if (
    typeof event.payload === 'object' &&
    event.payload !== null &&
    !Array.isArray(event.payload)
  ) {
    const payload = event.payload as Record<string, unknown>;
    for (const key of ['text', 'summary', 'reason', 'message']) {
      if (typeof payload[key] === 'string' && payload[key] !== '') return payload[key];
    }
    if (typeof payload.deliveryId === 'string') return `Delivery ${payload.deliveryId}`;
  }
  return event.type.replaceAll('.', ' ');
}

export function SessionEventsDrawer({
  apiBase,
  pairId,
  targetLedgerHead,
  fetcher,
  open,
  onClose,
  openerRef,
  onDegraded,
}: SessionEventsDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef<AbortController>();
  const eventsRef = useRef<PairEvent[]>([]);
  const cursorRef = useRef(0);
  const expectedViewRef = useRef<SessionEventsView>('semantic');
  const [view, setView] = useState<SessionEventsView>('semantic');
  const [events, setEvents] = useState<readonly PairEvent[]>([]);
  const [nextAfterSeq, setNextAfterSeq] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  const reset = (): void => {
    requestRef.current?.abort();
    eventsRef.current = [];
    cursorRef.current = 0;
    setEvents([]);
    setNextAfterSeq(0);
    setHasMore(true);
    setError(undefined);
    setExpanded(new Set());
  };

  useEffect(() => {
    expectedViewRef.current = 'semantic';
    reset();
    setView('semantic');
  }, [pairId]);

  useLayoutEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (open) return;
    requestRef.current?.abort();
    setLoading(false);
  }, [open]);

  useEffect(() => {
    if (
      !open ||
      view !== expectedViewRef.current ||
      cursorRef.current >= targetLedgerHead
    ) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;

    const degrade = (reason: string): void => {
      if (controller.signal.aborted) return;
      setError(reason);
      onDegraded(reason);
    };

    const catchUp = async (): Promise<void> => {
      setLoading(true);
      setError(undefined);
      let cursor = cursorRef.current;
      let more = true;
      const bySeq = new Map(eventsRef.current.map((event) => [event.seq, event]));

      try {
        for (let pageIndex = 0; pageIndex < MAX_CATCH_UP_PAGES; pageIndex += 1) {
          if (cursor >= targetLedgerHead || !more) break;
          const page = await listPairSessionEvents(
            fetcher,
            apiBase,
            pairId,
            { afterSeq: cursor, limit: PAGE_SIZE, view },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if (page.nextAfterSeq < cursor) {
            degrade('Session Events returned a backward physical cursor.');
            return;
          }
          if (page.nextAfterSeq === cursor && page.hasMore) {
            degrade('Session Events cursor did not advance.');
            return;
          }

          if (view === 'all') {
            const physical = page.events.filter((event) => event.seq > cursor);
            let expected = cursor + 1;
            for (const event of physical) {
              if (event.seq !== expected) {
                degrade(`Session Events has an unexplained physical gap before seq ${event.seq}.`);
                return;
              }
              expected += 1;
            }
            if (page.nextAfterSeq > cursor && expected - 1 !== page.nextAfterSeq) {
              degrade('Session Events All/Audit cursor skipped physical records.');
              return;
            }
          }

          for (const event of page.events) {
            const existing = bySeq.get(event.seq);
            if (
              existing !== undefined &&
              canonicalJsonStringify(existing) !== canonicalJsonStringify(event)
            ) {
              degrade(`Session Events seq ${event.seq} changed content.`);
              return;
            }
            bySeq.set(event.seq, event);
          }

          cursor = page.nextAfterSeq;
          more = page.hasMore;
          const merged = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
          eventsRef.current = merged;
          cursorRef.current = cursor;
          setEvents(merged);
          setNextAfterSeq(cursor);
          setHasMore(more);
          if (cursor >= targetLedgerHead || !more) break;
          if (pageIndex === MAX_CATCH_UP_PAGES - 1) {
            degrade('Session Events catch-up exceeded the bounded page limit.');
          }
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        const message = caught instanceof Error ? caught.message : 'Session Events request failed';
        setError(message);
        if (caught instanceof InvalidPairHostResponseError) onDegraded(message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    void catchUp();
    return () => controller.abort();
  }, [apiBase, fetcher, onDegraded, open, pairId, targetLedgerHead, view]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const close = (): void => {
    requestRef.current?.abort();
    onClose();
    openerRef.current?.focus();
  };

  const chooseView = (nextView: SessionEventsView): void => {
    if (nextView === view) return;
    expectedViewRef.current = nextView;
    reset();
    setView(nextView);
  };

  if (!open) return null;

  return (
    <dialog
      ref={dialogRef}
      className="session-events"
      aria-labelledby="session-events-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <div className="session-events__header">
        <div>
          <p className="eyebrow">Pair Ledger</p>
          <h2 id="session-events-title">Session Events</h2>
        </div>
        <button ref={closeRef} type="button" onClick={close} aria-label="Close session events">
          Close
        </button>
      </div>
      <fieldset className="session-events__views">
        <legend>Event view</legend>
        <label>
          <input
            type="radio"
            name="session-events-view"
            checked={view === 'semantic'}
            onChange={() => chooseView('semantic')}
          />
          Semantic
        </label>
        <label>
          <input
            type="radio"
            name="session-events-view"
            checked={view === 'all'}
            onChange={() => chooseView('all')}
          />
          All / Audit
        </label>
      </fieldset>
      <p className="session-events__cursor">
        Physical cursor {nextAfterSeq} · {hasMore ? 'more available' : 'caught up'}
      </p>
      {loading ? <p role="status">Loading Session Events…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <ol className="session-events__list">
        {events.map((event) => {
          const isExpanded = expanded.has(event.seq);
          return (
            <li key={event.seq} className="session-events__row">
              <div className="session-events__metadata">
                <strong>#{event.seq}</strong>
                <span>{event.type}</span>
                <span>{actorLabel(event)}</span>
                <span>{event.source}</span>
                <span>{event.channel}</span>
                <span>{event.visibility}</span>
              </div>
              <p>{summaryFor(event)}</p>
              <time dateTime={event.occurredAt} title={event.occurredAt}>
                {new Date(event.occurredAt).toLocaleString()}
              </time>
              <button
                type="button"
                aria-label={`${isExpanded ? 'Collapse' : 'Expand'} event ${event.seq}`}
                onClick={() => {
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(event.seq)) next.delete(event.seq);
                    else next.add(event.seq);
                    return next;
                  });
                }}
              >
                {isExpanded ? 'Hide JSON' : 'Show JSON'}
              </button>
              {isExpanded ? <pre>{JSON.stringify(event, null, 2)}</pre> : null}
            </li>
          );
        })}
      </ol>
    </dialog>
  );
}
