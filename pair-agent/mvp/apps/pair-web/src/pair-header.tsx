import type { RefObject } from 'react';
import type {
  PairProjection,
  PairRuntimeCapabilities,
} from '@pair-agent/contracts';

export interface PairHeaderViewProps {
  readonly projection: PairProjection;
  readonly capabilities: PairRuntimeCapabilities;
  readonly connectionState: 'ready' | 'degraded';
  readonly onOpenSessionEvents: () => void;
  readonly sessionEventsButtonRef: RefObject<HTMLButtonElement>;
}

export function PairHeaderView({
  projection,
  capabilities,
  connectionState,
  onOpenSessionEvents,
  sessionEventsButtonRef,
}: PairHeaderViewProps) {
  const { header } = projection;
  const available = [
    capabilities.sharedConversation ? 'Shared context' : undefined,
    capabilities.peerMessaging ? 'Peer messaging' : undefined,
    capabilities.completionHandoff ? 'Completion handoff' : undefined,
    capabilities.requestAudit ? 'Request audit' : undefined,
    capabilities.pilotWebSearch ? 'Pilot web search' : undefined,
  ].filter((label): label is string => label !== undefined);
  return (
    <header className="pair-header">
      <div className="pair-header__identity">
        <div>
          <p className="eyebrow">Pair Web Shell</p>
          <h1>{header.pairId}</h1>
        </div>
        <div className="pair-header__actions">
          <button ref={sessionEventsButtonRef} type="button" onClick={onOpenSessionEvents}>
            Session Events
          </button>
          <span
            className={`status status--${connectionState}`}
            role="status"
            aria-live="polite"
            aria-label="Connection status"
          >
            {connectionState}
          </span>
        </div>
      </div>

      <p className="projection-boundary">
        Runtime-reported capabilities for this Pair composition. Each pane keeps its
        own native DSH transcript and composer.
      </p>

      <dl className="pair-header__grid">
        <div>
          <dt>Stage</dt>
          <dd>{capabilities.stage}</dd>
        </div>
        <div>
          <dt>Heads</dt>
          <dd>
            Shared head {header.sharedHead} · Ledger head {header.ledgerHead}
          </dd>
        </div>
        <div>
          <dt>Agent sessions</dt>
          <dd>Navigator + Pilot · isolated continuation</dd>
        </div>
        <div className="pair-header__capabilities">
          <dt>Available capabilities</dt>
          <dd>
            <ul className="capability-list">
              {available.map((label) => <li key={label}>{label}</li>)}
            </ul>
          </dd>
        </div>
        <div className="pair-header__capabilities">
          <dt>Not implemented in this MVP</dt>
          <dd>Goal/Task/Plan control unavailable · Attention/Pause unavailable · Sub-agents unavailable</dd>
        </div>
      </dl>
    </header>
  );
}
