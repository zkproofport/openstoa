import { describe, it, expect } from 'vitest';
import { publicGet, publicPost, authPost } from './helpers';

describe.sequential('Guest access', () => {
  let publicTopicId: string;
  let privateTopicId: string;
  let secretTopicId: string;
  let publicPostId: string;

  // Setup: create topics with different visibility (requires auth)
  it('setup: create public topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Guest Public ${Date.now()}`,
      description: 'Public topic for guest access tests',
      visibility: 'public',
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

  // Guest topic list tests
  it('GET /api/topics?view=all without auth returns public and private topics', async () => {
    const res = await publicGet('/api/topics?view=all');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.topics)).toBe(true);

    const topicIds = json.topics.map((t: any) => t.id);
    // Public topic should be in list
    expect(topicIds).toContain(publicTopicId);
    // Private topic should be in list
    expect(topicIds).toContain(privateTopicId);
    // Secret topic should NOT be in list
    expect(topicIds).not.toContain(secretTopicId);
  });

  it('GET /api/topics without view=all and without auth returns empty', async () => {
    const res = await publicGet('/api/topics');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.topics).toEqual([]);
  });

  // Guest topic detail tests
  it('GET /api/topics/:id without auth returns public topic detail', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topic = json.topic || json;
    expect(topic.id).toBe(publicTopicId);
  });

  it('GET /api/topics/:id without auth returns private topic detail', async () => {
    const res = await publicGet(`/api/topics/${privateTopicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topic = json.topic || json;
    expect(topic.id).toBe(privateTopicId);
  });

  it('GET /api/topics/:id without auth returns 404 for secret topic', async () => {
    const res = await publicGet(`/api/topics/${secretTopicId}`);
    expect(res.status).toBe(404);
  });

  // Guest posts access tests
  it('GET /api/topics/:id/posts without auth returns posts for public topic', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}/posts`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
    expect(json.posts.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/topics/:id/posts without auth rejects private topic', async () => {
    const res = await publicGet(`/api/topics/${privateTopicId}/posts`);
    expect([401, 403]).toContain(res.status);
  });

  // Guest post detail tests
  it('GET /api/posts/:id without auth returns post from public topic', async () => {
    const res = await publicGet(`/api/posts/${publicPostId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const post = json.post || json;
    expect(post.id).toBe(publicPostId);
  });

  // Guest write operations should fail
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

  // Tags endpoint (public)
  it('GET /api/tags without auth returns tags', async () => {
    const res = await publicGet('/api/tags');
    expect(res.status).toBe(200);
  });
});
