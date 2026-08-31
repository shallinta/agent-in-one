import { useEffect, useMemo, useState } from 'react';
import type { PairProjection } from '@pair-agent/contracts';

import {
  loadPair,
  normalizeApiBase,
  normalizeDshWebOrigin,
  normalizeShellOrigin,
  pairApiUrl,
  parsePairIdFromSearch,
  validateProjectionTransition,
  validateProjectionUpdate,
  type PairWebConfig,
  type ValidatedPairPane,
} from './pair-client.js';
import { PairHeaderView } from './pair-header.js';
import { PairPane } from './pair-pane.js';
import './styles.css';

export interface PairEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
  close(): void;
}

interface LoadedState {
  readonly kind: 'ready' | 'degraded';
  readonly projection: PairProjection;
  readonly panes: readonly [ValidatedPairPane, ValidatedPairPane];
}

type AppState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | LoadedState;

export interface AppProps {
  readonly config: PairWebConfig;
  readonly locationSearch?: string;
  readonly fetcher?: typeof fetch;
  readonly eventSourceFactory?: (url: string) => PairEventSource;
}

type Startup =
  | {
      readonly ok: true;
      readonly pairId: string;
      readonly dshWebOrigin: string;
      readonly shellOrigin: string;
      readonly apiBase: string;
    }
  | { readonly ok: false; readonly error: string };

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected Pair Web error';
}

const browserFetch: typeof fetch = (...args) => window.fetch(...args);
const browserEventSourceFactory = (url: string): PairEventSource =>
  new EventSource(url);

export function App({
  config,
  locationSearch = window.location.search,
  fetcher = browserFetch,
  eventSourceFactory = browserEventSourceFactory,
}: AppProps) {
  const startup = useMemo<Startup>(() => {
    try {
      const pairId = parsePairIdFromSearch(locationSearch);
      const shellOrigin = normalizeShellOrigin(undefined, window.location.origin);
      if (config.shellOrigin !== undefined) {
        const configuredShellOrigin = normalizeShellOrigin(config.shellOrigin, '');
        if (configuredShellOrigin !== shellOrigin) {
          throw new TypeError(
            'Configured Pair Shell origin must equal the actual browser origin',
          );
        }
      }
      const dshWebOrigin = normalizeDshWebOrigin(
        config.dshWebOrigin,
        shellOrigin,
      );
      const apiBase = normalizeApiBase(config.apiBase, window.location.origin);
      return { ok: true, pairId, dshWebOrigin, shellOrigin, apiBase };
    } catch (error) {
      return { ok: false, error: messageFor(error) };
    }
  }, [config.apiBase, config.dshWebOrigin, config.shellOrigin, locationSearch]);

  const [state, setState] = useState<AppState>(() =>
    startup.ok ? { kind: 'loading' } : { kind: 'error', message: startup.error },
  );

  useEffect(() => {
    if (!startup.ok) {
      setState({ kind: 'error', message: startup.error });
      return;
    }

    const abortController = new AbortController();
    let active = true;
    let source: PairEventSource | undefined;
    setState({ kind: 'loading' });

    void loadPair(
      fetcher,
      pairApiUrl(startup.apiBase, startup.pairId),
      abortController.signal,
      startup.pairId,
    )
      .then((loaded) => {
        if (!active) return;
        setState({ kind: 'ready', ...loaded });

        try {
          source = eventSourceFactory(
            pairApiUrl(startup.apiBase, startup.pairId, '/events'),
          );
        } catch {
          setState({ kind: 'degraded', ...loaded });
          return;
        }

        source.onopen = () => {
          if (!active) return;
          setState((current) =>
            current.kind === 'ready' || current.kind === 'degraded'
              ? { ...current, kind: 'ready' }
              : current,
          );
        };
        source.onerror = () => {
          if (!active) return;
          setState((current) =>
            current.kind === 'ready' || current.kind === 'degraded'
              ? { ...current, kind: 'degraded' }
              : current,
          );
        };
        source.onmessage = (event) => {
          if (!active) return;
          try {
            const projection = validateProjectionUpdate(
              JSON.parse(event.data) as unknown,
              loaded.projection.header,
            );
            setState((current) => {
              if (current.kind !== 'ready' && current.kind !== 'degraded') {
                return current;
              }
              try {
                return validateProjectionTransition(current.projection, projection)
                  ? { ...current, projection }
                  : current;
              } catch {
                return { ...current, kind: 'degraded' };
              }
            });
          } catch {
            setState((current) =>
              current.kind === 'ready' || current.kind === 'degraded'
                ? { ...current, kind: 'degraded' }
                : current,
            );
          }
        };
      })
      .catch((error: unknown) => {
        if (!active || abortController.signal.aborted) return;
        setState({ kind: 'error', message: messageFor(error) });
      });

    return () => {
      active = false;
      abortController.abort();
      source?.close();
    };
  }, [eventSourceFactory, fetcher, startup]);

  if (!startup.ok) {
    return (
      <main className="shell-state shell-state--error">
        <p role="alert">{startup.error}</p>
      </main>
    );
  }
  if (state.kind === 'loading') {
    return <main className="shell-state">Loading Pair projection…</main>;
  }
  if (state.kind === 'error') {
    return (
      <main className="shell-state shell-state--error">
        <p role="alert">{state.message}</p>
      </main>
    );
  }

  return (
    <main className="pair-shell">
      <PairHeaderView projection={state.projection} connectionState={state.kind} />
      <div className="pair-shell__panes">
        {state.panes.map((pane) => (
          <PairPane
            key={pane.role}
            dshWebOrigin={startup.dshWebOrigin}
            shellOrigin={startup.shellOrigin}
            pane={pane}
          />
        ))}
      </div>
      <p className="mobile-note">
        Narrow screens stack the two panes for inspection; Phase 0 does not claim a
        product-grade mobile experience.
      </p>
    </main>
  );
}
