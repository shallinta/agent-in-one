import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

import { normalizeDshWebOrigin, normalizeShellOrigin } from './src/origin.js';

export default defineConfig(({ mode }) => {
  if (mode === 'production') {
    const env = loadEnv(mode, process.cwd(), '');
    const shellOrigin = normalizeShellOrigin(env.VITE_PAIR_SHELL_ORIGIN, '');
    normalizeDshWebOrigin(env.VITE_DSH_WEB_ORIGIN, shellOrigin);
  }

  return {
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: 'index.html',
          pair: 'pair.html',
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: './tests/setup.ts',
      restoreMocks: true,
    },
  };
});
