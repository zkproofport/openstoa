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
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/__tests__/e2e/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
