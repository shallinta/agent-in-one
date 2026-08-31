import {
  type JsonObject,
  type PairId,
  type PairRole,
  parsePairId,
} from '@pair-agent/contracts';

import { PairDerivedEventWriter } from './pair-derived-event-writer.js';
import {
  deriveDurableSessionGroups,
  type DerivedSessionGroup,
  type DshSessionEvent,
} from './session-event-derive.js';

export interface PairSessionBridgePort {
  onSessionEvent(
    listener: (sessionId: string, event: DshSessionEvent) => void,
  ): () => void;
  flushSession(sessionId: string): Promise<void>;
  readDurableFrom(
    sessionId: string,
    fromSeq: number,
  ): Promise<readonly DshSessionEvent[]>;
  whenAgentIdle(sessionId: string): Promise<void>;
}

interface SessionBinding {
  readonly pairId: PairId;
  readonly role: PairRole;
  readonly sessionId: string;
}

interface DrainState {
  nextSeq: number;
  pending: readonly DshSessionEvent[];
  dirty: boolean;
  active: boolean;
  running?: Promise<void>;
  fault?: BridgeFault;
}

export class BridgeFault extends Error {
  readonly pairId: PairId;
  readonly sessionId: string;

  constructor(pairId: PairId, sessionId: string, cause: unknown) {
    super(
      `Pair ${pairId} Session bridge failed for ${sessionId}: ${
        cause instanceof Error ? cause.message : 'unknown drain failure'
      }`,
      { cause },
    );
    this.name = 'BridgeFault';
    this.pairId = pairId;
    this.sessionId = sessionId;
  }
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function shouldDrain(event: DshSessionEvent): boolean {
  if (event.type === 'turn/end') return true;
  if (event.type !== 'user/message') return false;
  const data = plainObject(event.data);
  const source = plainObject(data?.source);
  if (source === undefined) return true;
  return (
    source.kind === 'user' ||
    (source.kind === 'plugin' && source.plugin === 'pair-agent:delivery')
  );
}

function assertContiguous(
  sessionId: string,
  fromSeq: number,
  events: readonly DshSessionEvent[],
): void {
  let expected = fromSeq;
  for (const event of events) {
    if (
      !Number.isSafeInteger(event.seq) ||
      event.seq !== expected ||
      !Number.isSafeInteger(event.time) ||
      event.time < 0
    ) {
      throw new Error(
        `Durable Session ${sessionId} is not contiguous at seq ${String(expected)}`,
      );
    }
    expected += 1;
  }
}

function pendingTail(events: readonly DshSessionEvent[]): readonly DshSessionEvent[] {
  let start = 0;
  for (let index = 0; index < events.length; index += 1) {
    if (events[index]?.type === 'turn/end') start = index + 1;
  }
  return structuredClone(events.slice(start));
}

function roleOrder(role: PairRole): number {
  return role === 'navigator' ? 0 : 1;
}

function sortGroups(groups: readonly DerivedSessionGroup[]): DerivedSessionGroup[] {
  return [...groups].sort(
    (left, right) =>
      left.time - right.time ||
      roleOrder(left.role) - roleOrder(right.role) ||
      left.sourceSessionSeq - right.sourceSessionSeq,
  );
}

export class SessionToPairBridge {
  readonly #bindings = new Map<string, SessionBinding>();
  readonly #state = new Map<string, DrainState>();
  readonly #off: () => void;
  #closing = false;

