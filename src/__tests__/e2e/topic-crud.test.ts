import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from 'pg';
import {
  authPost,
  authGet,
  authPatch,
  publicGet,
  publicPost,
  publicPatch,
  secondUserPost,
  secondUserPatch,
  getSecondUserToken,
  getBaseUrl,
} from './helpers';
import { envGate, announceEnvGates } from './db-helpers';

// Local-only DB handle for cases 13/14 below: promoting a purpose-made test
// user to role='admin' so the real admin-only blind endpoint can be exercised
// over HTTP. Gated the same way tak-archive.test.ts / chat-delivery-purge.test.ts
// gate their direct-DB cases — when DATABASE_URL is unavailable (e.g. against a
// remote deployment with no direct DB access) these two cases skip cleanly
// instead of exploding. The skip is not silent: envGate()/announceEnvGates()
// below print exactly how many cases it disabled, once, at the end of this
// file's run (see db-helpers.ts for why a skipped case must never look like a
// passing one in the summary line).
const DB_URL = process.env.DATABASE_URL ?? null;

/** Mint a fresh, never-joined user for the admin-grant cases below. */
async function freshUser(): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${getBaseUrl()}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: `e2e_topiccrud_admin_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Run `fn` with a FRESH user promoted to role='admin' for the duration, then
 * demote it back to 'user' no matter what `fn` does — a test that leaves an
 * admin behind in a shared local database is worse than a skipped test. Each
 * call mints its own user and its own grant/revoke cycle rather than sharing
 * state across cases, so a failure in one case cannot strand the other admin.
 */
async function withAdmin<T>(fn: (adminToken: string) => Promise<T>): Promise<T> {
  if (!DB_URL) throw new Error('withAdmin requires DATABASE_URL');
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const candidate = await freshUser();
    await client.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [candidate.userId]);
    try {
      return await fn(candidate.token);
    } finally {
      await client.query(`UPDATE users SET role = 'user' WHERE id = $1`, [candidate.userId]);
    }
  } finally {
    await client.end();
  }
}

function adminFetch(token: string, path: string): Promise<Response> {
  return fetch(`${getBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
}

let categoryId: string;
let publicTopicId: string;
let originalTitle: string;
let originalDescription: string;

