import { describe, it, expect } from 'vitest';
import { authGet, authPost, publicGet } from './helpers';

let createdTopicId: string;
let inviteCode: string;
let categoryId: string;

describe.sequential('Topics endpoints', () => {
  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('GET /api/topics returns topic list', async () => {
    const res = await authGet('/api/topics');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.topics).toBeDefined();
    expect(Array.isArray(json.topics)).toBe(true);
  });

  it('GET /api/topics?view=all returns all visible topics', async () => {
    const res = await authGet('/api/topics?view=all');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.topics).toBeDefined();
    expect(Array.isArray(json.topics)).toBe(true);
  });

  it('POST /api/topics creates a new topic', async () => {
    expect(categoryId).toBeTruthy();
    const uniqueTitle = `E2E Test Topic ${Date.now()}`;
    const res = await authPost('/api/topics', {
      title: uniqueTitle,
      description: 'Created by E2E test',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.topic.id).toBeTruthy();
    expect(json.topic.title).toBe(uniqueTitle);
    expect(json.topic.inviteCode).toBeTruthy();
    expect(json.topic.categoryId).toBe(categoryId);
    expect(json.topic.category).toBeDefined();
    expect(json.topic.category.id).toBe(categoryId);
    createdTopicId = json.topic.id;
    inviteCode = json.topic.inviteCode;
  });

  it('GET /api/topics/:topicId returns topic detail', async () => {
    expect(createdTopicId).toBeTruthy();
    const res = await authGet(`/api/topics/${createdTopicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topic = json.topic || json;
    expect(topic.id).toBe(createdTopicId);
    expect(topic.title).toBeTruthy();
  });

  it('GET /api/topics/:topicId/members returns member list', async () => {
    const res = await authGet(`/api/topics/${createdTopicId}/members`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const members = json.members || json;
    expect(Array.isArray(members)).toBe(true);
    // Creator should be in members as owner
    expect(members.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/topics/:topicId/posts returns empty post list for new topic', async () => {
    const res = await authGet(`/api/topics/${createdTopicId}/posts`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const posts = json.posts || json;
    expect(Array.isArray(posts)).toBe(true);
  });

  it('GET /api/topics/join/:inviteCode returns topic preview', async () => {
    expect(inviteCode).toBeTruthy();
    const res = await authGet(`/api/topics/join/${inviteCode}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topic = json.topic || json;
    expect(topic.id).toBe(createdTopicId);
    expect(json.isMember).toBe(true); // We're the creator
  });

  it('GET /api/topics/:topicId/requests returns requests (owner)', async () => {
    const res = await authGet(`/api/topics/${createdTopicId}/requests`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const requests = json.requests || json;
    expect(Array.isArray(requests)).toBe(true);
  });
});
