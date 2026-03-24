import { resolve } from 'path';
import { config } from 'dotenv';

export async function setup() {
  // Load .env.test only — login is handled by individual test files
  config({ path: resolve(__dirname, '../../../.env.test') });

  const baseUrl = process.env.E2E_BASE_URL;
  if (!baseUrl) throw new Error('E2E_BASE_URL is required in .env.test');

  console.log(`[E2E Setup] Base URL: ${baseUrl}`);
  console.log('[E2E Setup] Login is handled by test files (not global-setup)');
}
