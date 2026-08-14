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
let privateTopicId: string;
let privatePostId: string;
let secretTopicId: string;
let secretPostId: string;

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
    // dev-login session is not AI — isAI should be false
    expect(json.post.isAI).toBe(false);
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

  it('4b. Create post: a NUL byte in title or content is rejected with a clean 400 (Postgres text cannot store it)', async () => {
    const NUL = String.fromCharCode(0);
    const withNulTitle = await authPost(`/api/topics/${publicTopicId}/posts`, {
      title: `bad${NUL}title`,
      content: 'valid content',
    });
    expect(withNulTitle.status).toBe(400);
    expect((await withNulTitle.json()).error).toBe('Title must not contain a NUL byte');

    const withNulContent = await authPost(`/api/topics/${publicTopicId}/posts`, {
      title: `E2E NUL content ${Date.now()}`,
      content: `bad${NUL}content`,
    });
    expect(withNulContent.status).toBe(400);
    expect((await withNulContent.json()).error).toBe('Content must not contain a NUL byte');
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

  it('6. Requesting posts from non-existent topic returns 404 (guest)', async () => {
    // Confirms the server returns 404 for a topic that does not exist,
    // rather than silently returning empty data for an invalid topic id.
    // Non-member read authz on real private/secret topics is 6b-6f below.
    const fakeTopicId = '00000000-0000-0000-0000-000000000000';
    const res = await publicGet(`/api/topics/${fakeTopicId}/posts`);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // 6b: real private/secret topics via POST /api/topics — private/secret
  // creation works fine over the API (VALID_VISIBILITIES in
  // src/app/api/topics/route.ts includes both; media-gate.test.ts already
  // creates both this way). GET /api/topics/{topicId}/posts documents its
  // own rule in its OpenAPI block: `public` is open to anyone, `secret` is
  // members-only, but `private` gates only the topic's CHAT — its post list
  // is readable by any SIGNED-IN user, member or not. So "non-member" does
  // NOT mean one status code here; it means four distinct combinations.
  it('6b. setup: User A creates a private topic + a secret topic, each with one post', async () => {
    const privateRes = await authPost('/api/topics', {
      title: `E2E CRUD Private ${Date.now()}`,
      description: 'Private topic for post read-authz tests',
      visibility: 'private',
      categoryId,
    });
    expect(privateRes.status).toBe(201);
    privateTopicId = (await privateRes.json()).topic.id;
    const privatePostRes = await authPost(`/api/topics/${privateTopicId}/posts`, {
      title: `E2E CRUD Private Post ${Date.now()}`,
      content: 'Content in a private topic.',
    });
    expect(privatePostRes.status).toBe(201);
    privatePostId = (await privatePostRes.json()).post.id;

    const secretRes = await authPost('/api/topics', {
      title: `E2E CRUD Secret ${Date.now()}`,
      description: 'Secret topic for post read-authz tests',
      visibility: 'secret',
      categoryId,
    });
    expect(secretRes.status).toBe(201);
    secretTopicId = (await secretRes.json()).topic.id;
    const secretPostRes = await authPost(`/api/topics/${secretTopicId}/posts`, {
      title: `E2E CRUD Secret Post ${Date.now()}`,
      content: 'Content in a secret topic.',
    });
    expect(secretPostRes.status).toBe(201);
    secretPostId = (await secretPostRes.json()).post.id;

    // Sanity check on the fixture itself: the owner (a real member) can see
    // the secret post. Without this, 6f's 403 would be indistinguishable from
    // a setup bug (e.g. the post never actually landed in that topic).
    const ownerRead = await authGet(`/api/topics/${secretTopicId}/posts`);
    expect(ownerRead.status).toBe(200);
    const ownerIds = (await ownerRead.json()).posts.map((p: { id: string }) => p.id);
    expect(ownerIds).toContain(secretPostId);
  });

  it('6c. Guest reads posts in a PRIVATE topic -> 401', async () => {
    const res = await publicGet(`/api/topics/${privateTopicId}/posts`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('6d. Guest reads posts in a SECRET topic -> 401 (not 404 — same 401 as private; the route never gets far enough to distinguish visibility for a guest, unlike GET /api/topics/{topicId} which 404s secret topics to hide their existence)', async () => {
    const res = await publicGet(`/api/topics/${secretTopicId}/posts`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('6e. Signed-in NON-MEMBER reads posts in a PRIVATE topic -> 200, sees the post (private gates the topic\'s CHAT, not its posts — src/app/api/topics/[topicId]/posts/route.ts\'s own comment on this branch)', async () => {
    const res = await secondUserGet(`/api/topics/${privateTopicId}/posts`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = json.posts.map((p: { id: string }) => p.id);
    expect(ids).toContain(privatePostId);
  });

  it('6f. Signed-in NON-MEMBER reads posts in a SECRET topic -> 403 (reveals existence via 403, unlike GET /api/topics/{topicId} which 404s a secret topic for a non-member)', async () => {
    const res = await secondUserGet(`/api/topics/${secretTopicId}/posts`);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

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
    expect(deleteJson.isDeleted).toBe(true);

    // Soft-delete: row stays, but isDeleted flips
    const getRes = await authGet(`/api/posts/${disposablePostId}`);
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).post.isDeleted).toBe(true);
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
    expect(deleteJson.isDeleted).toBe(true);

    // Soft-delete: row stays, but isDeleted flips
    const getRes = await authGet(`/api/posts/${userBPostId}`);
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).post.isDeleted).toBe(true);
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

  it('14b. Edit post: a NUL byte in title or content is rejected with a clean 400', async () => {
    const NUL = String.fromCharCode(0);
    const withNulTitle = await authPatch(`/api/posts/${postId}`, { title: `bad${NUL}title` });
    expect(withNulTitle.status).toBe(400);
    expect((await withNulTitle.json()).error).toBe('Title must not contain a NUL byte');

    const withNulContent = await authPatch(`/api/posts/${postId}`, { content: `bad${NUL}content` });
    expect(withNulContent.status).toBe(400);
    expect((await withNulContent.json()).error).toBe('Content must not contain a NUL byte');
  });
});