  constructor(
    private readonly port: PairSessionBridgePort,
    private readonly writer: PairDerivedEventWriter,
  ) {
    this.#off = port.onSessionEvent((sessionId, event) => {
      if (!shouldDrain(event)) return;
      this.markDirty(sessionId);
    });
  }

  bindSession(pairIdInput: string, role: PairRole, sessionId: string): void {
    if (this.#closing) throw new Error('Session-to-Pair Bridge is closing');
    const pairId = parsePairId(pairIdInput);
    const current = this.#bindings.get(sessionId);
    if (current !== undefined) {
      if (current.pairId !== pairId || current.role !== role) {
        throw new Error(`Session ${sessionId} is already bound to another Pair role`);
      }
      return;
    }
    if (
      [...this.#bindings.values()].some(
        (binding) => binding.pairId === pairId && binding.role === role,
      )
    ) {
      throw new Error(`Pair ${pairId} already has a ${role} Session binding`);
    }
    this.#bindings.set(sessionId, { pairId, role, sessionId });
    this.#state.set(sessionId, {
      nextSeq: 0,
      pending: [],
      dirty: false,
      active: false,
    });
  }

  unbindSession(sessionId: string): void {
    const state = this.#state.get(sessionId);
    if (state?.running !== undefined) {
      throw new Error(`Cannot unbind Session ${sessionId} while its drain is running`);
    }
    this.#state.delete(sessionId);
    this.#bindings.delete(sessionId);
  }

  markDirty(sessionId: string): void {
    const state = this.#state.get(sessionId);
    if (state === undefined || this.#closing) return;
    state.dirty = true;
    if (!state.active || state.running !== undefined) return;
    this.#startDrain(sessionId, state);
  }

  async catchUpPair(pairIdInput: string): Promise<void> {
    const pairId = parsePairId(pairIdInput);
    await this.#scanPair(pairId, false, true);
    await this.whenCaughtUp(this.#pairSessionIds(pairId));
  }

  async recoverPair(pairIdInput: string): Promise<void> {
    const pairId = parsePairId(pairIdInput);
    await this.#scanPair(pairId, true, true);
    await this.whenCaughtUp(this.#pairSessionIds(pairId));
  }

  async suspendPair(pairIdInput: string): Promise<void> {
    const pairId = parsePairId(pairIdInput);
    const states = [...this.#bindings.values()]
      .filter((binding) => binding.pairId === pairId)
      .map((binding) => this.#state.get(binding.sessionId)!);
    for (const state of states) state.active = false;
    await Promise.all(
      states.flatMap((state) =>
        state.running === undefined ? [] : [state.running],
      ),
    );
  }

  async drainDisposedPair(pairIdInput: string): Promise<void> {
    const pairId = parsePairId(pairIdInput);
    const bindingCount = [...this.#bindings.values()].filter(
      (binding) => binding.pairId === pairId,
    ).length;
    if (bindingCount !== 2) return;
    await this.#scanPair(pairId, false, false, false);
  }

  async #scanPair(
    pairId: PairId,
    fromStart: boolean,
    flush: boolean,
    reactivate = true,
  ): Promise<void> {
    const bindings = [...this.#bindings.values()].filter(
      (binding) => binding.pairId === pairId,
    );
    if (bindings.length !== 2) {
      throw new Error(`Pair ${pairId} requires two Bridge Session bindings`);
    }
    for (const binding of bindings) {
      const state = this.#state.get(binding.sessionId)!;
      state.active = false;
      state.dirty = false;
      if (fromStart) {
        state.nextSeq = 0;
        state.pending = [];
      }
    }
    await Promise.all(
      bindings.flatMap((binding) => {
        const running = this.#state.get(binding.sessionId)!.running;
        return running === undefined ? [] : [running];
      }),
    );

    try {
      const existingPairEvents = await this.writer.readPairEvents(pairId);
      const scans = await Promise.all(
        bindings.map(async (binding) => {
          const state = this.#state.get(binding.sessionId)!;
          if (flush) await this.port.flushSession(binding.sessionId);
          const suffix = await this.port.readDurableFrom(
            binding.sessionId,
            state.nextSeq,
          );
          assertContiguous(binding.sessionId, state.nextSeq, suffix);
          const combined = [...state.pending, ...suffix];
          return {
            binding,
            state,
            suffix,
            combined,
            groups: deriveDurableSessionGroups({
              pairId,
              role: binding.role,
              sessionId: binding.sessionId,
              events: combined,
              existingPairEvents,
            }),
          };
        }),
      );
      for (const group of sortGroups(scans.flatMap((scan) => scan.groups))) {
        await this.writer.appendGroup(pairId, group.records);
      }
      for (const scan of scans) {
        scan.state.nextSeq =
          scan.suffix.length === 0
            ? scan.state.nextSeq
            : scan.suffix.at(-1)!.seq + 1;
        scan.state.pending = pendingTail(scan.combined);
        scan.state.fault = undefined;
        scan.state.active = reactivate;
      }
    } catch (error) {
      for (const binding of bindings) {
        const state = this.#state.get(binding.sessionId)!;
        state.fault = new BridgeFault(pairId, binding.sessionId, error);
      }
      throw error instanceof BridgeFault
        ? error
        : new BridgeFault(pairId, bindings[0]!.sessionId, error);
    } finally {
      for (const binding of bindings) {
        const state = this.#state.get(binding.sessionId)!;
        if (state.active && state.dirty && state.running === undefined) {
          this.#startDrain(binding.sessionId, state);
        }
      }
    }
  }

  async whenCaughtUp(sessionIds?: readonly string[]): Promise<void> {
    const ids = sessionIds ?? [...this.#state.keys()];
    for (;;) {
      const running = ids.flatMap((sessionId) => {
        const promise = this.#state.get(sessionId)?.running;
        return promise === undefined ? [] : [promise];
      });
      if (running.length === 0) break;
      await Promise.all(running);
      await Promise.resolve();
    }
    for (const sessionId of ids) {
      const fault = this.#state.get(sessionId)?.fault;
      if (fault !== undefined) throw fault;
    }
  }

  assertHealthy(pairIdInput: string): void {
    const pairId = parsePairId(pairIdInput);
    for (const binding of this.#bindings.values()) {
      if (binding.pairId !== pairId) continue;
      const fault = this.#state.get(binding.sessionId)?.fault;
      if (fault !== undefined) throw fault;
    }
  }

  async drainPair(pairIdInput: string): Promise<void> {
    const pairId = parsePairId(pairIdInput);
    const sessionIds = this.#pairSessionIds(pairId);
    for (const sessionId of sessionIds) this.markDirty(sessionId);
    await this.whenCaughtUp(sessionIds);
  }

  #pairSessionIds(pairId: PairId): string[] {
    return [...this.#bindings.values()]
      .filter((binding) => binding.pairId === pairId)
      .map((binding) => binding.sessionId);
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    try {
      await this.whenCaughtUp();
      this.#off();
      this.#bindings.clear();
      this.#state.clear();
    } catch (error) {
      this.#closing = false;
      throw error;
    }
  }

  #startDrain(sessionId: string, state: DrainState): void {
    let running!: Promise<void>;
    running = Promise.resolve()
      .then(() => this.#drainLoop(sessionId, state))
      .catch((error: unknown) => {
        const binding = this.#bindings.get(sessionId);
        if (binding !== undefined) {
          state.fault = new BridgeFault(binding.pairId, sessionId, error);
        }
        throw state.fault ?? error;
      })
      .finally(() => {
        if (state.running === running) state.running = undefined;
        if (state.dirty && state.active && !this.#closing) {
          this.#startDrain(sessionId, state);
        }
      });
    state.running = running;
    // Hook observers are fire-and-forget. Attach a rejection observer here so
    // failures remain Bridge health state rather than unhandled rejections.
    void running.catch(() => undefined);
  }

  async #drainLoop(sessionId: string, state: DrainState): Promise<void> {
    const binding = this.#bindings.get(sessionId);
    if (binding === undefined) return;
    while (state.dirty && !this.#closing) {
      state.dirty = false;
      await this.port.flushSession(sessionId);
      const suffix = await this.port.readDurableFrom(sessionId, state.nextSeq);
      assertContiguous(sessionId, state.nextSeq, suffix);
      const combined = [...state.pending, ...suffix];
      const existingPairEvents = await this.writer.readPairEvents(binding.pairId);
      const groups = deriveDurableSessionGroups({
        pairId: binding.pairId,
        role: binding.role,
        sessionId,
        events: combined,
        existingPairEvents,
      });
      for (const group of groups) {
        await this.writer.appendGroup(binding.pairId, group.records);
      }
      state.nextSeq =
        suffix.length === 0 ? state.nextSeq : suffix.at(-1)!.seq + 1;
      state.pending = pendingTail(combined);
      state.fault = undefined;
    }
  }
}
