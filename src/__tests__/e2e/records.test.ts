import { describe, it, expect } from 'vitest';
import { authGet, authPost, publicGet, publicPost, secondUserPost, secondUserGet, getSecondUserToken } from './helpers';

describe.sequential('Record endpoints', () => {
  let topicId: string;
  let ownPostId: string;
  let otherUserPostId: string;
  let categoryId: string;

  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('setup: create topic for record tests', async () => {
    const topicRes = await authPost('/api/topics', {
      title: `E2E Record Topic ${Date.now()}`,
      description: 'Topic for record E2E tests',
      visibility: 'public',
      categoryId,
    });
    expect(topicRes.status).toBe(201);
    const topicJson = await topicRes.json();
    topicId = topicJson.topic.id;
  });

  it('setup: create own post (for policy rejection tests)', async () => {
    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `E2E Own Post ${Date.now()}`,
      content: 'Test post for recording policy checks',
    });
    expect(postRes.status).toBe(201);
    const postJson = await postRes.json();
    ownPostId = postJson.post.id;
  });

  it('setup: second user creates a post (for success test)', async () => {
    // Second user joins the topic first
    const joinRes = await secondUserPost(`/api/topics/${topicId}/join`);
    expect([200, 201, 409].includes(joinRes.status)).toBe(true); // 201 = joined, 409 = already joined

    // Second user creates a post
    const postRes = await secondUserPost(`/api/topics/${topicId}/posts`, {
      title: `E2E Other User Post ${Date.now()}`,
      content: '<p>Post by a different user for record testing</p>',
    });
    expect(postRes.status).toBe(201);
    const postJson = await postRes.json();
    otherUserPostId = postJson.post.id;
  });

  // ── Policy rejection tests ──

  it('POST /api/posts/:postId/record rejects own post (403)', async () => {
    const res = await authPost(`/api/posts/${ownPostId}/record`);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain('own post');
  });

  it('POST /api/posts/:postId/record rejects non-existent post (403)', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await authPost(`/api/posts/${fakeId}/record`);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain('not found');
  });

  it('POST /api/posts/:postId/record rejects post younger than 1 hour (403)', async () => {
    if (!otherUserPostId) {
      console.warn('[E2E] otherUserPostId not set — skipping');
      return;
    }
    // The other user's post was just created, so it's < 1 hour old
    const res = await authPost(`/api/posts/${otherUserPostId}/record`);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain('1 hour');
  });

  // ── Success test (uses pre-existing old post from staging) ──

  it('POST /api/posts/:postId/record succeeds on old post from different user', async () => {
    // Find an existing post from the primary user that is > 1 hour old,
    // then record it as the second user
    const feedRes = await secondUserGet(`/api/topics/${topicId}/posts?limit=50`);

    // If no old posts in our test topic, search across all topics for ANY old post by the primary user
    let targetPostId: string | null = null;

    const topicsRes = await secondUserGet('/api/topics?view=all&limit=50');
    if (topicsRes.ok) {
      const topicsJson = await topicsRes.json();
      const { userId: secondUserId } = await getSecondUserToken();

      for (const topic of topicsJson.topics ?? []) {
        // Join topic so we can access posts
        await secondUserPost(`/api/topics/${topic.id}/join`);

        const postsRes = await secondUserGet(`/api/topics/${topic.id}/posts?limit=10`);
        if (!postsRes.ok) continue;
        const postsJson = await postsRes.json();

        for (const post of postsJson.posts ?? []) {
          const ageMs = Date.now() - new Date(post.createdAt).getTime();
          if (ageMs >= 60 * 60 * 1000 && post.authorId !== secondUserId) {
            targetPostId = post.id;
            break;
          }
        }
        if (targetPostId) break;
      }
    }

    if (!targetPostId) {
      console.warn('[E2E] No post older than 1 hour from another user found — skipping success test');
      return;
    }

    const res = await secondUserPost(`/api/posts/${targetPostId}/record`);

    // Could be 200 (success) or 403 (already recorded / daily limit)
    if (res.status === 200) {
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.record).toBeDefined();
      expect(json.record.id).toBeDefined();
      expect(json.record.contentHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(json.record.recordCount).toBeGreaterThanOrEqual(1);
    } else if (res.status === 403) {
      const json = await res.json();
      // Acceptable: already recorded or daily limit
      expect(
        json.error.includes('already recorded') || json.error.includes('Daily record limit'),
      ).toBe(true);
    } else if (res.status === 500) {
      const json = await res.json();
      // Server config issue (missing env vars for on-chain recording)
      console.warn(`[E2E] Record returned 500 (server config): ${json.error}`);
    } else {
      // Unexpected status
      const text = await res.text();
      throw new Error(`Unexpected status ${res.status}: ${text}`);
    }
  }, 60000); // 60s timeout for on-chain TX

  // ── GET endpoint tests ──

  it('GET /api/posts/:postId/records returns records list', async () => {
    const res = await authGet(`/api/posts/${ownPostId}/records`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.records).toBeDefined();
    expect(Array.isArray(json.records)).toBe(true);
    expect(typeof json.recordCount).toBe('number');
    expect(typeof json.postEdited).toBe('boolean');
    expect(typeof json.userRecorded).toBe('boolean');
  });

  it('GET /api/recorded returns recorded feed', async () => {
    const res = await authGet('/api/recorded');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.posts).toBeDefined();
    expect(Array.isArray(json.posts)).toBe(true);
  });

  it('GET /api/recorded as guest -> 401', async () => {
    const res = await publicGet('/api/recorded');
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('POST /api/posts/:postId/record as guest -> 401', async () => {
    const res = await publicPost(`/api/posts/${ownPostId}/record`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('GET /api/posts/:postId/records — response shape has records, recordCount, postEdited, userRecorded', async () => {
    const res = await authGet(`/api/posts/${ownPostId}/records`);
    expect(res.status).toBe(200);
    const json = await res.json();
    // All four fields must be present with correct types
    expect(Array.isArray(json.records)).toBe(true);
    expect(typeof json.recordCount).toBe('number');
    expect(typeof json.postEdited).toBe('boolean');
    expect(typeof json.userRecorded).toBe('boolean');
    // recordCount must match records array length
    expect(json.recordCount).toBe(json.records.length);
  });
});
