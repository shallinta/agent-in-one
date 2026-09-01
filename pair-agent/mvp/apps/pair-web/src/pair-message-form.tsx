import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PairRole } from '@pair-agent/contracts';

import { LedgerConflictError, sendPairMessage } from './pair-client.js';

export interface PairMessageFormProps {
  readonly apiBase: string;
  readonly pairId: string;
  readonly role: PairRole;
  readonly ledgerHead: number;
  readonly fetcher: typeof fetch;
}

type Outcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'delivered'; readonly message: string }
  | { readonly kind: 'conflict'; readonly actualLedgerHead: number }
  | { readonly kind: 'unknown' };

export function PairMessageForm({
  apiBase,
  pairId,
  role,
  ledgerHead,
  fetcher,
}: PairMessageFormProps) {
  const [draft, setDraft] = useState('');
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const requestRef = useRef<AbortController>();

  useEffect(() => {
    requestRef.current?.abort();
    setDraft('');
    setOutcome({ kind: 'idle' });
    return () => requestRef.current?.abort();
  }, [pairId, role]);

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (text === '' || outcome.kind === 'sending') return;
    const controller = new AbortController();
    requestRef.current = controller;
    setOutcome({ kind: 'sending' });
    try {
      const result = await sendPairMessage(
        fetcher,
        apiBase,
        pairId,
        role,
        { text, expectedLedgerHead: ledgerHead },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setDraft('');
      setOutcome({
        kind: 'delivered',
        message:
          result.delivery === 'pending'
            ? 'Saved, awaiting delivery.'
            : 'Message delivered.',
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof LedgerConflictError) {
        setOutcome({ kind: 'conflict', actualLedgerHead: error.actualLedgerHead });
      } else {
        setOutcome({ kind: 'unknown' });
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = undefined;
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submit();
  };

  const awaitingHead =
    outcome.kind === 'conflict' && ledgerHead < outcome.actualLedgerHead;
  const canRetry =
    outcome.kind === 'conflict' && ledgerHead >= outcome.actualLedgerHead;

  return (
    <form className="pair-message-form" onSubmit={onSubmit}>
      <label htmlFor={`${role}-pair-message`}>Message {role}</label>
      <div className="pair-message-form__controls">
        <textarea
          id={`${role}-pair-message`}
          rows={2}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (
              outcome.kind !== 'sending' &&
              outcome.kind !== 'conflict'
            ) {
              setOutcome({ kind: 'idle' });
            }
          }}
        />
        <button
          type="submit"
          disabled={draft.trim() === '' || outcome.kind === 'sending' || awaitingHead || canRetry}
          aria-label={`Send to ${role}`}
        >
          {outcome.kind === 'sending' ? 'Sending…' : 'Send'}
        </button>
      </div>
      {outcome.kind === 'delivered' ? (
        <p className="pair-message-form__outcome" role="status" aria-live="polite">
          {outcome.message}
        </p>
      ) : null}
      {awaitingHead ? (
        <p className="pair-message-form__outcome" role="status" aria-live="polite">
          Waiting for Projection head {outcome.actualLedgerHead} before retry.
        </p>
      ) : null}
      {canRetry ? (
        <div className="pair-message-form__retry">
          <p className="pair-message-form__outcome" role="status">
            Projection refreshed. Review the draft and retry explicitly.
          </p>
          <button
            type="button"
            disabled={draft.trim() === ''}
            onClick={() => void submit()}
            aria-label={`Retry ${role} message`}
          >
            Retry
          </button>
        </div>
      ) : null}
      {outcome.kind === 'unknown' ? (
        <p className="pair-message-form__outcome pair-message-form__outcome--error" role="alert">
          Outcome unknown. Inspect Session Events before deciding whether to retry.
        </p>
      ) : null}
    </form>
  );
}
