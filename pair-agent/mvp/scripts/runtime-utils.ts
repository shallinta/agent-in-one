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
