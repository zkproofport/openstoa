import { describe, it, expect } from 'vitest';
import { authGet, authPost } from './helpers';

describe.sequential('Record endpoints', () => {
  let topicId: string;
  let ownPostId: string;

  it('setup: create topic and post for record tests', async () => {
    // Create topic
    const topicRes = await authPost('/api/topics', {
      title: `E2E Record Topic ${Date.now()}`,
      description: 'Topic for record E2E tests',
      visibility: 'public',
    });
    expect(topicRes.status).toBe(201);
    const topicJson = await topicRes.json();
    topicId = topicJson.topic.id;

    // Create post (own post — will be used to test policy rejection)
    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `E2E Record Post ${Date.now()}`,
      content: 'Test post for recording policy checks',
    });
    expect(postRes.status).toBe(201);
    const postJson = await postRes.json();
    ownPostId = postJson.post.id;
  });

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
});
