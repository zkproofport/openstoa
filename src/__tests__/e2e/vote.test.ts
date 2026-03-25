import { describe, it, expect } from 'vitest';
import {
  authPost,
  authGet,
  publicPost,
  secondUserPost,
  secondUserGet,
  getSecondUserToken,
} from './helpers';

let categoryId: string;
let topicId: string;
let postId: string;

describe.sequential('Votes (Upvote/Downvote)', () => {
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
      title: `E2E Vote Topic ${Date.now()}`,
      description: 'Topic for vote E2E tests',
      visibility: 'public',
      categoryId,
    });
    expect(topicRes.status).toBe(201);
    const topicJson = await topicRes.json();
    topicId = topicJson.topic.id;
    expect(topicId).toBeTruthy();

    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `E2E Vote Post ${Date.now()}`,
      content: 'Post for vote E2E tests.',
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

  // ── Upvote ─────────────────────────────────────────────────────────────

  it('1. Member upvotes post (value: 1) -> upvoteCount increases', async () => {
    const beforeRes = await authGet(`/api/posts/${postId}`);
    expect(beforeRes.status).toBe(200);
    const beforeJson = await beforeRes.json();
    const beforePost = beforeJson.post ?? beforeJson;
    const beforeCount: number = beforePost.upvoteCount ?? 0;

    const voteRes = await authPost(`/api/posts/${postId}/vote`, { value: 1 });
    expect(voteRes.status).toBe(200);
    const voteJson = await voteRes.json();
    expect(voteJson.vote).toEqual({ value: 1 });
    expect(voteJson.upvoteCount).toBe(beforeCount + 1);
  });

  // ── Toggle off (same vote again) ────────────────────────────────────────

  it('2. Sending same vote again (value: 1) cancels the vote -> upvoteCount decreases', async () => {
    const beforeRes = await authGet(`/api/posts/${postId}`);
    expect(beforeRes.status).toBe(200);
    const beforeJson = await beforeRes.json();
    const beforePost = beforeJson.post ?? beforeJson;
    const beforeCount: number = beforePost.upvoteCount;

    const voteRes = await authPost(`/api/posts/${postId}/vote`, { value: 1 });
    expect(voteRes.status).toBe(200);
    const voteJson = await voteRes.json();
    expect(voteJson.vote).toBeNull();
    expect(voteJson.upvoteCount).toBe(beforeCount - 1);
  });

  // ── Downvote ────────────────────────────────────────────────────────────

  it('3. Member downvotes post (value: -1) -> upvoteCount decreases', async () => {
    const beforeRes = await authGet(`/api/posts/${postId}`);
    expect(beforeRes.status).toBe(200);
    const beforeJson = await beforeRes.json();
    const beforePost = beforeJson.post ?? beforeJson;
    const beforeCount: number = beforePost.upvoteCount ?? 0;

    const voteRes = await authPost(`/api/posts/${postId}/vote`, { value: -1 });
    expect(voteRes.status).toBe(200);
    const voteJson = await voteRes.json();
    expect(voteJson.vote).toEqual({ value: -1 });
    expect(voteJson.upvoteCount).toBe(beforeCount - 1);
  });

  it('4. Sending same downvote again (value: -1) cancels the vote -> upvoteCount increases', async () => {
    const beforeRes = await authGet(`/api/posts/${postId}`);
    expect(beforeRes.status).toBe(200);
    const beforeJson = await beforeRes.json();
    const beforePost = beforeJson.post ?? beforeJson;
    const beforeCount: number = beforePost.upvoteCount;

    const voteRes = await authPost(`/api/posts/${postId}/vote`, { value: -1 });
    expect(voteRes.status).toBe(200);
    const voteJson = await voteRes.json();
    expect(voteJson.vote).toBeNull();
    expect(voteJson.upvoteCount).toBe(beforeCount + 1);
  });

  // ── Vote switching ──────────────────────────────────────────────────────

  it('5. Switching from upvote to downvote -> upvoteCount adjusts by -2', async () => {
    // First cast an upvote
    const upRes = await authPost(`/api/posts/${postId}/vote`, { value: 1 });
    expect(upRes.status).toBe(200);
    const upJson = await upRes.json();
    const afterUpCount: number = upJson.upvoteCount;

    // Then switch to downvote — delta should be -2
    const downRes = await authPost(`/api/posts/${postId}/vote`, { value: -1 });
    expect(downRes.status).toBe(200);
    const downJson = await downRes.json();
    expect(downJson.vote).toEqual({ value: -1 });
    expect(downJson.upvoteCount).toBe(afterUpCount - 2);

    // Clean up: cancel the downvote
    const cancelRes = await authPost(`/api/posts/${postId}/vote`, { value: -1 });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.ok).toBe(true);
  });

  // ── User B votes (non-member) ───────────────────────────────────────────

  it('6. Non-member (User B) votes on post -> 403 (membership check enforced)', async () => {
    // The vote route checks topic membership — non-members are rejected.
    const voteRes = await secondUserPost(`/api/posts/${postId}/vote`, { value: 1 });
    expect(voteRes.status).toBe(403);
    const voteJson = await voteRes.json();
    expect(voteJson.error).toBeTruthy();
  });

  // ── Guest (unauthenticated) ─────────────────────────────────────────────

  it('7. Guest (unauthenticated) votes -> 401', async () => {
    const res = await publicPost(`/api/posts/${postId}/vote`, { value: 1 });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Invalid vote value ──────────────────────────────────────────────────

  it('8. Invalid vote value (0) -> 400', async () => {
    const res = await authPost(`/api/posts/${postId}/vote`, { value: 0 });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Value must be 1 or -1');
  });

  it('9. Invalid vote value (2) -> 400', async () => {
    const res = await authPost(`/api/posts/${postId}/vote`, { value: 2 });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Value must be 1 or -1');
  });

  // ── Non-existent post ───────────────────────────────────────────────────

  it('10. Vote on non-existent post -> 404', async () => {
    const fakePostId = '00000000-0000-0000-0000-000000000000';
    const res = await authPost(`/api/posts/${fakePostId}/vote`, { value: 1 });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });
});
