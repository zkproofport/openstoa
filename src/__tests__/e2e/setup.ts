import { config } from 'dotenv';
import { resolve } from 'path';
import { readFileSync, existsSync } from 'fs';

// Load .env.test
config({ path: resolve(__dirname, '../../../.env.test') });

// Load cached token if env vars not set (global-setup sets them in same process,
// but vitest may fork workers — so read from cache file as fallback)
const CACHE_FILE = resolve(__dirname, '../../../.e2e-token-cache.json');

if (!process.env.E2E_AUTH_TOKEN && existsSync(CACHE_FILE)) {
  try {
    const cached = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    process.env.E2E_AUTH_TOKEN = cached.token;
    process.env.E2E_USER_ID = cached.userId;
    process.env.E2E_NICKNAME = cached.nickname;
  } catch {
    // ignore
  }
}
