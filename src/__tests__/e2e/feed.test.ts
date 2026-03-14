import { describe, it, expect } from 'vitest';
import { authGet, authPost, publicGet } from './helpers';

let categoryId: string;
let categorySlug: string;
let publicTopicId: string;
let secretTopicId: string;
let publicPostId: string;

describe.sequential('Feed endpoints', () => {
  // ── Setup ──────────────────────────────────────────────────────────────

  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
    categorySlug = json.categories[0].slug;
  });

  it('setup: create public topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Feed Public ${Date.now()}`,
      description: 'Public topic for feed tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    publicTopicId = json.topic.id;
  });

  it('setup: create secret topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Feed Secret ${Date.now()}`,
      description: 'Secret topic for feed tests',
      visibility: 'secret',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    secretTopicId = json.topic.id;
  });

  it('setup: create post in public topic', async () => {
    const res = await authPost(`/api/topics/${publicTopicId}/posts`, {
      title: `E2E Feed Post ${Date.now()}`,
      content: 'Post content for feed E2E tests',
      tags: ['e2e-feed-test'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    publicPostId = json.post.id;
  });

  it('setup: create post in secret topic', async () => {
    const res = await authPost(`/api/topics/${secretTopicId}/posts`, {
      title: `E2E Feed Secret Post ${Date.now()}`,
      content: 'Secret post that guests should NOT see',
    });
    expect(res.status).toBe(201);
  });

  // ── Guest access ──────────────────────────────────────────────────────

  it('GET /api/feed returns 200 for guests with posts from public topics', async () => {
    const res = await publicGet('/api/feed');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    expect(json.posts.length).toBeGreaterThanOrEqual(1);

    // Every post should have expected fields
    const post = json.posts[0];
    expect(post.id).toBeTruthy();
    expect(post.topicId).toBeTruthy();
    expect(post.title).toBeTruthy();
    expect(post.topicTitle).toBeTruthy();
    expect(post.userVoted).toBeNull(); // guests always get null
  });

  it('guest feed does NOT contain posts from secret topics', async () => {
    const res = await publicGet('/api/feed?limit=100');
    expect(res.status).toBe(200);
    const json = await res.json();
    const topicIds = json.posts.map((p: any) => p.topicId);
    expect(topicIds).not.toContain(secretTopicId);
  });

  // ── Authenticated access ──────────────────────────────────────────────

  it('GET /api/feed returns 200 for authenticated users', async () => {
    const res = await authGet('/api/feed');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    expect(json.posts.length).toBeGreaterThanOrEqual(1);
  });

  it('auth feed contains posts from user joined topics', async () => {
    const res = await authGet('/api/feed?limit=100');
    expect(res.status).toBe(200);
    const json = await res.json();
    const topicIds = json.posts.map((p: any) => p.topicId);
    // Auth user created and is a member of both public and secret topics
    expect(topicIds).toContain(publicTopicId);
    expect(topicIds).toContain(secretTopicId);
  });

  // ── Sorting ───────────────────────────────────────────────────────────

  it('GET /api/feed?sort=new returns posts sorted by newest', async () => {
    const res = await publicGet('/api/feed?sort=new');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);

    // Verify descending order by createdAt
    for (let i = 1; i < json.posts.length; i++) {
      const prev = new Date(json.posts[i - 1].createdAt).getTime();
      const curr = new Date(json.posts[i].createdAt).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('GET /api/feed?sort=top returns posts sorted by upvotes', async () => {
    const res = await publicGet('/api/feed?sort=top');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);

    // Verify descending order by upvoteCount
    for (let i = 1; i < json.posts.length; i++) {
      expect(json.posts[i - 1].upvoteCount).toBeGreaterThanOrEqual(json.posts[i].upvoteCount);
    }
  });

  // ── Category filter ───────────────────────────────────────────────────

  it('GET /api/feed?category=slug filters by category', async () => {
    const res = await publicGet(`/api/feed?category=${categorySlug}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    // Our public post's topic is in this category, so it should appear
    const postIds = json.posts.map((p: any) => p.id);
    expect(postIds).toContain(publicPostId);
  });

  it('GET /api/feed?category=nonexistent returns empty', async () => {
    const res = await publicGet('/api/feed?category=nonexistent-category-slug-xyz');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.posts).toEqual([]);
  });

  // ── Pagination ────────────────────────────────────────────────────────

  it('GET /api/feed respects limit and offset', async () => {
    const res = await publicGet('/api/feed?limit=1&offset=0');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.posts.length).toBeLessThanOrEqual(1);

    // With a large offset, expect fewer or no results
    const res2 = await publicGet('/api/feed?limit=20&offset=10000');
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.posts.length).toBe(0);
  });
});
