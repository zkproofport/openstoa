import { describe, it, expect } from 'vitest';
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
  adminPost,
  adminGet,
  requireAdminToken,
} from './helpers';

let categoryId: string;
let publicTopicId: string;
let originalTitle: string;
let originalDescription: string;

describe.sequential('Topic CRUD + Permission + Blind', () => {
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

  // ── Cases 13/14: site-admin actions — SKIPPED, not failing ──────────
  //
  // Both need a session whose USER ROW has role='admin'. There is no way to
  // mint one in this environment:
  //   - `/api/topics/{id}/blind` looks the caller up in `users` and requires
  //     `user.role === 'admin'` (src/app/api/topics/[topicId]/blind/route.ts:41).
  //     It reads the DB row, not the session — so the credential type does not
  //     matter, only the row does.
  //   - An API key therefore CANNOT confer admin: `getApiKeySession`
  //     (src/lib/session.ts) resolves a key to its owner's userId, so a key is
  //     exactly as admin as its owner and no more. Issuing one from a
  //     dev-login user leaves role='user'.
  //   - `/api/auth/dev-login` only ever inserts a default-role user; it has no
  //     role parameter (src/app/api/auth/dev-login/route.ts).
  //   - Nothing else promotes a user: the repo has no admin-bootstrap route,
  //     script or env allowlist (`role: 'admin'` is written nowhere outside
  //     topic-level membership).
  // The only remaining path was the proof-gated OIDC login + a manual
  // `UPDATE users SET role='admin'` — and that login is gone with the deleted
  // Google OAuth client and the offline prover (see proof-gated-topics.test.ts).
  //
  // Kept verbatim so they run again the moment an admin credential exists:
  // either restore that login, or point E2E_STAGING_DB_URL at the database
  // under test and promote a dev-login user directly.
  it.skip('13. Admin blinds topic -> 200 [SKIPPED: no admin credential obtainable — blind needs users.role=admin, which only the deleted-OAuth proof login + a manual DB grant could produce; an API key inherits its owner\'s role and dev-login cannot set one]', async () => {
    const res = await adminPost(`/api/topics/${publicTopicId}/blind`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.blinded).toBe(true);
    expect(json.blindedBy).toBe('admin');
  });

  it.skip('14. Blinded topic excluded from topic list [SKIPPED: depends on case 13 — without an admin credential the topic is never blinded, so the exclusion assertion would fail for a reason unrelated to list filtering]', async () => {
    // This case only means anything if case 13 could actually blind the topic;
    // without an admin credential the exclusion below fails for a reason that
    // has nothing to do with list filtering.
    requireAdminToken();

    const listRes = await publicGet('/api/topics?view=all');
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    const topics = listJson.topics || listJson;
    expect(Array.isArray(topics)).toBe(true);

    const found = topics.find((t: { id: string }) => t.id === publicTopicId);
    expect(found).toBeUndefined();

    // Clean up: admin unblinds
    const unblindRes = await adminPost(`/api/topics/${publicTopicId}/blind`);
    expect(unblindRes.status).toBe(200);
    const unblindJson = await unblindRes.json();
    expect(unblindJson.blinded).toBe(false);
  });
});
