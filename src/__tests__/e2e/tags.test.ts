import { describe, it, expect } from 'vitest';
import {
  authPost,
  authGet,
  publicGet,
  getSecondUserToken,
} from './helpers';

let categoryId: string;
let topicId: string;
let postId: string;
let tagSlug: string;
let tagName: string;

describe.sequential('Tags — list, search, create with posts, filter posts by tag', () => {
  // ── Setup ──────────────────────────────────────────────────────────────

  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.categories)).toBe(true);
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('setup: User A creates a public topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Tags Topic ${Date.now()}`,
      description: 'Topic for tags E2E tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    topicId = json.topic.id;
    expect(topicId).toBeTruthy();
  });

  it('setup: ensure User B exists', async () => {
    const { token, userId } = await getSecondUserToken();
    expect(token).toBeTruthy();
    expect(userId).toBeTruthy();
  });

  // ── 1. GET /api/tags — list ─────────────────────────────────────────

  it('1. GET /api/tags -> 200, returns { tags: [] }', async () => {
    const res = await publicGet('/api/tags');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.tags)).toBe(true);
  });

  it('2. GET /api/tags returns at most 20 tags (default limit)', async () => {
    const res = await publicGet('/api/tags');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tags.length).toBeLessThanOrEqual(20);
  });

  it('3. GET /api/tags each tag has id, name, slug fields', async () => {
    const res = await publicGet('/api/tags');
    expect(res.status).toBe(200);
    const json = await res.json();
    for (const tag of json.tags) {
      expect(typeof tag.id).toBe('string');
      expect(typeof tag.name).toBe('string');
      expect(typeof tag.slug).toBe('string');
    }
  });

  // ── 2. Create post with tags ────────────────────────────────────────

  it('4. Create post with tags -> 201, tags attached', async () => {
    tagName = `e2e-tag-${Date.now()}`;
    tagSlug = tagName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `E2E Tagged Post ${Date.now()}`,
      content: 'Post content for tags E2E test.',
      tags: [tagName],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post).toBeDefined();
    postId = json.post.id;
    expect(postId).toBeTruthy();
  });

  it('5a. Create post with >5 tags is rejected (max 5, strict cap)', async () => {
    // Server enforces a strict 5-tag cap and returns 400 — silent truncation
    // was changed to explicit rejection so callers don't lose data quietly.
    const manyTags = ['tag-a', 'tag-b', 'tag-c', 'tag-d', 'tag-e', 'tag-f'];
    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `E2E Post Max Tags ${Date.now()}`,
      content: 'Post with too many tags.',
      tags: manyTags,
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/tag/i);
  });

  it('5b. Create post with exactly 5 tags -> 201', async () => {
    const tags = ['e2e-ta', 'e2e-tb', 'e2e-tc', 'e2e-td', 'e2e-te'];
    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `E2E Post Five Tags ${Date.now()}`,
      content: 'Post with exactly 5 tags.',
      tags,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post).toBeDefined();
  });

  it('6. Create post with empty tags array -> 201 (no tags, not an error)', async () => {
    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `E2E Post No Tags ${Date.now()}`,
      content: 'Post with no tags.',
      tags: [],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post).toBeDefined();
  });

  // ── 3. GET /api/tags?q=keyword — search ────────────────────────────

  it('7. GET /api/tags?q=keyword -> 200, returns matching tags (prefix search)', async () => {
    // Use the full slug as the prefix so we don't compete with the dozens
    // of other `e2e-tag-…` rows the suite has piled up over time — the
    // server caps results at 10, and a 6-char prefix drops our just-created
    // tag below the cut.
    const prefix = tagSlug;
    const res = await publicGet(`/api/tags?q=${encodeURIComponent(prefix)}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.tags)).toBe(true);

    // The tag we created should appear in results
    const found = json.tags.find((t: { slug: string }) => t.slug === tagSlug);
    expect(found).toBeDefined();
  });

  it('8. GET /api/tags?q=keyword returns at most 10 results', async () => {
    const res = await publicGet('/api/tags?q=e');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.tags)).toBe(true);
    expect(json.tags.length).toBeLessThanOrEqual(10);
  });

  it('9. GET /api/tags?q=nonexistent-xyz -> 200, empty tags array', async () => {
    const res = await publicGet('/api/tags?q=nonexistent-tag-slug-xyz-abc-123');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.tags)).toBe(true);
    expect(json.tags.length).toBe(0);
  });

  // ── 4. Filter posts by tag ─────────────────────────────────────────

  it('10. GET /api/topics/:topicId/posts?tag=slug -> only tagged posts returned', async () => {
    const res = await publicGet(`/api/topics/${topicId}/posts?tag=${tagSlug}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    expect(json.posts.length).toBeGreaterThan(0);

    // The post we created with that tag should be present
    const found = json.posts.find((p: { id: string }) => p.id === postId);
    expect(found).toBeDefined();
  });

  it('11. GET /api/topics/:topicId/posts?tag=nonexistent -> empty list', async () => {
    const res = await publicGet(`/api/topics/${topicId}/posts?tag=nonexistent-tag-slug-xyz`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    expect(json.posts.length).toBe(0);
  });

  // ── 5. GET /api/tags?topicId=x — topic-scoped tag search ──────────

  it('12. GET /api/tags?topicId=x -> 200, only tags used in that topic', async () => {
    const res = await publicGet(`/api/tags?topicId=${topicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.tags)).toBe(true);

    // The tag we created in this topic should appear
    const found = json.tags.find((t: { slug: string }) => t.slug === tagSlug);
    expect(found).toBeDefined();
  });

  it('13. GET /api/tags?topicId=x&q=prefix -> topic-scoped prefix search', async () => {
    const prefix = tagSlug.substring(0, 6);
    const res = await publicGet(`/api/tags?topicId=${topicId}&q=${encodeURIComponent(prefix)}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.tags)).toBe(true);

    // Should find the tag we created
    const found = json.tags.find((t: { slug: string }) => t.slug === tagSlug);
    expect(found).toBeDefined();
  });

  it('14. GET /api/tags?topicId=x — each result has postCount field', async () => {
    const res = await publicGet(`/api/tags?topicId=${topicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.tags)).toBe(true);
    for (const tag of json.tags) {
      expect(typeof tag.postCount).toBe('number');
      expect(tag.postCount).toBeGreaterThan(0);
    }
  });

  // ── 6. GET /api/tags — authenticated vs guest ──────────────────────

  it('15. GET /api/tags accessible without auth (public endpoint)', async () => {
    // Tags endpoint is public — no auth required
    const res = await publicGet('/api/tags');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.tags)).toBe(true);
  });

  it('16. GET /api/tags accessible with auth too', async () => {
    const res = await authGet('/api/tags');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.tags)).toBe(true);
  });
});
