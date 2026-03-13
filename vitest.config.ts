import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./src/__tests__/e2e/global-setup.ts'],
    setupFiles: ['./src/__tests__/e2e/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
