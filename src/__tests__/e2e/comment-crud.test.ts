import { describe, it, expect } from 'vitest';
import {
  authPost,
  authGet,
  authDelete,
  publicGet,
  publicPost,
  publicDelete,
  secondUserPost,
  secondUserGet,
  secondUserDelete,
  getSecondUserToken,
} from './helpers';

let categoryId: string;
let publicTopicId: string;
let postId: string;

describe.sequential('Comments CRUD + Permission', () => {
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
      title: `E2E Comment CRUD ${Date.now()}`,
      description: 'Public topic for comment CRUD tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.topic.id).toBeTruthy();
    publicTopicId = json.topic.id;
  });

  it('setup: User A creates a post in the topic', async () => {
    const res = await authPost(`/api/topics/${publicTopicId}/posts`, {
      title: `E2E Comment Target Post ${Date.now()}`,
      content: 'This post exists for comment CRUD tests.',
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.id).toBeTruthy();
    postId = json.post.id;
  });

  it('setup: ensure User B exists', async () => {
    const { token, userId } = await getSecondUserToken();
    expect(token).toBeTruthy();
    expect(userId).toBeTruthy();
  });

  it('setup: User B joins the topic', async () => {
    const res = await secondUserPost(`/api/topics/${publicTopicId}/join`);
    expect([201, 409]).toContain(res.status);
  });

  // ── Create ─────────────────────────────────────────────────────────────

  it('1. Member creates comment -> 201', async () => {
    const content = `E2E comment by User A ${Date.now()}`;
    const res = await authPost(`/api/posts/${postId}/comments`, { content });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.comment).toBeDefined();
    expect(json.comment.id).toBeTruthy();
    expect(json.comment.content).toBe(content);
    expect(json.comment.authorNickname).toBeTruthy();
  });

  it('2. Non-member creates comment -> 403', async () => {
    // Create a separate topic where User B is NOT a member
    const topicRes = await authPost('/api/topics', {
      title: `E2E No-Member Topic ${Date.now()}`,
      description: 'Topic where User B is not a member',
      visibility: 'public',
      categoryId,
    });
    expect(topicRes.status).toBe(201);
    const topicJson = await topicRes.json();
    const isolatedTopicId = topicJson.topic.id;

    // User A creates a post in the isolated topic
    const postRes = await authPost(`/api/topics/${isolatedTopicId}/posts`, {
      title: `E2E Isolated Post ${Date.now()}`,
      content: 'Post in a topic where User B has not joined.',
    });
    expect(postRes.status).toBe(201);
    const postJson = await postRes.json();
    const isolatedPostId = postJson.post.id;

    // User B (not a member of this topic) tries to comment
    const res = await secondUserPost(`/api/posts/${isolatedPostId}/comments`, {
      content: 'Should be forbidden',
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('3. Guest (unauthenticated) creates comment -> 401', async () => {
    const res = await publicPost(`/api/posts/${postId}/comments`, {
      content: 'Should be unauthorized',
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('4. Empty content -> 400', async () => {
    const res = await authPost(`/api/posts/${postId}/comments`, {
      content: '',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Read ───────────────────────────────────────────────────────────────

  it('5. Post detail returns comment list with authorNickname and badges', async () => {
    // Add a second comment from User B so we verify multiple comments
    const userBContent = `E2E comment by User B ${Date.now()}`;
    const createRes = await secondUserPost(`/api/posts/${postId}/comments`, {
      content: userBContent,
    });
    expect(createRes.status).toBe(201);

    // Fetch post detail
    const res = await authGet(`/api/posts/${postId}`);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(Array.isArray(json.comments)).toBe(true);
    expect(json.comments.length).toBeGreaterThanOrEqual(2);

    // Verify comment structure
    for (const comment of json.comments) {
      expect(comment.id).toBeTruthy();
      expect(comment.content).toBeTruthy();
      expect(comment.authorNickname).toBeTruthy();
      expect(Array.isArray(comment.badges)).toBe(true);
      expect(comment.createdAt).toBeTruthy();
    }

    // Verify User B's comment is present
    const userBComment = json.comments.find(
      (c: { content: string }) => c.content === userBContent,
    );
    expect(userBComment).toBeDefined();
    expect(userBComment.authorNickname).toBeTruthy();
  });

  // ── Delete ─────────────────────────────────────────────────────────────

  let userBCommentId: string;
  let userACommentId: string;
  let adminDeleteTargetCommentId: string;

  it('6. Author deletes own comment -> 200', async () => {
    // User B creates a comment
    const createRes = await secondUserPost(`/api/posts/${postId}/comments`, {
      content: `E2E delete-by-author ${Date.now()}`,
    });
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    userBCommentId = createJson.comment.id;

    // User B deletes own comment
    const deleteRes = await secondUserDelete(`/api/comments/${userBCommentId}`);
    expect(deleteRes.status).toBe(200);
    const deleteJson = await deleteRes.json();
    expect(deleteJson.success).toBe(true);
    expect(deleteJson.deletedBy).toBe('author');

    // Verify in post detail: comment still in list but marked deleted
    const detailRes = await authGet(`/api/posts/${postId}`);
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    const deleted = detailJson.comments.find(
      (c: { id: string }) => c.id === userBCommentId,
    );
    expect(deleted).toBeDefined();
    expect(deleted.isDeleted).toBe(true);
    expect(deleted.deletedBy).toBe('author');
  });

  it('7. Non-author deletes comment -> 403', async () => {
    // User A creates a comment
    const createRes = await authPost(`/api/posts/${postId}/comments`, {
      content: `E2E non-author-delete-target ${Date.now()}`,
    });
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    userACommentId = createJson.comment.id;

    // User B (not the author, not owner/admin) tries to delete it
    const deleteRes = await secondUserDelete(`/api/comments/${userACommentId}`);
    expect(deleteRes.status).toBe(403);
  });

  it('8. Owner/admin deletes another member comment -> 200', async () => {
    // User B creates a comment
    const createRes = await secondUserPost(`/api/posts/${postId}/comments`, {
      content: `E2E admin-delete-target ${Date.now()}`,
    });
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    adminDeleteTargetCommentId = createJson.comment.id;

    // User A (topic owner) deletes User B's comment
    const deleteRes = await authDelete(`/api/comments/${adminDeleteTargetCommentId}`);
    expect(deleteRes.status).toBe(200);
    const deleteJson = await deleteRes.json();
    expect(deleteJson.success).toBe(true);
    expect(deleteJson.deletedBy).toBe('admin');

    // Verify in post detail
    const detailRes = await authGet(`/api/posts/${postId}`);
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    const deleted = detailJson.comments.find(
      (c: { id: string }) => c.id === adminDeleteTargetCommentId,
    );
    expect(deleted).toBeDefined();
    expect(deleted.isDeleted).toBe(true);
    expect(deleted.deletedBy).toBe('admin');
  });

  it('9. Guest deletes comment -> 401', async () => {
    // Use userACommentId from test 7 (still exists, not deleted)
    const res = await publicDelete(`/api/comments/${userACommentId}`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('10. Deleted comment content is hidden in post detail', async () => {
    // Fetch post detail and inspect a deleted comment (userBCommentId from test 6)
    const res = await authGet(`/api/posts/${postId}`);
    expect(res.status).toBe(200);
    const json = await res.json();

    const deletedComment = json.comments.find(
      (c: { id: string }) => c.id === userBCommentId,
    );
    expect(deletedComment).toBeDefined();
    expect(deletedComment.isDeleted).toBe(true);
    // Content should be empty or null
    expect(deletedComment.content === '' || deletedComment.content === null).toBe(true);
    // Author info should be hidden
    expect(deletedComment.authorNickname === '' || deletedComment.authorNickname === null).toBe(true);
  });
});
