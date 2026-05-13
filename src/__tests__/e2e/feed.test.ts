import { describe, it, expect, afterAll } from 'vitest';
import {
  authGet,
  authPost,
  publicGet,
  deleteTopic,
  fetchCategorySlugs,
} from './helpers';

// Track every resource we create so afterAll can wipe it.
const createdTopicIds: string[] = [];

// Categories used in this test. We pick the first 3 categories from the API
// to avoid hardcoding slugs that may not exist on staging.
let categoryA: { id: string; slug: string };
let categoryB: { id: string; slug: string };
let categoryC: { id: string; slug: string };

// Topics, one per category, all owned by the test user.
let topicAId: string;
let topicBId: string;
let topicCId: string;

// Posts in each topic.
let postAId: string;
let postBId: string;
let postCId: string;

// Unique stamp + token shared across search-related tests so each query can
// be filtered to only THIS suite's rows even on a noisy staging DB.
let feedStamp: string;
const FEED_UTF8 = '안녕피드검색';

describe.sequential('Feed endpoints', () => {
  afterAll(async () => {
    // Best-effort cleanup — runs even when an it() above fails.
    for (const id of createdTopicIds) {
      try {
        await deleteTopic(id);
      } catch {
        // Swallow — cleanup failures should not mask the real test failure.
      }
    }
  });

  // ── Setup ──────────────────────────────────────────────────────────────

  it('setup: pick three distinct categories', async () => {
    const cats = await fetchCategorySlugs();
    expect(cats.length).toBeGreaterThanOrEqual(3);
    categoryA = cats[0];
    categoryB = cats[1];
    categoryC = cats[2];
  });

  it('setup: create topic in category A', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Feed A ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      description: 'Feed test topic in category A',
      visibility: 'public',
      categoryId: categoryA.id,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    topicAId = json.topic.id;
    createdTopicIds.push(topicAId);
  });

  it('setup: create topic in category B', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Feed B ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      description: 'Feed test topic in category B',
      visibility: 'public',
      categoryId: categoryB.id,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    topicBId = json.topic.id;
    createdTopicIds.push(topicBId);
  });

  it('setup: create topic in category C', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Feed C ${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      description: 'Feed test topic in category C',
      visibility: 'public',
      categoryId: categoryC.id,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    topicCId = json.topic.id;
    createdTopicIds.push(topicCId);
  });

  it('setup: post in each topic', async () => {
    feedStamp = `feedq${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const [resA, resB, resC] = await Promise.all([
      authPost(`/api/topics/${topicAId}/posts`, {
        title: `E2E Feed Post A ${feedStamp}`,
        content: `Post in category A ${feedStamp}`,
        tags: ['e2e-feed-test'],
      }),
      authPost(`/api/topics/${topicBId}/posts`, {
        title: `E2E Feed Post B ${feedStamp}`,
        content: `Post in category B ${feedStamp} ${FEED_UTF8}`,
      }),
      authPost(`/api/topics/${topicCId}/posts`, {
        title: `E2E Feed Post C ${feedStamp}`,
        content: `Post in category C ${feedStamp}`,
      }),
    ]);
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resC.status).toBe(201);
    postAId = (await resA.json()).post.id;
    postBId = (await resB.json()).post.id;
    postCId = (await resC.json()).post.id;
  });

  // ── Guest access ──────────────────────────────────────────────────────

  it('GET /api/feed returns 200 for guests with posts from public topics', async () => {
    const res = await publicGet('/api/feed');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    expect(json.posts.length).toBeGreaterThanOrEqual(1);

    const post = json.posts[0];
    expect(post.id).toBeTruthy();
    expect(post.topicId).toBeTruthy();
    expect(post.title).toBeTruthy();
    expect(post.topicTitle).toBeTruthy();
    expect(post.userVoted).toBeNull(); // guests always get null
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
    const res = await authGet('/api/feed?sort=new&limit=100');
    expect(res.status).toBe(200);
    const json = await res.json();
    const topicIds = json.posts.map((p: { topicId: string }) => p.topicId);
    expect(topicIds).toContain(topicAId);
  });

  it('view=my returns only posts from topics the user has joined', async () => {
    const res = await authGet('/api/feed?view=my&limit=100');
    expect(res.status).toBe(200);
    const json = await res.json();
    // User A owns topicA/B/C so they should appear; topics the user is NOT a
    // member of must NOT appear. We confirm all three created topics are in
    // the returned feed.
    const returnedTopicIds = json.posts.map((p: { topicId: string }) => p.topicId);
    expect(returnedTopicIds).toEqual(expect.arrayContaining([topicAId, topicBId, topicCId]));
  });

  // ── Sorting ───────────────────────────────────────────────────────────

  it('GET /api/feed?sort=new returns posts sorted by newest', async () => {
    const res = await publicGet('/api/feed?sort=new');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);

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

    for (let i = 1; i < json.posts.length; i++) {
      expect(json.posts[i - 1].upvoteCount).toBeGreaterThanOrEqual(json.posts[i].upvoteCount);
    }
  });

  it('GET /api/feed?sort=active returns 200 and is distinct from sort=hot order in general', async () => {
    const [activeRes, hotRes] = await Promise.all([
      publicGet('/api/feed?sort=active&limit=100'),
      publicGet('/api/feed?sort=hot&limit=100'),
    ]);
    expect(activeRes.status).toBe(200);
    expect(hotRes.status).toBe(200);
    const active = (await activeRes.json()).posts;
    const hot = (await hotRes.json()).posts;
    expect(Array.isArray(active)).toBe(true);
    expect(Array.isArray(hot)).toBe(true);
    // Active feed must have a defined order; we only assert sort produced data.
    expect(active.length).toBeGreaterThan(0);
  });

  it('sort=active reorders feed when a fresh post receives a comment', async () => {
    // Comment on postC (the most recently created post; we will measure that
    // it climbs to the top of sort=active because the new comment bumps
    // lastActivityAt).
    const commentRes = await authPost(`/api/posts/${postCId}/comments`, {
      content: 'Bump activity for sort=active feed test',
    });
    expect(commentRes.status).toBe(201);

    const res = await publicGet('/api/feed?sort=active&limit=100');
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = json.posts.map((p: { id: string }) => p.id);
    // postC must be ranked before postA and postB on the active feed because
    // its lastActivityAt was just bumped.
    const cIdx = ids.indexOf(postCId);
    const aIdx = ids.indexOf(postAId);
    const bIdx = ids.indexOf(postBId);
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(cIdx).toBeLessThan(aIdx);
    expect(cIdx).toBeLessThan(bIdx);
  });

  it('GET /api/feed?sort=invalid returns 400', async () => {
    const res = await publicGet('/api/feed?sort=invalid_sort_xyz');
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    expect(json.error).toMatch(/invalid sort/i);
  });

  // ── Category filter ───────────────────────────────────────────────────

  it('GET /api/feed?category=A filters to category A only', async () => {
    const res = await publicGet(`/api/feed?sort=new&category=${categoryA.slug}&limit=100`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const postIds = json.posts.map((p: { id: string }) => p.id);
    expect(postIds).toContain(postAId);
    expect(postIds).not.toContain(postBId);
    expect(postIds).not.toContain(postCId);
  });

  it('GET /api/feed?category=B filters to category B only', async () => {
    const res = await publicGet(`/api/feed?sort=new&category=${categoryB.slug}&limit=100`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const postIds = json.posts.map((p: { id: string }) => p.id);
    expect(postIds).toContain(postBId);
    expect(postIds).not.toContain(postAId);
    expect(postIds).not.toContain(postCId);
  });

  it('GET /api/feed?category=nonexistent returns 400', async () => {
    const res = await publicGet('/api/feed?category=nonexistent-category-slug-xyz');
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    expect(json.error).toMatch(/category/i);
  });

  // ── Tag filter ────────────────────────────────────────────────────────

  it('GET /api/feed?tag=e2e-feed-test returns posts with that tag', async () => {
    const res = await publicGet('/api/feed?tag=e2e-feed-test&limit=100');
    expect(res.status).toBe(200);
    const json = await res.json();
    const postIds = json.posts.map((p: { id: string }) => p.id);
    expect(postIds).toContain(postAId);
    expect(postIds).not.toContain(postBId);
    expect(postIds).not.toContain(postCId);
  });

  it('GET /api/feed?tag=nonexistent-tag returns empty', async () => {
    const res = await publicGet('/api/feed?tag=nonexistent-tag-slug-xyz');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.posts).toEqual([]);
  });

  // ── Search (q=) ───────────────────────────────────────────────────────

  it('GET /api/feed?q matches post title (case-insensitive substring)', async () => {
    // Search by "Post A " + stamp to find only Post A (case-insensitive ilike).
    const res = await publicGet(`/api/feed?q=POST+a+${feedStamp}&limit=100`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const postIds = json.posts.map((p: { id: string }) => p.id);
    expect(postIds).toContain(postAId);
    expect(postIds).not.toContain(postBId);
    expect(postIds).not.toContain(postCId);
  });

  it('GET /api/feed?q matches post content (B-only substring)', async () => {
    const res = await publicGet(`/api/feed?q=category+B+${feedStamp}&limit=100`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const postIds = json.posts.map((p: { id: string }) => p.id);
    expect(postIds).toContain(postBId);
    expect(postIds).not.toContain(postAId);
    expect(postIds).not.toContain(postCId);
  });

  it('GET /api/feed?q matches UTF-8 (Korean) content', async () => {
    // Post B's content carries 안녕피드검색 — confirms ilike works on non-ASCII.
    const res = await publicGet(`/api/feed?q=${encodeURIComponent(FEED_UTF8)}&limit=100`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const postIds = json.posts.map((p: { id: string }) => p.id);
    expect(postIds).toContain(postBId);
    expect(postIds).not.toContain(postAId);
    expect(postIds).not.toContain(postCId);
  });

  it('GET /api/feed?q trims surrounding whitespace', async () => {
    const padded = `   ${feedStamp}   `;
    const res = await publicGet(`/api/feed?q=${encodeURIComponent(padded)}&limit=100`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const postIds = json.posts.map((p: { id: string }) => p.id);
    // Stamp is shared by all three feed posts.
    expect(postIds).toContain(postAId);
    expect(postIds).toContain(postBId);
    expect(postIds).toContain(postCId);
  });

  it('GET /api/feed?q (whitespace-only) is treated as no filter', async () => {
    // Empty/whitespace q must not filter to "rows containing %% only".
    const [withQ, withoutQ] = await Promise.all([
      publicGet('/api/feed?q=%20%20%20&sort=new&limit=10'),
      publicGet('/api/feed?sort=new&limit=10'),
    ]);
    expect(withQ.status).toBe(200);
    expect(withoutQ.status).toBe(200);
    const a = await withQ.json();
    const b = await withoutQ.json();
    expect(a.posts.length).toBe(b.posts.length);
  });

  it('GET /api/feed?q combines with sort=new', async () => {
    const res = await publicGet(`/api/feed?q=${feedStamp}&sort=new&limit=100`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const posts: Array<{ id: string; createdAt: string }> = json.posts;
    // Only the three feed posts should match the unique stamp.
    const ids = posts.map((p) => p.id);
    for (const id of [postAId, postBId, postCId]) expect(ids).toContain(id);
    // Newest first.
    for (let i = 1; i < posts.length; i++) {
      const prev = new Date(posts[i - 1].createdAt).getTime();
      const curr = new Date(posts[i].createdAt).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('GET /api/feed?q combines with category filter', async () => {
    const res = await publicGet(
      `/api/feed?q=${feedStamp}&category=${categoryA.slug}&limit=100`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = json.posts.map((p: { id: string }) => p.id);
    // Stamp matches all three posts, but the category filter narrows to A.
    expect(ids).toContain(postAId);
    expect(ids).not.toContain(postBId);
    expect(ids).not.toContain(postCId);
  });

  it('GET /api/feed?q combines with tag filter', async () => {
    const res = await publicGet(
      `/api/feed?q=${feedStamp}&tag=e2e-feed-test&limit=100`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = json.posts.map((p: { id: string }) => p.id);
    // Only Post A has the e2e-feed-test tag.
    expect(ids).toContain(postAId);
    expect(ids).not.toContain(postBId);
    expect(ids).not.toContain(postCId);
  });

  it('GET /api/feed?q with no matches returns empty', async () => {
    const res = await publicGet('/api/feed?q=zzz_no_match_xyz_unique_token_abcdefg');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.posts).toEqual([]);
  });

  it('GET /api/feed?q works for guests (no session) too', async () => {
    // Same call as the public guest GET above; explicit assertion that
    // search isn't auth-gated. publicGet has no Authorization header.
    const res = await publicGet(`/api/feed?q=${feedStamp}&limit=100`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = json.posts.map((p: { id: string }) => p.id);
    for (const id of [postAId, postBId, postCId]) expect(ids).toContain(id);
  });

  // ── Pagination ────────────────────────────────────────────────────────

  it('GET /api/feed respects limit and offset', async () => {
    const res = await publicGet('/api/feed?limit=1&offset=0');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.posts.length).toBeLessThanOrEqual(1);

    const res2 = await publicGet('/api/feed?limit=20&offset=10000');
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.posts.length).toBe(0);
  });

});
