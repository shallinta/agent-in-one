import { describe, expect, test, vi } from 'vitest';

import {
  closeBestEffort,
  closeP05DevComposition,
  pairWebRuntimeDefines,
} from '../runtime-utils.js';

describe('Phase 0 runtime utilities', () => {
  test('injects Pair Web runtime origins without mutating process.env', () => {
    const before = { ...process.env };

    expect(pairWebRuntimeDefines('http://127.0.0.1:4100')).toEqual({
      'import.meta.env.VITE_DSH_WEB_ORIGIN': JSON.stringify('http://127.0.0.1:4100'),
      'import.meta.env.VITE_PAIR_API_BASE': JSON.stringify(''),
      'import.meta.env.VITE_PAIR_SHELL_ORIGIN': 'undefined',
    });
    expect(process.env).toEqual(before);
  });

  test('settles each cleanup in order and continues after failures', async () => {
    let announceFirst!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolveStarted) => {
      announceFirst = resolveStarted;
    });
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const events: string[] = [];
    const first = vi.fn(async () => {
      events.push('first:start');
      announceFirst();
      await firstGate;
      events.push('first:settled');
      throw new Error('first cleanup failed');
    });
    const second = vi.fn(async () => {
      events.push('second:settled');
    });
    const third = vi.fn(async () => {
      events.push('third:settled');
      throw new Error('third cleanup failed');
    });

    const cleanup = closeBestEffort('test cleanup', [first, second, third]);
    await firstStarted;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    expect(second).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
    releaseFirst();

    await expect(cleanup)
      .rejects.toMatchObject({
        name: 'AggregateError',
        message: 'test cleanup',
        errors: [expect.objectContaining({ message: 'first cleanup failed' }), expect.objectContaining({ message: 'third cleanup failed' })],
      });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
    expect(events).toEqual([
      'first:start',
      'first:settled',
      'second:settled',
      'third:settled',
    ]);
  });

  test('closes P0.5 composition in supervisor order and awaits Host final drain', async () => {
    let admissionOpen = true;
    let announceHostDrain!: () => void;
    let releaseHostDrain!: () => void;
    const hostDrainStarted = new Promise<void>((resolveStarted) => {
      announceHostDrain = resolveStarted;
    });
    const hostDrainGate = new Promise<void>((resolveGate) => {
      releaseHostDrain = resolveGate;
    });
    const events: string[] = [];
    const pairWeb = {
      close: vi.fn(async () => {
        events.push('pair-web:closed');
      }),
    };
    const pairHost = {
      close: vi.fn(async () => {
        admissionOpen = false;
        events.push('pair-host:closing');
        announceHostDrain();
        await hostDrainGate;
        events.push('pair-host:drained');
      }),
    };
    const hostedRuntime = {
      close: vi.fn(async () => {
        events.push('hosted-runtime:closed');
      }),
    };

    const closing = closeP05DevComposition({
      pairWeb,
      pairHost,
      hostedRuntime,
    });
    await hostDrainStarted;
    expect(admissionOpen).toBe(false);
    expect(events).toEqual(['pair-web:closed', 'pair-host:closing']);
    expect(hostedRuntime.close).not.toHaveBeenCalled();

    releaseHostDrain();
    await closing;
    expect(events).toEqual([
      'pair-web:closed',
      'pair-host:closing',
      'pair-host:drained',
      'hosted-runtime:closed',
    ]);
  });
});
