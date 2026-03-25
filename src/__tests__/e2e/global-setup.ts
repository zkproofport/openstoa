import { resolve } from 'path';
import { writeFileSync } from 'fs';
import { config } from 'dotenv';

const CACHE_FILE = resolve(__dirname, '../../../.e2e-token-cache.json');

export async function setup() {
  config({ path: resolve(__dirname, '../../../.env.test') });

  const baseUrl = process.env.E2E_BASE_URL;
  if (!baseUrl) throw new Error('E2E_BASE_URL is required in .env.test');

  console.log(`[E2E Setup] Base URL: ${baseUrl}`);

  // If E2E_AUTH_TOKEN already set (e.g. from .env.test), skip dev-login
  if (process.env.E2E_AUTH_TOKEN) {
    console.log('[E2E Setup] E2E_AUTH_TOKEN already set, skipping dev-login');
    return;
  }

  // Auto-login via dev-login endpoint (non-production only)
  console.log('[E2E Setup] Performing dev-login for User A...');
  const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: `e2e_user_${Date.now().toString(36)}` }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`dev-login failed: ${res.status} ${err}`);
  }

  const data = await res.json();
  process.env.E2E_AUTH_TOKEN = data.token;
  process.env.E2E_USER_ID = data.userId;
  process.env.E2E_NICKNAME = data.nickname;

  // Write cache file for vitest worker processes (setup.ts reads this)
  writeFileSync(CACHE_FILE, JSON.stringify({
    token: data.token,
    userId: data.userId,
    nickname: data.nickname,
  }));

  console.log(`[E2E Setup] User A logged in: ${data.nickname} (${data.userId.slice(0, 10)}...)`);
}
