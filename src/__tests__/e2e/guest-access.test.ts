import { describe, it, expect } from 'vitest';
import {
  publicGet,
  publicPost,
  publicPut,
  publicDelete,
  authGet,
  authPost,
} from './helpers';

describe.sequential('Guest access', () => {
  let publicTopicId: string;
  let privateTopicId: string;
  let secretTopicId: string;
  let publicPostId: string;
  let privatePostId: string;
  let categoryId: string;

  // ── Setup: create resources needed for tests ──────────────────────────

  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('setup: create public topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Guest Public ${Date.now()}`,
      description: 'Public topic for guest access tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    publicTopicId = json.topic.id;
  });

  it('setup: create private topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Guest Private ${Date.now()}`,
      description: 'Private topic for guest access tests',
      visibility: 'private',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    privateTopicId = json.topic.id;
  });

  it('setup: create secret topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Guest Secret ${Date.now()}`,
      description: 'Secret topic for guest access tests',
      visibility: 'secret',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    secretTopicId = json.topic.id;
  });

  it('setup: create post in public topic', async () => {
    const res = await authPost(`/api/topics/${publicTopicId}/posts`, {
      title: `E2E Guest Post ${Date.now()}`,
      content: 'Post content visible to guests',
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    publicPostId = json.post.id;
  });

  it('setup: create post in private topic', async () => {
    const res = await authPost(`/api/topics/${privateTopicId}/posts`, {
      title: `E2E Guest Private Post ${Date.now()}`,
      content: 'Post content in private topic',
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    privatePostId = json.post.id;
  });

  // ── Section 1: Guest-allowed endpoints ────────────────────────────────

  // GET /api/topics?view=all
  it('GET /api/topics?view=all returns 200 for guests', async () => {
    const res = await publicGet('/api/topics?view=all');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.topics)).toBe(true);
    const topicIds = json.topics.map((t: any) => t.id);
    expect(topicIds).toContain(publicTopicId);
    expect(topicIds).toContain(privateTopicId);
    expect(topicIds).not.toContain(secretTopicId);
  });

  it('GET /api/topics?view=all returns 200 for authenticated users', async () => {
    const res = await authGet('/api/topics?view=all');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.topics)).toBe(true);
  });

  // GET /api/topics (no view=all)
  it('GET /api/topics returns 200 with empty array for guests', async () => {
    const res = await publicGet('/api/topics');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.topics).toEqual([]);
  });

  it('GET /api/topics returns 200 with user topics for authenticated users', async () => {
    const res = await authGet('/api/topics');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.topics)).toBe(true);
  });

  // GET /api/topics/:publicId
  it('GET /api/topics/:publicId returns 200 for guests', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topic = json.topic || json;
    expect(topic.id).toBe(publicTopicId);
  });

  it('GET /api/topics/:publicId returns 200 for authenticated users', async () => {
    const res = await authGet(`/api/topics/${publicTopicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topic = json.topic || json;
    expect(topic.id).toBe(publicTopicId);
  });

  // GET /api/topics/:privateId
  it('GET /api/topics/:privateId returns 200 for guests', async () => {
    const res = await publicGet(`/api/topics/${privateTopicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topic = json.topic || json;
    expect(topic.id).toBe(privateTopicId);
  });

  it('GET /api/topics/:privateId returns 200 for authenticated users', async () => {
    const res = await authGet(`/api/topics/${privateTopicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topic = json.topic || json;
    expect(topic.id).toBe(privateTopicId);
  });

  // GET /api/topics/:secretId
  it('GET /api/topics/:secretId returns 404 for guests', async () => {
    const res = await publicGet(`/api/topics/${secretTopicId}`);
    expect(res.status).toBe(404);
  });

  it('GET /api/topics/:secretId returns 200 for authenticated member', async () => {
    const res = await authGet(`/api/topics/${secretTopicId}`);
    expect(res.status).toBe(200);
  });

  // GET /api/topics/:publicId/posts
  it('GET /api/topics/:publicId/posts returns 200 for guests', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    expect(json.posts.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/topics/:publicId/posts returns 200 for authenticated users', async () => {
    const res = await authGet(`/api/topics/${publicTopicId}/posts`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
  });

  // GET /api/topics/:privateId/posts
  it('GET /api/topics/:privateId/posts without auth returns 401 or 403', async () => {
    const res = await publicGet(`/api/topics/${privateTopicId}/posts`);
    expect([401, 403]).toContain(res.status);
  });

  it('GET /api/topics/:privateId/posts returns 200 for authenticated member', async () => {
    const res = await authGet(`/api/topics/${privateTopicId}/posts`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
  });

  // GET /api/posts/:publicPostId
  it('GET /api/posts/:publicPostId returns 200 for guests', async () => {
    const res = await publicGet(`/api/posts/${publicPostId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const post = json.post || json;
    expect(post.id).toBe(publicPostId);
  });

  it('GET /api/posts/:publicPostId returns 200 for authenticated users', async () => {
    const res = await authGet(`/api/posts/${publicPostId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const post = json.post || json;
    expect(post.id).toBe(publicPostId);
  });

  // GET /api/posts/:publicPostId/records
  it('GET /api/posts/:publicPostId/records returns 200 for guests', async () => {
    const res = await publicGet(`/api/posts/${publicPostId}/records`);
    expect(res.status).toBe(200);
  });

  it('GET /api/posts/:publicPostId/records returns 200 for authenticated users', async () => {
    const res = await authGet(`/api/posts/${publicPostId}/records`);
    expect(res.status).toBe(200);
  });

  // GET /api/tags
  it('GET /api/tags returns 200 for guests', async () => {
    const res = await publicGet('/api/tags');
    expect(res.status).toBe(200);
  });

  it('GET /api/tags returns 200 for authenticated users', async () => {
    const res = await authGet('/api/tags');
    expect(res.status).toBe(200);
  });

  // GET /api/categories
  it('GET /api/categories returns 200 for guests', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.categories)).toBe(true);
  });

  it('GET /api/categories returns 200 for authenticated users', async () => {
    const res = await authGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.categories)).toBe(true);
  });

  // ── Section 2: Auth-required endpoints (must return 401 without auth) ─

  // Topic write operations
  it('POST /api/topics without auth returns 401', async () => {
    const res = await publicPost('/api/topics', {
      title: 'Should fail',
      visibility: 'public',
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/topics/:id/posts without auth returns 401', async () => {
    const res = await publicPost(`/api/topics/${publicTopicId}/posts`, {
      title: 'Should fail',
      content: 'nope',
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/topics/:id/join without auth returns 401', async () => {
    const res = await publicPost(`/api/topics/${publicTopicId}/join`);
    expect(res.status).toBe(401);
  });

  it('GET /api/topics/:id/members without auth returns 401', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/members`);
    expect(res.status).toBe(401);
  });

  // Post operations
  it('DELETE /api/posts/:id without auth returns 401', async () => {
    const res = await publicDelete(`/api/posts/${publicPostId}`);
    expect(res.status).toBe(401);
  });

  it('POST /api/posts/:id/vote without auth returns 401', async () => {
    const res = await publicPost(`/api/posts/${publicPostId}/vote`, {
      value: 1,
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/posts/:id/comments without auth returns 401', async () => {
    const res = await publicPost(`/api/posts/${publicPostId}/comments`, {
      content: 'Should fail',
    });
    expect(res.status).toBe(401);
  });

  // Bookmark operations
  it('GET /api/posts/:id/bookmark without auth returns 401', async () => {
    const res = await publicGet(`/api/posts/${publicPostId}/bookmark`);
    expect(res.status).toBe(401);
  });

  it('POST /api/posts/:id/bookmark without auth returns 401', async () => {
    const res = await publicPost(`/api/posts/${publicPostId}/bookmark`);
    expect(res.status).toBe(401);
  });

  // Reaction operations
  it('POST /api/posts/:id/reactions without auth returns 401', async () => {
    const res = await publicPost(`/api/posts/${publicPostId}/reactions`, {
      emoji: '👍',
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/posts/:id/reactions without auth returns 401', async () => {
    const res = await publicGet(`/api/posts/${publicPostId}/reactions`);
    expect(res.status).toBe(401);
  });

  // Bookmarks list
  it('GET /api/bookmarks without auth returns 401', async () => {
    const res = await publicGet('/api/bookmarks');
    expect(res.status).toBe(401);
  });

  // My endpoints
  it('GET /api/my/posts without auth returns 401', async () => {
    const res = await publicGet('/api/my/posts');
    expect(res.status).toBe(401);
  });

  it('GET /api/my/likes without auth returns 401', async () => {
    const res = await publicGet('/api/my/likes');
    expect(res.status).toBe(401);
  });

  // Recorded
  it('GET /api/recorded without auth returns 401', async () => {
    const res = await publicGet('/api/recorded');
    expect(res.status).toBe(401);
  });

  // Profile
  it('PUT /api/profile/nickname without auth returns 401', async () => {
    const res = await publicPut('/api/profile/nickname', {
      nickname: 'should-fail',
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/profile/image without auth returns 401', async () => {
    const res = await publicGet('/api/profile/image');
    expect(res.status).toBe(401);
  });

  // Upload
  it('POST /api/upload without auth returns 401', async () => {
    const res = await publicPost('/api/upload');
    expect(res.status).toBe(401);
  });

  // Auth session
  it('GET /api/auth/session without auth returns 401', async () => {
    const res = await publicGet('/api/auth/session');
    expect(res.status).toBe(401);
  });
});
