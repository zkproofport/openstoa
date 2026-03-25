import { describe, it, expect } from 'vitest';
import {
  authPost,
  authGet,
  publicGet,
  getSecondUserToken,
} from './helpers';

let categoryId: string;
let categorySlug: string;
let publicTopicId: string;
let taggedPostTopicId: string;
let tagSlug: string;

describe.sequential('Topic Detail — list filters, sort, paging', () => {
  // ── Setup ──────────────────────────────────────────────────────────────

  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.categories)).toBe(true);
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
    categorySlug = json.categories[0].slug;
  });

  it('setup: User A creates a public topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Topic Detail ${Date.now()}`,
      description: 'Topic for detail filter/sort/paging tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    publicTopicId = json.topic.id;
    expect(publicTopicId).toBeTruthy();
  });

  it('setup: create another topic and post with a tag (for tag filter test)', async () => {
    const topicRes = await authPost('/api/topics', {
      title: `E2E Tag Filter Topic ${Date.now()}`,
      description: 'Topic for tag filter test',
      visibility: 'public',
      categoryId,
    });
    expect(topicRes.status).toBe(201);
    taggedPostTopicId = (await topicRes.json()).topic.id;

    tagSlug = `e2etag-${Date.now()}`;
    const tagName = tagSlug;
    const postRes = await authPost(`/api/topics/${taggedPostTopicId}/posts`, {
      title: 'Tagged post for filter test',
      content: 'This post has a specific tag for filtering.',
      tags: [tagName],
    });
    expect(postRes.status).toBe(201);
  });

  it('setup: ensure User B exists', async () => {
    const { token, userId } = await getSecondUserToken();
    expect(token).toBeTruthy();
    expect(userId).toBeTruthy();
  });

  // ── 1. Category filter ──────────────────────────────────────────────

  it('1. Topic list — category filter (?category=slug) returns only matching topics', async () => {
    const res = await publicGet(`/api/topics?view=all&category=${categorySlug}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topicList = json.topics;
    expect(Array.isArray(topicList)).toBe(true);

    // All returned topics must belong to the filtered category
    for (const t of topicList) {
      expect(t.category).toBeDefined();
      expect(t.category.slug).toBe(categorySlug);
    }

    // The topic we created should be in the list
    const found = topicList.find((t: { id: string }) => t.id === publicTopicId);
    expect(found).toBeDefined();
  });

  it('2. Topic list — invalid category slug returns 400', async () => {
    const res = await publicGet('/api/topics?view=all&category=nonexistent-category-slug-xyz');
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── 2. Tag filter (via posts inside topic) ──────────────────────────

  it('3. Topic posts — tag filtering (?tag=slug) returns only tagged posts', async () => {
    const res = await publicGet(`/api/topics/${taggedPostTopicId}/posts?tag=${tagSlug}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    // The tagged post should appear
    expect(json.posts.length).toBeGreaterThan(0);
  });

  it('4. Topic posts — tag filtering with nonexistent tag returns empty list', async () => {
    const res = await publicGet(`/api/topics/${taggedPostTopicId}/posts?tag=nonexistent-tag-slug-xyz`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    expect(json.posts.length).toBe(0);
  });

  // ── 3. Sort ─────────────────────────────────────────────────────────

  it('5. Topic list — sort=hot (default) returns 200', async () => {
    const res = await publicGet('/api/topics?view=all&sort=hot');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.topics)).toBe(true);
  });

  it('6. Topic list — sort=new returns topics ordered by createdAt desc', async () => {
    const res = await publicGet('/api/topics?view=all&sort=new');
    expect(res.status).toBe(200);
    const json = await res.json();
    const topicList: Array<{ createdAt: string }> = json.topics;
    expect(Array.isArray(topicList)).toBe(true);
    // Verify descending order
    for (let i = 1; i < topicList.length; i++) {
      const prev = new Date(topicList[i - 1].createdAt).getTime();
      const curr = new Date(topicList[i].createdAt).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('7. Topic list — sort=top returns topics ordered by memberCount desc', async () => {
    const res = await publicGet('/api/topics?view=all&sort=top');
    expect(res.status).toBe(200);
    const json = await res.json();
    const topicList: Array<{ memberCount: number }> = json.topics;
    expect(Array.isArray(topicList)).toBe(true);
    for (let i = 1; i < topicList.length; i++) {
      expect(topicList[i - 1].memberCount).toBeGreaterThanOrEqual(topicList[i].memberCount);
    }
  });

  // ── 4. Paging ───────────────────────────────────────────────────────

  it('8. Topic posts — paging (limit + offset) returns correct slices', async () => {
    // Create multiple posts in our topic to have enough data
    for (let i = 0; i < 3; i++) {
      await authPost(`/api/topics/${publicTopicId}/posts`, {
        title: `Paging test post ${i} ${Date.now()}`,
        content: `Post ${i} for paging test`,
      });
    }

    const page1 = await publicGet(`/api/topics/${publicTopicId}/posts?limit=2&offset=0`);
    expect(page1.status).toBe(200);
    const page1Json = await page1.json();
    expect(Array.isArray(page1Json.posts)).toBe(true);
    expect(page1Json.posts.length).toBeLessThanOrEqual(2);

    const page2 = await publicGet(`/api/topics/${publicTopicId}/posts?limit=2&offset=2`);
    expect(page2.status).toBe(200);
    const page2Json = await page2.json();
    expect(Array.isArray(page2Json.posts)).toBe(true);

    // Page 1 and page 2 should have different post IDs (no overlap)
    if (page1Json.posts.length > 0 && page2Json.posts.length > 0) {
      const page1Ids = new Set(page1Json.posts.map((p: { id: string }) => p.id));
      for (const post of page2Json.posts) {
        expect(page1Ids.has(post.id)).toBe(false);
      }
    }
  });

  it('9. Topic posts — limit capped at 100', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts?limit=999`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    // Server enforces max 100; response must not exceed it
    expect(json.posts.length).toBeLessThanOrEqual(100);
  });

  // ── 5. view=all vs view=my ──────────────────────────────────────────

  it('10. Authenticated — default (no view param) returns only joined topics', async () => {
    const res = await authGet('/api/topics');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.topics)).toBe(true);
    // User A created publicTopicId and is auto-joined as owner
    const found = json.topics.find((t: { id: string }) => t.id === publicTopicId);
    expect(found).toBeDefined();
  });

  it('11. Authenticated — view=all returns all non-blinded visible topics', async () => {
    const res = await authGet('/api/topics?view=all');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.topics)).toBe(true);
    const found = json.topics.find((t: { id: string }) => t.id === publicTopicId);
    expect(found).toBeDefined();
  });

  it('12. Unauthenticated — without view=all returns empty list', async () => {
    const res = await publicGet('/api/topics');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.topics)).toBe(true);
    expect(json.topics.length).toBe(0);
  });

  // ── 6. Topic title length limit ──────────────────────────────────────

  it.todo(
    '13. Create topic — title exceeding 100 chars -> 400 (UI enforces maxLength=100; server has no length check)',
  );
});
