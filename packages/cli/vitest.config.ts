import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 120000,
    hookTimeout: 180000,
    sequence: { concurrent: false },
  },
});
