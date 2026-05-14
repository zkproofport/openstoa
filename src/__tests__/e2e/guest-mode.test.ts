import { describe, it, expect, afterAll } from 'vitest';
import {
  authPost,
  publicGet,
  publicPost,
  publicDelete,
  publicPatch,
  deleteTopic,
  fetchCategorySlugs,
} from './helpers';

/**
 * Guest-mode contract E2E suite — mirrors the server-side
 * GUEST_ACCESSIBLE_PREFIXES whitelist in `src/middleware.ts`.
 *
 * Companion to the mobile-side unit tests in
 * `packages/mobile/src/__tests__/openstoaClient.test.ts` — both layers must
 * agree on which paths a guest may hit:
 *   - GET on the prefix list → 200 (no Authorization header)
 *   - Anything else → 401
 */

const createdTopicIds: string[] = [];
let publicTopicId: string;
let publicPostId: string;
let publicCommentId: string;
let categoryId: string;

describe.sequential('Guest mode — public read access + auth-required writes', () => {
  afterAll(async () => {
    for (const id of createdTopicIds) {
      try { await deleteTopic(id); } catch { /* swallow */ }
    }
  });

  // ── Setup: create a public topic + post so guests have something to read ──

  it('setup: fetch a category to use', async () => {
    const cats = await fetchCategorySlugs();
    expect(cats.length).toBeGreaterThanOrEqual(1);
    categoryId = cats[0].id;
  });

  it('setup: create a public topic owned by the auth test user', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Guest Mode ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      description: 'Topic for guest-mode contract tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    publicTopicId = json.topic.id;
    createdTopicIds.push(publicTopicId);
  });

  it('setup: create a post in the public topic', async () => {
    const res = await authPost(`/api/topics/${publicTopicId}/posts`, {
      title: `E2E Guest Mode Post ${Date.now()}`,
      content: 'Public post body for guest reads',
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    publicPostId = json.post.id;
  });

  it('setup: create a comment on the public post (for later guest-read tests)', async () => {
    const res = await authPost(`/api/posts/${publicPostId}/comments`, {
      content: 'Existing comment for guest mode test fixtures',
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    publicCommentId = json.comment?.id ?? json.id ?? null;
    // Some routes return shapes differ — we don't require this id for the
    // matrix; we just want one extant comment so the post detail has data.
  });

  // ── Matrix row 10: GET /api/feed without Authorization → 200 ─────────────
  it('GET /api/feed without Authorization returns 200', async () => {
    const res = await publicGet('/api/feed');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
  });

  it('GET /api/feed?sort=new without Authorization returns 200', async () => {
    const res = await publicGet('/api/feed?sort=new&limit=10');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
  });

  // ── Matrix row 11: GET /api/topics without Authorization → 200 ───────────
  it('GET /api/topics?view=all without Authorization returns 200', async () => {
    const res = await publicGet('/api/topics?view=all');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.topics)).toBe(true);
  });

  it('GET /api/topics (no view=all) without Authorization returns 200', async () => {
    // Guests get an empty array (no joined topics); the route must NOT 401.
    const res = await publicGet('/api/topics');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.topics)).toBe(true);
  });

  it('GET /api/topics/{id} without Authorization returns 200 for a public topic', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topic = json.topic ?? json;
    expect(topic.id).toBe(publicTopicId);
  });

  it('GET /api/topics/{id}/posts without Authorization returns 200 for a public topic', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
  });

  // ── Matrix row 12: GET /api/posts/{id} without Authorization → 200 ───────
  it('GET /api/posts/{id} without Authorization returns 200 for a post in a public topic', async () => {
    const res = await publicGet(`/api/posts/${publicPostId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const post = json.post ?? json;
    expect(post.id).toBe(publicPostId);
  });

  it('GET /api/posts/{id}/comments without Authorization returns 405 (route is POST-only)', async () => {
    // The comments route is POST-only — fetching comments happens via
    // GET /api/posts/{id} (post detail bundles comments). This test exists
    // to lock that contract so a future GET handler can't quietly leak
    // comments past the middleware. If a GET handler IS added later, the
    // server must keep this path under GUEST_ACCESSIBLE_PREFIXES so guests
    // can read; this test should then be updated to expect 200.
    const res = await publicGet(`/api/posts/${publicPostId}/comments`);
    expect(res.status).toBe(405);
  });

  it('GET /api/posts/{id}/reactions without Authorization returns 200 with userReacted=false', async () => {
    const res = await publicGet(`/api/posts/${publicPostId}/reactions`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.reactions)).toBe(true);
    for (const r of json.reactions) {
      expect(r.userReacted).toBe(false);
    }
  });

  // ── Matrix row 13: POST /api/topics/{id}/posts without Auth → 401 ────────
  it('POST /api/topics/{id}/posts without Authorization returns 401', async () => {
    const res = await publicPost(`/api/topics/${publicTopicId}/posts`, {
      title: 'Should fail — guest',
      content: 'No auth header here',
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/topics without Authorization returns 401', async () => {
    const res = await publicPost('/api/topics', {
      title: 'Guest cannot create a topic',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(401);
  });

  // ── Matrix row 14: POST /api/posts/{id}/comments without Auth → 401 ──────
  it('POST /api/posts/{id}/comments without Authorization returns 401', async () => {
    const res = await publicPost(`/api/posts/${publicPostId}/comments`, {
      content: 'Guest comment should be rejected',
    });
    expect(res.status).toBe(401);
  });

  // ── Matrix row 15: POST /api/posts/{id}/vote without Auth → 401 ──────────
  it('POST /api/posts/{id}/vote without Authorization returns 401', async () => {
    const res = await publicPost(`/api/posts/${publicPostId}/vote`, {
      value: 1,
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/posts/{id}/reactions without Authorization returns 401', async () => {
    const res = await publicPost(`/api/posts/${publicPostId}/reactions`, {
      emoji: '🔥',
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/posts/{id}/bookmark without Authorization returns 401', async () => {
    const res = await publicPost(`/api/posts/${publicPostId}/bookmark`);
    expect(res.status).toBe(401);
  });

  it('POST /api/topics/{id}/join without Authorization returns 401', async () => {
    const res = await publicPost(`/api/topics/${publicTopicId}/join`);
    expect(res.status).toBe(401);
  });

  it('PATCH /api/topics/{id} without Authorization returns 401', async () => {
    const res = await publicPatch(`/api/topics/${publicTopicId}`, {
      title: 'guest cannot edit',
    });
    expect(res.status).toBe(401);
  });

  it('DELETE /api/posts/{id} without Authorization returns 401', async () => {
    const res = await publicDelete(`/api/posts/${publicPostId}`);
    expect(res.status).toBe(401);
  });

  // ── Member-only endpoints (sanity: they really require auth) ─────────────
  it('GET /api/bookmarks (my bookmarks) without Authorization returns 401', async () => {
    const res = await publicGet('/api/bookmarks');
    expect(res.status).toBe(401);
  });

  it('GET /api/my/posts without Authorization returns 401', async () => {
    const res = await publicGet('/api/my/posts');
    expect(res.status).toBe(401);
  });

  // ── Stale Authorization header is rejected, not silently accepted ────────
  it('GET /api/feed with a malformed Authorization header still returns 200 (guest fallback)', async () => {
    // The middleware treats a bad token on a guest-accessible path as
    // "browse as guest" — not a 401. This mirrors the mobile client's
    // setMode('guest') behaviour after sign-out.
    const baseUrl = process.env.E2E_BASE_URL || 'https://stg-community.zkproofport.app';
    const res = await fetch(`${baseUrl}/api/feed`, {
      headers: { Authorization: 'Bearer not.a.real.jwt' },
    });
    expect(res.status).toBe(200);
  });

  it('POST /api/topics/{id}/posts with a malformed Authorization header returns 401', async () => {
    const baseUrl = process.env.E2E_BASE_URL || 'https://stg-community.zkproofport.app';
    const res = await fetch(`${baseUrl}/api/topics/${publicTopicId}/posts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer not.a.real.jwt',
      },
      body: JSON.stringify({ title: 'x', content: 'y' }),
    });
    expect(res.status).toBe(401);
  });
});
