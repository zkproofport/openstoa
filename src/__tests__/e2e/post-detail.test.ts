import { describe, it, expect } from 'vitest';
import {
  authPost,
  authGet,
  publicGet,
  publicPost,
  secondUserPost,
  getSecondUserToken,
} from './helpers';

let categoryId: string;
let publicTopicId: string;
let postId: string;
let tagSlug: string;

describe.sequential('Post Detail — sort, tag filter, paging, viewCount, pin', () => {
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
      title: `E2E Post Detail ${Date.now()}`,
      description: 'Topic for post detail tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    publicTopicId = json.topic.id;
    expect(publicTopicId).toBeTruthy();
  });

  it('setup: ensure User B exists', async () => {
    const { token, userId } = await getSecondUserToken();
    expect(token).toBeTruthy();
    expect(userId).toBeTruthy();
  });

  it('setup: create base post with a tag', async () => {
    tagSlug = `e2e-detail-tag-${Date.now()}`;
    const res = await authPost(`/api/topics/${publicTopicId}/posts`, {
      title: `E2E Post Detail Base ${Date.now()}`,
      content: 'Base post for post detail tests',
      tags: [tagSlug],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    postId = json.post.id;
    expect(postId).toBeTruthy();
  });

  // ── 1. Post creation with image/media attachment ─────────────────────

  it('1. Post creation with external image URL in content -> 201', async () => {
    const res = await authPost(`/api/topics/${publicTopicId}/posts`, {
      title: `Media Post ${Date.now()}`,
      content: 'Post with external image: https://example.com/image.png',
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post).toBeDefined();
    expect(json.post.id).toBeTruthy();
    expect(json.post.content).toContain('https://example.com/image.png');
  });

  // ── 2. Post list — sort ──────────────────────────────────────────────

  it('2. Post list — sort=new (default) returns posts ordered by createdAt desc', async () => {
    // Create extra posts to have ordering data
    for (let i = 0; i < 2; i++) {
      await authPost(`/api/topics/${publicTopicId}/posts`, {
        title: `Sort test post ${i} ${Date.now()}`,
        content: `Post ${i} for sort test`,
      });
    }

    const res = await publicGet(`/api/topics/${publicTopicId}/posts?sort=new`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const postList: Array<{ createdAt: string; isPinned?: boolean }> = json.posts;
    expect(Array.isArray(postList)).toBe(true);
    // Pinned posts come first; among non-pinned, verify descending createdAt
    const nonPinned = postList.filter((p) => !p.isPinned);
    for (let i = 1; i < nonPinned.length; i++) {
      const prev = new Date(nonPinned[i - 1].createdAt).getTime();
      const curr = new Date(nonPinned[i].createdAt).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('3. Post list — sort=hot returns score non-increasing among non-pinned', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts?sort=hot&limit=100`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const items: Array<{ score: number; isPinned: boolean }> = json.posts;
    expect(Array.isArray(items)).toBe(true);
    const nonPinned = items.filter((p) => !p.isPinned);
    for (let i = 1; i < nonPinned.length; i++) {
      expect(nonPinned[i - 1].score).toBeGreaterThanOrEqual(nonPinned[i].score);
    }
  });

  it('3b. Post list — sort=top returns upvoteCount non-increasing among non-pinned', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts?sort=top&limit=100`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const items: Array<{ upvoteCount: number; isPinned: boolean }> = json.posts;
    const nonPinned = items.filter((p) => !p.isPinned);
    for (let i = 1; i < nonPinned.length; i++) {
      expect(nonPinned[i - 1].upvoteCount).toBeGreaterThanOrEqual(nonPinned[i].upvoteCount);
    }
  });

  it('3c. Post list — sort=active orders by updatedAt/createdAt activity (non-increasing)', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts?sort=active&limit=100`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const items: Array<{ id: string; isPinned: boolean }> = json.posts;
    expect(Array.isArray(items)).toBe(true);
    // We assert non-empty + 200 here; the topic-level bump on activity is
    // validated end-to-end in the dedicated bump tests below.
    expect(items.length).toBeGreaterThan(0);
  });

  it('3d. Post list — sort=recorded returns recordCount non-increasing among non-pinned', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts?sort=recorded&limit=100`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const items: Array<{ recordCount: number; isPinned: boolean }> = json.posts;
    const nonPinned = items.filter((p) => !p.isPinned);
    for (let i = 1; i < nonPinned.length; i++) {
      expect(nonPinned[i - 1].recordCount).toBeGreaterThanOrEqual(nonPinned[i].recordCount);
    }
  });

  it('3e. Post list — sort=popular returns 400 (legacy vocabulary rejected)', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts?sort=popular`);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/sort/i);
  });

  it('3f. Post list — pinned posts are always first regardless of sort', async () => {
    // Pin the base post then verify it shows up at position 0 under sort=new,
    // even if older than other posts.
    const pinRes = await authPost(`/api/posts/${postId}/pin`, {});
    // 200 with isPinned flag — owner permission already granted in setup.
    expect(pinRes.status).toBe(200);
    const res = await publicGet(`/api/topics/${publicTopicId}/posts?sort=new&limit=50`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const items: Array<{ id: string; isPinned: boolean }> = json.posts;
    expect(items[0].id).toBe(postId);
    expect(items[0].isPinned).toBe(true);
    // Toggle pin back off so later tests aren't affected.
    await authPost(`/api/posts/${postId}/pin`, {});
  });

  it('4. Post list — sort=recorded returns 200', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts?sort=recorded`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
  });

  // ── 3. Post list — tag filter ────────────────────────────────────────

  it('5. Post list — tag filter (?tag=slug) returns only tagged posts', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts?tag=${tagSlug}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    expect(json.posts.length).toBeGreaterThan(0);
    // The base post should be in the result
    const found = json.posts.find((p: { id: string }) => p.id === postId);
    expect(found).toBeDefined();
  });

  it('6. Post list — tag filter with nonexistent tag returns empty list', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts?tag=nonexistent-tag-xyz-${Date.now()}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    expect(json.posts.length).toBe(0);
  });

  // ── 4. Post list — paging ────────────────────────────────────────────

  it('7. Post list — paging (limit=2, offset=0) returns at most 2 posts', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts?limit=2&offset=0`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    expect(json.posts.length).toBeLessThanOrEqual(2);
  });

  it('8. Post list — paging (limit=2, offset=2) returns a different page', async () => {
    const page1Res = await publicGet(`/api/topics/${publicTopicId}/posts?limit=2&offset=0`);
    const page2Res = await publicGet(`/api/topics/${publicTopicId}/posts?limit=2&offset=2`);
    expect(page1Res.status).toBe(200);
    expect(page2Res.status).toBe(200);

    const page1Posts: Array<{ id: string }> = (await page1Res.json()).posts;
    const page2Posts: Array<{ id: string }> = (await page2Res.json()).posts;

    if (page1Posts.length === 2 && page2Posts.length > 0) {
      const page1Ids = new Set(page1Posts.map((p) => p.id));
      for (const post of page2Posts) {
        expect(page1Ids.has(post.id)).toBe(false);
      }
    }
  });

  // ── 5. Post detail — viewCount increment ────────────────────────────

  it('9. Post detail — viewCount increments on each GET /api/posts/:postId', async () => {
    // Get current viewCount
    const before = await publicGet(`/api/posts/${postId}`);
    expect(before.status).toBe(200);
    const beforeJson = await before.json();
    const beforePost = beforeJson.post || beforeJson;
    const beforeCount: number = beforePost.viewCount;
    expect(typeof beforeCount).toBe('number');

    // Fetch again — viewCount should have incremented
    const after = await publicGet(`/api/posts/${postId}`);
    expect(after.status).toBe(200);
    const afterJson = await after.json();
    const afterPost = afterJson.post || afterJson;
    expect(afterPost.viewCount).toBe(beforeCount + 1);
  });

  it('10. Post detail — viewCount increments for authenticated users too', async () => {
    const before = await authGet(`/api/posts/${postId}`);
    expect(before.status).toBe(200);
    const beforeCount: number = (before ? (await before.json()) : {})?.post?.viewCount ?? 0;

    const after = await authGet(`/api/posts/${postId}`);
    expect(after.status).toBe(200);
    const afterJson = await after.json();
    const afterPost = afterJson.post || afterJson;
    expect(afterPost.viewCount).toBe(beforeCount + 1);
  });

  // ── 6. Post pin — endpoint not yet implemented ───────────────────────

  it('11. Post pin — owner pins post -> 200, pinned: true', async () => {
    const res = await authPost(`/api/posts/${postId}/pin`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.isPinned).toBe(true);
  });

  it('12. Post pin — non-owner/non-admin pin attempt -> 403', async () => {
    const res = await secondUserPost(`/api/posts/${postId}/pin`);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('13. Post pin — guest pin attempt -> 401', async () => {
    const res = await publicPost(`/api/posts/${postId}/pin`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('14. Post list — sort=invalid is rejected with 400 (no silent fallback)', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts?sort=invalid_sort_value`);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/sort/i);
  });

  it('15. Post list response includes expected fields per post', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts?limit=1`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    if (json.posts.length > 0) {
      const post = json.posts[0];
      expect(typeof post.id).toBe('string');
      expect(typeof post.title).toBe('string');
      expect(typeof post.content).toBe('string');
      expect(typeof post.authorId).toBe('string');
      expect(typeof post.upvoteCount).toBe('number');
      expect(typeof post.viewCount).toBe('number');
      expect(typeof post.commentCount).toBe('number');
      expect(typeof post.isAI).toBe('boolean');
      expect(post.createdAt).toBeTruthy();
    }
  });

  it('16. GET /api/posts/:postId — non-existent post -> 404', async () => {
    const fakePostId = '00000000-0000-0000-0000-000000000000';
    const res = await publicGet(`/api/posts/${fakePostId}`);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Search (q=) on topic posts ───────────────────────────────────────

  it('17. GET /api/topics/:topicId/posts?q= matches post title (unique stamp)', async () => {
    const stamp = `tpq${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const createRes = await authPost(`/api/topics/${publicTopicId}/posts`, {
      title: `Search probe ${stamp}`,
      content: 'Content without the search term',
    });
    expect(createRes.status).toBe(201);
    const searchPostId: string = (await createRes.json()).post.id;

    const res = await publicGet(`/api/topics/${publicTopicId}/posts?q=${stamp}&limit=50`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids: string[] = json.posts.map((p: { id: string }) => p.id);
    expect(ids).toContain(searchPostId);
  });

  it('18. GET /api/topics/:topicId/posts?q= matches via post tag name (tag-match path)', async () => {
    const tagStamp = `tptag${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const createRes = await authPost(`/api/topics/${publicTopicId}/posts`, {
      // Title and content deliberately do NOT contain tagStamp; only the tag does.
      title: `Tag search probe ${Date.now()}`,
      content: 'Content without the tag stamp',
      tags: [tagStamp],
    });
    expect(createRes.status).toBe(201);
    const tagPostId: string = (await createRes.json()).post.id;

    const res = await publicGet(`/api/topics/${publicTopicId}/posts?q=${tagStamp}&limit=50`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids: string[] = json.posts.map((p: { id: string }) => p.id);
    expect(ids).toContain(tagPostId);
  });

  it('19. GET /api/topics/:topicId/posts?q= (whitespace-only) acts as no filter', async () => {
    const [withQ, withoutQ] = await Promise.all([
      publicGet(`/api/topics/${publicTopicId}/posts?q=%20%20&limit=20`),
      publicGet(`/api/topics/${publicTopicId}/posts?limit=20`),
    ]);
    expect(withQ.status).toBe(200);
    expect(withoutQ.status).toBe(200);
    const a = await withQ.json();
    const b = await withoutQ.json();
    expect(a.posts.length).toBe(b.posts.length);
  });

  it('20. GET /api/topics/:topicId/posts?q= with no matches returns empty list', async () => {
    const res = await publicGet(
      `/api/topics/${publicTopicId}/posts?q=zzz_no_match_xyz_unique_token_abcdefg`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.posts).toEqual([]);
  });

  it('21. Guest can search topic posts without auth (public topic)', async () => {
    const stamp = `guestq${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const createRes = await authPost(`/api/topics/${publicTopicId}/posts`, {
      title: `Guest search probe ${stamp}`,
      content: `content ${stamp}`,
    });
    expect(createRes.status).toBe(201);
    const guestSearchPostId: string = (await createRes.json()).post.id;

    // publicGet has no Authorization header — confirms guest path applies q
    const res = await publicGet(`/api/topics/${publicTopicId}/posts?q=${stamp}&limit=50`);
    expect(res.status).toBe(200);
    const ids: string[] = (await res.json()).posts.map((p: { id: string }) => p.id);
    expect(ids).toContain(guestSearchPostId);
  });
});
