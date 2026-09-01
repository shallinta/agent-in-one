import type { RefObject } from 'react';
import type { PairProjection } from '@pair-agent/contracts';

export interface PairHeaderViewProps {
  readonly projection: PairProjection;
  readonly connectionState: 'ready' | 'degraded';
  readonly onOpenSessionEvents: () => void;
  readonly sessionEventsButtonRef: RefObject<HTMLButtonElement>;
}

export function PairHeaderView({
  projection,
  connectionState,
  onOpenSessionEvents,
  sessionEventsButtonRef,
}: PairHeaderViewProps) {
  const { header, goal, task, executionPlan, attention, pause } = projection;
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
        This header is the shared Pair Projection. Each pane keeps its own native DSH
        transcript and composer.
      </p>

      <dl className="pair-header__grid">
        <div>
          <dt>Goal</dt>
          <dd>{goal?.summary ?? 'No committed goal'}</dd>
          {goal ? <small>v{goal.version}</small> : null}
        </div>
        <div>
          <dt>Task</dt>
          <dd>
            {task ? `${task.summary} · ${task.state} · r${task.revision}` : 'No assigned task'}
          </dd>
        </div>
        <div>
          <dt>Execution plan</dt>
          <dd>
            {executionPlan
              ? `${executionPlan.summary ?? executionPlan.id} · r${executionPlan.revision}`
              : 'No execution plan'}
          </dd>
          {executionPlan && executionPlan.steps.length > 0 ? (
            <ol>
              {executionPlan.steps.map((step, index) => (
                <li key={`${index}:${step}`}>{step}</li>
              ))}
            </ol>
          ) : null}
        </div>
        <div>
          <dt>Heads</dt>
          <dd>
            Shared head {header.sharedHead} · Ledger head {header.ledgerHead}
          </dd>
        </div>
        <div>
          <dt>Attention</dt>
          <dd
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label="Attention status"
          >
            {attention.requested ? 'Requested' : 'Clear'}
            {attention.reason ? <> <small>{attention.reason}</small></> : null}
          </dd>
        </div>
        <div>
          <dt>Pair state</dt>
          <dd
            role="status"
            aria-live="polite"
            aria-atomic="true"
            aria-label="Pause status"
          >
            {pause.paused ? 'Paused' : 'Running'}
            {pause.reason ? <> <small>{pause.reason}</small></> : null}
          </dd>
        </div>
      </dl>
    </header>
  );
}
