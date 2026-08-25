/**
 * S-2 — a signature-valid JWT (or API key) naming a `users` row that no
 * longer exists must answer a clean 401 (or authenticated=false, per route),
 * never a raw Postgres FK-violation 500 with driver internals in the body.
 *
 * Reproduces the exact staging incident end-to-end, over real HTTP against a
 * real container: `POST /api/auth/dev-login` mints a real 7-day JWT, the
 * row that JWT names is then hard-deleted directly in Postgres (simulating
 * the staging truncation), and the SAME still-unexpired token is replayed
 * against a route whose insert names the FK that actually violated
 * (`topics.creator_id -> users.id`, see POST /api/topics).
 *
 * Gated on DATABASE_URL: the app itself has no path that hard-deletes a
 * `users` row — DELETE /api/account anonymizes + sets deletedAt but keeps
 * the row (see src/app/api/account/route.ts) — so reproducing "row
 * physically gone" needs a direct DB statement, the same way
 * topic-crud.test.ts's admin-grant cases need one. Skips cleanly (never
 * silently — see db-helpers.ts's envGate/announceEnvGates) when
 * DATABASE_URL is unset.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { E2E_DEVICE_HEADERS } from './helpers';
import { Client } from 'pg';
import { getBaseUrl, fetchCategorySlugs } from './helpers';
import { envGate, announceEnvGates } from './db-helpers';

const DB_URL = process.env.DATABASE_URL ?? null;

async function devLogin(prefix: string): Promise<{ token: string; userId: string }> {
  const nickname = `e2e_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const res = await fetch(`${getBaseUrl()}/api/auth/dev-login`, {
    method: 'POST',
    // The suite stands in for the mobile app; a login that declares nothing
    // defaults to `web`, and chat / MLS / TAK are refused to a web session.
    headers: { 'Content-Type': 'application/json', ...E2E_DEVICE_HEADERS },
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function bearer(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

/**
 * Hard-delete a `users` row directly — the app itself has no path to do this.
 *
 * A freshly dev-logged-in account is no longer empty: it is created with its
 * own personal space, which means a membership row and a topic row that both
 * point at it. A bare `DELETE FROM users` therefore fails on the membership
 * foreign key, and it fails BEFORE any of the assertions below run — the
 * failure looks like the product broke when in fact the fixture's assumption
 * expired.
 *
 * The rows are removed in reference order, which is also the only order a real
 * hard delete could use. What is being simulated is unchanged: a session whose
 * subject no longer exists.
 */
async function hardDeleteUser(userId: string): Promise<void> {
  if (!DB_URL) throw new Error('hardDeleteUser requires DATABASE_URL');
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query(`DELETE FROM topic_members WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM topics WHERE creator_id = $1 AND personal`, [userId]);
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
  } finally {
    await client.end();
  }
}

async function createTopic(token: string, categoryId: string, title: string): Promise<Response> {
  return fetch(`${getBaseUrl()}/api/topics`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ title, categoryId }),
  });
}

// Substrings that would only appear if a raw driver/DB error leaked into a
// JSON response body — mirrors the exact shape of the incident's original
// 500 ("insert or update on table \"topics\" violates foreign key
// constraint \"topics_creator_id_users_id_fk\"").
const DRIVER_LEAK_PATTERNS = [/violates/i, /foreign key/i, /constraint "/i, /relation "/i, /column "/i, /_fk"/];

function assertNoDriverText(body: unknown): void {
  const text = JSON.stringify(body);
  for (const pattern of DRIVER_LEAK_PATTERNS) {
    expect(text).not.toMatch(pattern);
  }
}

describe.sequential('Deleted-user session (S-2)', () => {
  beforeAll(() => {
    // See db-helpers.ts: collection-time console output isn't reliably
    // surfaced by vitest's reporter, so the warning is printed from a hook —
    // the counting itself already happened at collection time, in the
    // it.skipIf(envGate(...)) calls below.
    announceEnvGates('deleted-user-session.test.ts');
  });

  it.skipIf(envGate('DATABASE_URL'))(
    'reproduces the staging incident: POST /api/topics with a JWT for a hard-deleted user gets a clean 401, not a raw FK-violation 500',
    async () => {
      const [{ token, userId }, categories] = await Promise.all([devLogin('s2victim'), fetchCategorySlugs()]);
      expect(categories.length).toBeGreaterThan(0);

      await hardDeleteUser(userId);

      const res = await createTopic(token, categories[0].id, `e2e-s2-${Date.now()}`);

      expect(res.status).toBe(401);
      const body = await res.json();
      // Same flat shape every other unauthenticated hit on this route gets —
      // a deleted-user session must be indistinguishable from "no session".
      expect(body).toEqual({ error: 'Not authenticated' });
      assertNoDriverText(body);
    },
  );

  it.skipIf(envGate('DATABASE_URL'))(
    'result integrity: GET /api/auth/session degrades the same way — authenticated=false, still 200, never 500',
    async () => {
      const { token, userId } = await devLogin('s2session');
      await hardDeleteUser(userId);

      const res = await fetch(`${getBaseUrl()}/api/auth/session`, { headers: bearer(token) });
      // This route's own contract is "NEVER returns 401" — a deleted-user
      // session must fall into its existing guest branch, not a new 500.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ authenticated: false });
      assertNoDriverText(body);
    },
  );

  it.skipIf(envGate('DATABASE_URL'))(
    'authorization: an ordinary (never-deleted) session is unaffected — POST /api/topics still succeeds',
    async () => {
      const [{ token }, categories] = await Promise.all([devLogin('s2control'), fetchCategorySlugs()]);
      const res = await createTopic(token, categories[0].id, `e2e-s2-control-${Date.now()}`);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.topic?.id).toBeTruthy();
    },
  );

  it.skipIf(envGate('DATABASE_URL'))(
    'boundary: a token naming a still-live user is unaffected by a DIFFERENT user being deleted (lookup is scoped to the token\'s OWN subject)',
    async () => {
      const [victim, bystander, categories] = await Promise.all([
        devLogin('s2victimB'),
        devLogin('s2bystander'),
        fetchCategorySlugs(),
      ]);
      await hardDeleteUser(victim.userId);

      const res = await createTopic(bystander.token, categories[0].id, `e2e-s2-bystander-${Date.now()}`);
      expect(res.status).toBe(201);
    },
  );

  it.skipIf(envGate('DATABASE_URL'))(
    'authorization: API-key auth for a deleted user keeps its existing (already-correct) 401-equivalent behavior, unchanged by this fix',
    async () => {
      const { token, userId } = await devLogin('s2apikey');
      const keyRes = await fetch(`${getBaseUrl()}/api/profile/api-keys`, {
        method: 'POST',
        headers: bearer(token),
        body: JSON.stringify({ name: 'e2e-s2-key', cmd: [], historyGrant: 'none' }),
      });
      expect(keyRes.status).toBe(201);
      const { rawKey } = (await keyRes.json()) as { rawKey: string };

      await hardDeleteUser(userId);

      const res = await fetch(`${getBaseUrl()}/api/auth/session`, {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ authenticated: false });
    },
  );
});
