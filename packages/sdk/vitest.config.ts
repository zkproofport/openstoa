import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Unit runs exclude e2e by default (see the `test` script). The e2e suite
    // hits a real container at E2E_BASE_URL (default http://localhost:3200).
    testTimeout: 60000,
    hookTimeout: 120000,
    sequence: { concurrent: false },
  },
});
