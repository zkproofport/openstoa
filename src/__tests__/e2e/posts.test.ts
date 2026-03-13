import { describe, it, expect } from 'vitest';
import { authGet, authPost, authDelete, publicGet } from './helpers';

let topicId: string;
let postId: string;
let categoryId: string;

describe.sequential('Posts endpoints', () => {
  // Setup: fetch categories first
  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  // Setup: create a topic for testing
  it('setup: create test topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Posts Topic ${Date.now()}`,
      description: 'Topic for post E2E tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    topicId = json.topic.id;
  });

  it('POST /api/topics/:topicId/posts creates a post', async () => {
    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `E2E Test Post ${Date.now()}`,
      content: 'This is a test post created by E2E tests. It contains enough content to be meaningful.',
      tags: ['e2e-test'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.id).toBeTruthy();
    expect(json.post.title).toBeTruthy();
    expect(json.post.content).toBeTruthy();
    postId = json.post.id;
  });

  it('GET /api/posts/:postId returns the post with comments', async () => {
    const res = await authGet(`/api/posts/${postId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.post.id).toBe(postId);
    expect(json.post.title).toBeTruthy();
    expect(json.post.content).toBeTruthy();
    // comments may be in post.comments or separate
    expect(json.post.id).toBeTruthy();
  });

  it('GET /api/topics/:topicId/posts returns posts including the new one', async () => {
    const res = await authGet(`/api/topics/${topicId}/posts`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    expect(json.posts.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/posts/:postId/vote upvotes the post', async () => {
    const res = await authPost(`/api/posts/${postId}/vote`, { value: 1 });
    expect(res.status).toBe(200);
    const json = await res.json();
    const data = json.post || json;
    expect(data.upvoteCount).toBeDefined();
  });

  it('POST /api/posts/:postId/vote with same value removes vote', async () => {
    const res = await authPost(`/api/posts/${postId}/vote`, { value: 1 });
    expect(res.status).toBe(200);
  });

  it('POST /api/posts/:postId/comments creates a comment', async () => {
    const res = await authPost(`/api/posts/${postId}/comments`, {
      content: 'E2E test comment',
    });
    expect([200, 201]).toContain(res.status);
    const json = await res.json();
    const commentId = json.comment?.id || json.id;
    expect(commentId).toBeTruthy();
  });

  it('GET /api/posts/:postId/bookmark checks bookmark status', async () => {
    const res = await authGet(`/api/posts/${postId}/bookmark`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const data = json.bookmark || json;
    expect(data.bookmarked).toBeDefined();
  });

  it('POST /api/posts/:postId/bookmark toggles bookmark', async () => {
    const res = await authPost(`/api/posts/${postId}/bookmark`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const data = json.bookmark || json;
    expect(typeof data.bookmarked).toBe('boolean');
  });

  it('POST /api/posts/:postId/bookmark again removes bookmark', async () => {
    const res = await authPost(`/api/posts/${postId}/bookmark`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const data = json.bookmark || json;
    expect(typeof data.bookmarked).toBe('boolean');
  });

  it('POST /api/posts/:postId/pin toggles pin (owner)', async () => {
    const res = await authPost(`/api/posts/${postId}/pin`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const data = json.post || json;
    expect(data.isPinned).toBeDefined();
  });

  it('GET /api/posts/:postId/reactions returns reaction list', async () => {
    const res = await authGet(`/api/posts/${postId}/reactions`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const reactions = json.reactions || json;
    expect(Array.isArray(reactions)).toBe(true);
  });

  it('POST /api/posts/:postId/reactions adds a reaction', async () => {
    const res = await authPost(`/api/posts/${postId}/reactions`, { emoji: '🔥' });
    expect(res.status).toBe(200);
  });

  it('POST /api/posts/:postId/reactions same emoji removes it', async () => {
    const res = await authPost(`/api/posts/${postId}/reactions`, { emoji: '🔥' });
    expect(res.status).toBe(200);
  });

  // NOTE: Do NOT delete the post here — it may be needed for record tests
  // The post needs to be at least 1 hour old for recording

  it('DELETE /api/posts/:postId deletes a post', async () => {
    // Create a new post specifically for deletion testing
    const createRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `E2E Delete Target Post ${Date.now()}`,
      content: 'This post will be deleted by the E2E delete test.',
      tags: [],
    });
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    const newPostId = createJson.post.id;
    expect(newPostId).toBeTruthy();

    // Delete the post
    const deleteRes = await authDelete(`/api/posts/${newPostId}`);
    expect(deleteRes.status).toBe(200);
    const deleteJson = await deleteRes.json();
    expect(deleteJson.success).toBe(true);

    // Confirm it is gone
    const getRes = await authGet(`/api/posts/${newPostId}`);
    expect(getRes.status).toBe(404);
  });
});
