import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      include: ['scripts/tests/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    },
  },
]);
