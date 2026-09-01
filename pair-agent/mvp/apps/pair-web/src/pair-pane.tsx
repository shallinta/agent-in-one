import { useState, type ReactNode } from 'react';

import {
  normalizeDshWebOrigin,
  type ValidatedPairPane,
} from './pair-client.js';

const IFRAME_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-downloads';

export function buildPairPaneSrc(
  dshWebOrigin: string,
  shellOrigin: string,
  pane: ValidatedPairPane,
): string {
  const url = new URL('/', normalizeDshWebOrigin(dshWebOrigin, shellOrigin));
  url.searchParams.set('embedded', '1');
  url.searchParams.set('pairId', pane.pairId);
  url.searchParams.set('pane', pane.role);
  url.searchParams.set('session', pane.sessionId);
  url.searchParams.set('expectedSession', pane.sessionId);
  return url.href;
}

export interface PairPaneProps {
  readonly dshWebOrigin: string;
  readonly shellOrigin: string;
  readonly pane: ValidatedPairPane;
  readonly formSlot?: ReactNode;
}

export function PairPane({ dshWebOrigin, shellOrigin, pane, formSlot }: PairPaneProps) {
  const [loading, setLoading] = useState(true);
  const label = pane.role === 'navigator' ? 'Navigator' : 'Pilot';

  let src: string;
  try {
    src = buildPairPaneSrc(dshWebOrigin, shellOrigin, pane);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid DSH Web origin';
    return (
      <section className="pair-pane pair-pane--error" aria-labelledby={`${pane.role}-label`}>
        <h2 id={`${pane.role}-label`}>{label}</h2>
        <p role="alert">{message}</p>
      </section>
    );
  }

  return (
    <section className="pair-pane" aria-labelledby={`${pane.role}-label`}>
      <div className="pair-pane__titlebar">
        <div className="pair-pane__heading">
          <div>
            <p className="eyebrow">{pane.source}</p>
            <h2 id={`${pane.role}-label`}>{label}</h2>
          </div>
          <p className="pair-pane__boundary">
            Isolated native DSH session. Its transcript and composer stay inside this pane.
            Phase 0 should deploy DSH on a separate origin.
          </p>
        </div>
        {formSlot ? <div className="pair-pane__form-slot">{formSlot}</div> : null}
      </div>
      <div className="pair-pane__frame">
        {loading ? (
          <p
            className="pair-pane__loading"
            role="status"
            aria-live="polite"
            aria-label={`${label} session loading`}
          >
            Opening native DSH session…
          </p>
        ) : null}
        {/* allow-same-origin is needed by DSH; separate-origin deployment preserves the sandbox boundary. */}
        <iframe
          src={src}
          title={`${label} DSH session`}
          sandbox={IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
          onLoad={() => setLoading(false)}
        />
      </div>
    </section>
  );
}
