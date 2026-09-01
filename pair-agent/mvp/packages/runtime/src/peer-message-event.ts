import {
  canonicalJsonStringify,
  MAX_PAIR_MESSAGE_BYTES,
  MAX_PEER_HOPS,
  type PairEvent,
} from '@pair-agent/contracts';

export function isCanonicalDirectedPeerMessage(event: PairEvent): boolean {
  if (
    event.type !== 'agent.message' ||
    event.actor.kind !== 'agent' ||
    event.visibility !== 'shared'
  ) {
    return false;
  }
  const sender = event.actor.role;
  const receiver = sender === 'navigator' ? 'pilot' : 'navigator';
  const payload = event.payload;
  const sourceEventIds = event.refs.sourceEventIds;
  const sourceIdentity = sourceEventIds?.[0];
  const identityPrefix = `dsh:pair:${event.pairId}:${sender}:turn:`;
  const identitySuffix = ':peer-message';
  const turnText =
    typeof sourceIdentity === 'string' &&
    sourceIdentity.startsWith(identityPrefix) &&
    sourceIdentity.endsWith(identitySuffix)
      ? sourceIdentity.slice(identityPrefix.length, -identitySuffix.length)
      : '';
  return (
    event.source === `${sender}-session` &&
    event.authority === sender &&
    event.channel === receiver &&
    payload.schemaVersion === 1 &&
    payload.kind === 'peer-message' &&
    typeof payload.text === 'string' &&
    payload.text.trim().length > 0 &&
    Buffer.byteLength(payload.text, 'utf8') <= MAX_PAIR_MESSAGE_BYTES &&
    canonicalJsonStringify(payload.content) ===
      canonicalJsonStringify([{ type: 'text', text: payload.text }]) &&
    typeof payload.causalRootId === 'string' &&
    payload.causalRootId.length > 0 &&
    Number.isSafeInteger(payload.hop) &&
    (payload.hop as number) >= 1 &&
    (payload.hop as number) <= MAX_PEER_HOPS &&
    sourceEventIds?.length === 1 &&
    /^[1-9][0-9]*$/.test(turnText) &&
    Number.isSafeInteger(Number(turnText))
  );
}