describe.sequential('Topic CRUD + Permission + Blind', () => {
  beforeAll(() => {
    // See db-helpers.ts: console output at module-collection time is not
    // reliably surfaced by vitest's reporter, so the warning is printed from
    // a hook instead — the counting itself already happened at collection
    // time, in the it.skipIf(envGate(...)) calls below.
    announceEnvGates('topic-crud.test.ts');
  });

  // ── Setup ──────────────────────────────────────────────────────────────

  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.categories)).toBe(true);
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('setup: User A creates a public topic (becomes owner)', async () => {
    originalTitle = `E2E Topic CRUD ${Date.now()}`;
    originalDescription = 'Public topic for topic CRUD + blind tests';
    const res = await authPost('/api/topics', {
      title: originalTitle,
      description: originalDescription,
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.topic.id).toBeTruthy();
    publicTopicId = json.topic.id;
  });

  it('setup: ensure User B exists', async () => {
    const { token, userId } = await getSecondUserToken();
    expect(token).toBeTruthy();
    expect(userId).toBeTruthy();
  });

  // ── Topic Create Validation ─────────────────────────────────────────

  it('1. Create topic missing required field (no title) -> 400', async () => {
    const res = await authPost('/api/topics', {
      categoryId,
      visibility: 'public',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('2. Create topic missing required field (no categoryId) -> 400', async () => {
    const res = await authPost('/api/topics', {
      title: 'Missing categoryId topic',
      visibility: 'public',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('3. Create topic with invalid categoryId -> 400', async () => {
    const res = await authPost('/api/topics', {
      title: 'Invalid category topic',
      categoryId: '00000000-0000-0000-0000-000000000000',
      visibility: 'public',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Topic Edit ──────────────────────────────────────────────────────

  it('3b. Create topic: a NUL byte in title or description is rejected with a clean 400 (Postgres text cannot store it)', async () => {
    const NUL = String.fromCharCode(0);
    const withNulTitle = await authPost('/api/topics', {
      title: `bad${NUL}title`,
      categoryId,
      visibility: 'public',
    });
    expect(withNulTitle.status).toBe(400);
    const titleJson = await withNulTitle.json();
    expect(titleJson.error).toBe('Title must not contain a NUL byte');

    const withNulDescription = await authPost('/api/topics', {
      title: `E2E NUL description ${Date.now()}`,
      description: `bad${NUL}description`,
      categoryId,
      visibility: 'public',
    });
    expect(withNulDescription.status).toBe(400);
    const descJson = await withNulDescription.json();
    expect(descJson.error).toBe('Description must not contain a NUL byte');
  });

  it('4. Owner edits topic title and description -> 200', async () => {
    const updatedTitle = `E2E Topic Updated ${Date.now()}`;
    const updatedDescription = 'Updated description by owner';
    const res = await authPatch(`/api/topics/${publicTopicId}`, {
      title: updatedTitle,
      description: updatedDescription,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.topic).toBeDefined();
    expect(json.topic.title).toBe(updatedTitle);
    expect(json.topic.description).toBe(updatedDescription);

    // Verify changes persisted via GET
    const getRes = await authGet(`/api/topics/${publicTopicId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    const topic = getJson.topic || getJson;
    expect(topic.title).toBe(updatedTitle);
    expect(topic.description).toBe(updatedDescription);
  });

  it('5. Non-owner edits topic -> 403', async () => {
    const res = await secondUserPatch(`/api/topics/${publicTopicId}`, {
      title: 'Attempted hijack by non-owner',
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('6. Guest (unauthenticated) edits topic -> 401', async () => {
    const res = await publicPatch(`/api/topics/${publicTopicId}`, {
      title: 'Attempted hijack by guest',
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('7. Edit topic with empty body -> 400', async () => {
    const res = await authPatch(`/api/topics/${publicTopicId}`, {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('7b. Edit topic: a NUL byte in title or description is rejected with a clean 400', async () => {
    const NUL = String.fromCharCode(0);
    const withNulTitle = await authPatch(`/api/topics/${publicTopicId}`, { title: `bad${NUL}title` });
    expect(withNulTitle.status).toBe(400);
    expect((await withNulTitle.json()).error).toBe('Title must not contain a NUL byte');

    const withNulDescription = await authPatch(`/api/topics/${publicTopicId}`, { description: `bad${NUL}description` });
    expect(withNulDescription.status).toBe(400);
    expect((await withNulDescription.json()).error).toBe('Description must not contain a NUL byte');
  });

  // ── Topic Detail ────────────────────────────────────────────────────

  it('8. Topic detail returns memberCount, category, and proofType', async () => {
    const res = await authGet(`/api/topics/${publicTopicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topic = json.topic || json;

    expect(topic.id).toBe(publicTopicId);
    expect(typeof topic.memberCount).toBe('number');
    expect(topic.memberCount).toBeGreaterThanOrEqual(1); // at least the owner
    expect(topic.category).toBeDefined();
    // proofType can be null for open topics, but the field should exist
    expect('proofType' in topic).toBe(true);
  });

  it('9. Non-member can view public topic detail', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topic = json.topic || json;
    expect(topic.id).toBe(publicTopicId);
    expect(topic.title).toBeTruthy();
    expect(topic.category).toBeDefined();
  });

  // ── Topic Blind ─────────────────────────────────────────────────────

  it('10. Owner cannot blind topic (admin-only) -> 403', async () => {
    const res = await authPost(`/api/topics/${publicTopicId}/blind`);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('11. Non-owner cannot blind topic -> 403', async () => {
    const res = await secondUserPost(`/api/topics/${publicTopicId}/blind`);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('12. Guest (unauthenticated) blinds topic -> 401', async () => {
    const res = await publicPost(`/api/topics/${publicTopicId}/blind`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Cases 13/14: site-admin actions ──────────────────────────────────
  //
  // `/api/topics/{id}/blind` looks the caller up in `users` and requires
  // `user.role === 'admin'` (src/app/api/topics/[topicId]/blind/route.ts:41)
  // — it reads the DB row, not the session, so the credential type doesn't
  // matter, only the row does. An API key CANNOT confer admin (`getApiKeySession`
  // in src/lib/session.ts resolves a key to its owner's userId, so a key is
  // exactly as admin as its owner and no more), and `/api/auth/dev-login` only
  // ever inserts a default-role user.
  //
  // These two cases used to be permanently skipped because the only path to
  // an admin row was a since-deleted Google OAuth proof login + a manual grant.
  // That reasoning is stale: `DATABASE_URL` now points at the local Postgres
  // this container itself uses (`.env.test.local`, added after these cases
  // were written), so a case can promote a purpose-made user to role='admin'
  // for itself and revoke the grant when it's done — see `withAdmin` above,
  // which mints a FRESH dev-login user per call and demotes it back to 'user'
  // in a `finally` no matter what happens in between (a test that leaves an
  // admin behind in a shared local database is worse than a skipped test).
  // Gated on `DATABASE_URL` the same way tak-archive.test.ts /
  // chat-delivery-purge.test.ts gate their direct-DB cases, so these skip
  // cleanly rather than exploding against a remote deployment with no direct
  // DB access.
  //
  // Non-admin refusal is ALREADY covered by cases 10/11/12 above (owner,
  // unrelated authenticated user, and guest all get refused) — blind doesn't
  // check topic membership at all, only `users.role`, so there is no further
  // "member vs non-member" axis to add here.
  it.skipIf(envGate('DATABASE_URL'))('13. Admin blinds topic -> 200', async () => {
    await withAdmin(async (adminToken) => {
      const res = await adminFetch(adminToken, `/api/topics/${publicTopicId}/blind`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.blinded).toBe(true);
      expect(json.blindedBy).toBe('admin');
    });
  });

  it.skipIf(envGate('DATABASE_URL'))('14. Blinded topic excluded from topic list, then admin unblinds it', async () => {
    // Case 13 left the topic blinded (its grant/revoke cycle only touches the
    // admin ROLE, never the blind state) — this proves the actual product
    // behavior the blind exists for: a blinded topic disappears from the
    // public listing, not merely that the toggle call itself returned 200.
    const listRes = await publicGet('/api/topics?view=all');
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    const topics = listJson.topics || listJson;
    expect(Array.isArray(topics)).toBe(true);

    const found = topics.find((t: { id: string }) => t.id === publicTopicId);
    expect(found).toBeUndefined();

    // Clean up: a FRESH admin grant (case 13 already revoked its own) unblinds
    // the topic so later cases in this file still see it in listings.
    await withAdmin(async (adminToken) => {
      const unblindRes = await adminFetch(adminToken, `/api/topics/${publicTopicId}/blind`);
      expect(unblindRes.status).toBe(200);
      const unblindJson = await unblindRes.json();
      expect(unblindJson.blinded).toBe(false);
      expect(unblindJson.blindedBy).toBeNull();
    });

    // And the unblind is real, not just the response body's word for it: the
    // topic is visible in the listing again.
    const afterRes = await publicGet('/api/topics?view=all');
    expect(afterRes.status).toBe(200);
    const afterJson = await afterRes.json();
    const afterTopics = afterJson.topics || afterJson;
    expect(afterTopics.some((t: { id: string }) => t.id === publicTopicId)).toBe(true);
  });
});
