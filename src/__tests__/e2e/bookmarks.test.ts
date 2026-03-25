import { describe, it, expect } from 'vitest';
import {
  authPost,
  authGet,
  publicPost,
  publicGet,
  secondUserPost,
  secondUserGet,
  getSecondUserToken,
} from './helpers';

let categoryId: string;
let topicId: string;
let postId: string;

describe.sequential('Bookmarks', () => {
  // ── Setup ──────────────────────────────────────────────────────────────

  it('setup: fetch categories', async () => {
    const res = await authGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.categories)).toBe(true);
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('setup: User A creates a public topic and post', async () => {
    const topicRes = await authPost('/api/topics', {
      title: `E2E Bookmarks Topic ${Date.now()}`,
      description: 'Topic for bookmarks E2E tests',
      visibility: 'public',
      categoryId,
    });
    expect(topicRes.status).toBe(201);
    const topicJson = await topicRes.json();
    topicId = topicJson.topic.id;
    expect(topicId).toBeTruthy();

    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `E2E Bookmarks Post ${Date.now()}`,
      content: 'Post for bookmarks E2E tests.',
    });
    expect(postRes.status).toBe(201);
    const postJson = await postRes.json();
    postId = postJson.post.id;
    expect(postId).toBeTruthy();
  });

  it('setup: ensure User B exists', async () => {
    const { token, userId } = await getSecondUserToken();
    expect(token).toBeTruthy();
    expect(userId).toBeTruthy();
  });

  // ── Tests ──────────────────────────────────────────────────────────────

  it('1. User A adds bookmark -> { bookmarked: true }', async () => {
    const res = await authPost(`/api/posts/${postId}/bookmark`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.bookmarked).toBe(true);
  });

  it('2. GET bookmark status -> { bookmarked: true }', async () => {
    const res = await authGet(`/api/posts/${postId}/bookmark`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.bookmarked).toBe(true);
  });

  it('3. Toggle bookmark (remove) -> { bookmarked: false }', async () => {
    const res = await authPost(`/api/posts/${postId}/bookmark`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.bookmarked).toBe(false);
  });

  it('4. GET bookmark status after removal -> { bookmarked: false }', async () => {
    const res = await authGet(`/api/posts/${postId}/bookmark`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.bookmarked).toBe(false);
  });

  it('5. Re-add bookmark for list test', async () => {
    const res = await authPost(`/api/posts/${postId}/bookmark`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.bookmarked).toBe(true);
  });

  it('6. GET /api/bookmarks returns bookmarked posts list', async () => {
    const res = await authGet('/api/bookmarks');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);

    // The post we bookmarked should appear in the list
    const found = json.posts.find((p: { id: string }) => p.id === postId);
    expect(found).toBeTruthy();

    // Each item must have bookmarkedAt timestamp
    for (const post of json.posts) {
      expect(typeof post.id).toBe('string');
      expect(typeof post.title).toBe('string');
      expect(post.bookmarkedAt).toBeTruthy();
    }
  });

  it('7. GET /api/bookmarks supports limit/offset paging', async () => {
    const res = await authGet('/api/bookmarks?limit=1&offset=0');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    expect(json.posts.length).toBeLessThanOrEqual(1);
  });

  it('8. Non-member (User B) can bookmark (no membership check on bookmark route)', async () => {
    // NOTE: The bookmark route only checks authentication, NOT topic membership.
    // A non-member who is authenticated can bookmark any post. This documents current behavior.
    const res = await secondUserPost(`/api/posts/${postId}/bookmark`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.bookmarked).toBe('boolean');
  });

  it('9. Guest (unauthenticated) bookmark attempt -> 401', async () => {
    const res = await publicPost(`/api/posts/${postId}/bookmark`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('10. Guest GET bookmark status -> 401', async () => {
    const res = await publicGet(`/api/posts/${postId}/bookmark`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('11. Guest GET /api/bookmarks -> 401', async () => {
    const res = await publicGet('/api/bookmarks');
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });
});
