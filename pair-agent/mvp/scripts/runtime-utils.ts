export function pairWebRuntimeDefines(dshOrigin: string): Record<string, string> {
  return {
    'import.meta.env.VITE_DSH_WEB_ORIGIN': JSON.stringify(dshOrigin),
    'import.meta.env.VITE_PAIR_API_BASE': JSON.stringify(''),
    'import.meta.env.VITE_PAIR_SHELL_ORIGIN': 'undefined',
  };
}

export async function closeBestEffort(
  label: string,
  operations: readonly (() => Promise<unknown> | unknown)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, label);
}

interface CloseableRuntime {
  close(): Promise<unknown> | unknown;
}

export interface P05DevComposition {
  readonly pairWeb?: CloseableRuntime;
  readonly pairHost?: CloseableRuntime;
  readonly hostedRuntime?: CloseableRuntime;
}

export function closeP05DevComposition(
  resources: P05DevComposition,
): Promise<void> {
  return closeBestEffort('P0.5 shutdown failed', [
    async () => resources.pairWeb?.close(),
    async () => resources.pairHost?.close(),
    async () => resources.hostedRuntime?.close(),
  ]);
}
