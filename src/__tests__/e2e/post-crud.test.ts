import { describe, it, expect } from 'vitest';
import {
  authPost,
  authGet,
  authPatch,
  authDelete,
  publicGet,
  publicPost,
  publicPatch,
  publicDelete,
  secondUserPost,
  secondUserGet,
  secondUserPatch,
  secondUserDelete,
  getSecondUserToken,
} from './helpers';

let categoryId: string;
let publicTopicId: string;
let postId: string;
let userBPostId: string;

describe.sequential('Post CRUD + Permission', () => {
  // ── Setup ──────────────────────────────────────────────────────────────

  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.categories)).toBe(true);
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('setup: User A creates a public topic (becomes owner)', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E CRUD Public ${Date.now()}`,
      description: 'Public topic for post CRUD tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.topic.id).toBeTruthy();
    publicTopicId = json.topic.id;
  });

  it('setup: ensure User B exists', async () => {
    const { token, userId } = await getSecondUserToken();
    expect(token).toBeTruthy();
    expect(userId).toBeTruthy();
  });

  // ── Create ─────────────────────────────────────────────────────────────

  it('1. Member creates post with title + content -> 201', async () => {
    const title = `E2E CRUD Post ${Date.now()}`;
    const content = 'This post was created by User A (topic owner) for CRUD tests.';
    const res = await authPost(`/api/topics/${publicTopicId}/posts`, {
      title,
      content,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post).toBeDefined();
    expect(json.post.id).toBeTruthy();
    expect(json.post.title).toBe(title);
    expect(json.post.content).toBe(content);
    postId = json.post.id;
  });

  it('2. Non-member creates post -> 403', async () => {
    // User B is not a member of the public topic yet
    const res = await secondUserPost(`/api/topics/${publicTopicId}/posts`, {
      title: 'Should be forbidden',
      content: 'User B is not a member.',
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('3. Guest (unauthenticated) creates post -> 401', async () => {
    const res = await publicPost(`/api/topics/${publicTopicId}/posts`, {
      title: 'Should be unauthorized',
      content: 'No auth token.',
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('4. Missing required field (no title) -> 400', async () => {
    const res = await authPost(`/api/topics/${publicTopicId}/posts`, {
      content: 'No title provided.',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Read ───────────────────────────────────────────────────────────────

  it('5. Guest reads post in public topic -> 200', async () => {
    const res = await publicGet(`/api/posts/${postId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const post = json.post || json;
    expect(post.id).toBe(postId);
    expect(post.title).toBeTruthy();
    expect(post.content).toBeTruthy();
  });

  it('6. Requesting posts from non-existent topic returns 404', async () => {
    // NOTE: Private/secret topics cannot be created via the API (returns 400),
    // so we cannot test non-member read denial on a real private topic.
    // Instead, this test verifies that the server returns 404 for a topic
    // that does not exist, confirming the server does not silently return
    // empty data for invalid topic IDs.
    const fakeTopicId = '00000000-0000-0000-0000-000000000000';
    const res = await publicGet(`/api/topics/${fakeTopicId}/posts`);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it.todo('6b. Non-member reads posts in private/secret topic -> 403 (needs API support for creating private topics)');

  // ── Update ─────────────────────────────────────────────────────────────

  it('7. Author edits own post -> 200 and changes persist', async () => {
    // Capture the original state for comparison
    const beforeRes = await authGet(`/api/posts/${postId}`);
    expect(beforeRes.status).toBe(200);
    const beforeJson = await beforeRes.json();
    const beforePost = beforeJson.post || beforeJson;
    const originalUpdatedAt = beforePost.updatedAt;

    const updatedTitle = `E2E CRUD Post Updated ${Date.now()}`;
    const updatedContent = 'This content has been updated by the author.';
    const patchRes = await authPatch(`/api/posts/${postId}`, {
      title: updatedTitle,
      content: updatedContent,
    });
    expect(patchRes.status).toBe(200);
    const patchJson = await patchRes.json();
    const patchedPost = patchJson.post || patchJson;
    expect(patchedPost.title).toBe(updatedTitle);
    expect(patchedPost.content).toBe(updatedContent);

    // Verify updatedAt changed
    if (originalUpdatedAt) {
      expect(patchedPost.updatedAt).not.toBe(originalUpdatedAt);
    }

    // Verify changes persisted via a separate GET request
    const afterRes = await authGet(`/api/posts/${postId}`);
    expect(afterRes.status).toBe(200);
    const afterJson = await afterRes.json();
    const afterPost = afterJson.post || afterJson;
    expect(afterPost.title).toBe(updatedTitle);
    expect(afterPost.content).toBe(updatedContent);
  });

  it('8. Non-author edits post -> 403 and post remains unchanged', async () => {
    // Read the post before the attempted edit
    const beforeRes = await authGet(`/api/posts/${postId}`);
    expect(beforeRes.status).toBe(200);
    const beforeJson = await beforeRes.json();
    const beforePost = beforeJson.post || beforeJson;
    const originalTitle = beforePost.title;
    const originalContent = beforePost.content;

    // User B attempts to edit User A's post
    const patchRes = await secondUserPatch(`/api/posts/${postId}`, {
      title: 'Attempted hijack',
      content: 'User B should not be able to edit User A post.',
    });
    expect(patchRes.status).toBe(403);
    const patchJson = await patchRes.json();
    expect(patchJson.error).toBeTruthy();

    // Verify the post was NOT modified
    const afterRes = await authGet(`/api/posts/${postId}`);
    expect(afterRes.status).toBe(200);
    const afterJson = await afterRes.json();
    const afterPost = afterJson.post || afterJson;
    expect(afterPost.title).toBe(originalTitle);
    expect(afterPost.content).toBe(originalContent);
  });

  // ── Delete ─────────────────────────────────────────────────────────────

  it('9. Author deletes own post -> 200', async () => {
    // Create a disposable post for deletion
    const createRes = await authPost(`/api/topics/${publicTopicId}/posts`, {
      title: `E2E Delete Target ${Date.now()}`,
      content: 'This post will be deleted by its author.',
    });
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    const disposablePostId = createJson.post.id;

    const deleteRes = await authDelete(`/api/posts/${disposablePostId}`);
    expect(deleteRes.status).toBe(200);
    const deleteJson = await deleteRes.json();
    expect(deleteJson.success).toBe(true);

    // Confirm deletion
    const getRes = await authGet(`/api/posts/${disposablePostId}`);
    expect(getRes.status).toBe(404);
  });

  it('10. Non-author deletes post -> 403', async () => {
    // User B tries to delete User A's main post
    const res = await secondUserDelete(`/api/posts/${postId}`);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('11. Owner deletes another member post -> 200', async () => {
    // Step 1: User B joins the public topic
    const joinRes = await secondUserPost(`/api/topics/${publicTopicId}/join`);
    expect([201, 409]).toContain(joinRes.status); // 201 joined, 409 if already joined

    // Step 2: User B creates a post in the topic
    const createRes = await secondUserPost(`/api/topics/${publicTopicId}/posts`, {
      title: `E2E UserB Post ${Date.now()}`,
      content: 'Post created by User B, to be deleted by topic owner.',
    });
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    userBPostId = createJson.post.id;
    expect(userBPostId).toBeTruthy();

    // Step 3: User A (owner) deletes User B's post
    const deleteRes = await authDelete(`/api/posts/${userBPostId}`);
    expect(deleteRes.status).toBe(200);
    const deleteJson = await deleteRes.json();
    expect(deleteJson.success).toBe(true);

    // Confirm deletion
    const getRes = await authGet(`/api/posts/${userBPostId}`);
    expect(getRes.status).toBe(404);
  });

  // ── Guest (unauthenticated) edit/delete ────────────────────────────────

  it('12. Guest (unauthenticated) edits post -> 401', async () => {
    const res = await publicPatch(`/api/posts/${postId}`, {
      title: 'hacked',
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('13. Guest (unauthenticated) deletes post -> 401', async () => {
    const res = await publicDelete(`/api/posts/${postId}`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Edit validation ────────────────────────────────────────────────────

  it('14. Edit post with empty body (no title, no content) -> 400', async () => {
    const res = await authPatch(`/api/posts/${postId}`, {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });
});
