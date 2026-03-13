import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/e2e/**/*.test.ts'],
    globalSetup: ['src/__tests__/e2e/global-setup.ts'],
    setupFiles: ['src/__tests__/e2e/setup.ts'],
    testTimeout: 120000,
    hookTimeout: 180000,
    sequence: {
      concurrent: false,
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
