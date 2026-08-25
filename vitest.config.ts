import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Default (unit/integration) config. It deliberately EXCLUDES the e2e suite and
// does NOT pull in the e2e global-setup: unit tests run against local Postgres/
// Redis and must never depend on a deployed environment or a staging dev-login.
// Run the e2e suite separately with `vitest.config.e2e.ts` (npm run test:e2e*),
// which selects its target via E2E_BASE_URL (local or staging).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    // A page-lifetime cache must not span test files — see the file's own note.
    setupFiles: ['./src/__tests__/setup/resetClientCaches.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/__tests__/e2e/**',
      /*
       * The mini-app's RENDERED tests run under `packages/mobile/vitest.config.ts`,
       * which aliases `react-native` to a thin stand-in and borrows the host
       * app's `react-test-renderer`. Those aliases must not apply here — this
       * config compiles the web app, where `react-native` means nothing — so
       * the component tests are excluded and the logic tests still run.
       */
      'packages/mobile/**/*.test.tsx',
      'packages/mobile/src/__tests__/harness/**',
      'src/__tests__/setup/**',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      /*
       * The workspace package is not installed into `node_modules`, so a BARE
       * specifier only resolves where something maps it — the mini-app's own
       * config does, this one did not.
       *
       * It went unnoticed because `import type` is erased before the module
       * ever loads: every mini-app file that named this package did so for
       * types only, and the `.tsx` files that import VALUES from it are
       * excluded above. The first `.ts` file to import a value — the MLS
       * transport, for the undecryptable-body sentinel — failed to load here
       * and took fifteen unrelated tests with it, none of which named the
       * cause. Aliased to the same source file the mini-app config points at.
       */
      '@openstoa/api-types': path.resolve(__dirname, './packages/api-types/src/index.ts'),
    },
  },
});
