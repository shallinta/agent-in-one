import {
  isCompletionHandoffAgentMessage,
  MAX_PEER_HOPS,
  type PairEvent,
  type PairId,
} from '@pair-agent/contracts';

import { isCanonicalDirectedPeerMessage } from './peer-message-event.js';

export interface CanonicalDirectedCausality {
  readonly causalRootId: string;
  readonly hop: number;
}

export class CanonicalDirectedCausalityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalDirectedCausalityError';
  }
}

export function isCanonicalDirectedAgentMessage(event: PairEvent): boolean {
  return (
    isCanonicalDirectedPeerMessage(event) ||
    isCompletionHandoffAgentMessage(event)
  );
}

export function deriveCanonicalDirectedCausality(
  pairId: PairId,
  inputEvents: readonly PairEvent[],
): CanonicalDirectedCausality {
  if (inputEvents.length === 0) {
    throw new CanonicalDirectedCausalityError(
      'Directed message requires durable current-Turn input provenance',
    );
  }
  if (inputEvents.some((event) => event.pairId !== pairId)) {
    throw new CanonicalDirectedCausalityError(
      'Directed message input provenance crosses Pair identity',
    );
  }

  const directedInputs = inputEvents.filter(isCanonicalDirectedAgentMessage);
  if (directedInputs.length > 0) {
    if (directedInputs.length !== inputEvents.length) {
      throw new CanonicalDirectedCausalityError(
        'Directed message input provenance mixes roots and directed messages',
      );
    }
    const roots = new Set(
      directedInputs.map((event) => event.payload.causalRootId as string),
    );
    if (roots.size !== 1) {
      throw new CanonicalDirectedCausalityError(
        'One sender Turn cannot combine multiple directed causal roots',
      );
    }
    const hop = Math.max(
      ...directedInputs.map((event) => event.payload.hop as number),
    ) + 1;
    if (hop > MAX_PEER_HOPS) {
      throw new CanonicalDirectedCausalityError(
        `Directed message hop ${String(hop)} exceeds the limit ${MAX_PEER_HOPS}`,
      );
    }
    return { causalRootId: [...roots][0]!, hop };
  }

  const roots = inputEvents.filter(
    (event) => event.type === 'user.message' || event.type === 'task.assigned',
  );
  if (roots.length !== 1 || roots.length !== inputEvents.length) {
    throw new CanonicalDirectedCausalityError(
      'Directed message requires exactly one user or Task input root',
    );
  }
  return {
    causalRootId: `${roots[0]!.pairId}:${String(roots[0]!.seq)}`,
    hop: 1,
  };
}
