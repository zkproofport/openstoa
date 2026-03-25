import { describe, it, expect } from 'vitest';
import {
  authPost,
  authGet,
  authPatch,
  publicGet,
  publicPost,
  publicPatch,
  secondUserPost,
  secondUserPatch,
  getSecondUserToken,
} from './helpers';

let categoryId: string;
let publicTopicId: string;
let originalTitle: string;
let originalDescription: string;

describe.sequential('Topic CRUD + Permission + Blind', () => {
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
    originalTitle = `E2E Topic CRUD ${Date.now()}`;
    originalDescription = 'Public topic for topic CRUD + blind tests';
    const res = await authPost('/api/topics', {
      title: originalTitle,
      description: originalDescription,
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

  // ── Topic Create Validation ─────────────────────────────────────────

  it('1. Create topic missing required field (no title) -> 400', async () => {
    const res = await authPost('/api/topics', {
      categoryId,
      visibility: 'public',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('2. Create topic missing required field (no categoryId) -> 400', async () => {
    const res = await authPost('/api/topics', {
      title: 'Missing categoryId topic',
      visibility: 'public',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('3. Create topic with invalid categoryId -> 400', async () => {
    const res = await authPost('/api/topics', {
      title: 'Invalid category topic',
      categoryId: '00000000-0000-0000-0000-000000000000',
      visibility: 'public',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Topic Edit ──────────────────────────────────────────────────────

  it('4. Owner edits topic title and description -> 200', async () => {
    const updatedTitle = `E2E Topic Updated ${Date.now()}`;
    const updatedDescription = 'Updated description by owner';
    const res = await authPatch(`/api/topics/${publicTopicId}`, {
      title: updatedTitle,
      description: updatedDescription,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.topic).toBeDefined();
    expect(json.topic.title).toBe(updatedTitle);
    expect(json.topic.description).toBe(updatedDescription);

    // Verify changes persisted via GET
    const getRes = await authGet(`/api/topics/${publicTopicId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    const topic = getJson.topic || getJson;
    expect(topic.title).toBe(updatedTitle);
    expect(topic.description).toBe(updatedDescription);
  });

  it('5. Non-owner edits topic -> 403', async () => {
    const res = await secondUserPatch(`/api/topics/${publicTopicId}`, {
      title: 'Attempted hijack by non-owner',
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('6. Guest (unauthenticated) edits topic -> 401', async () => {
    const res = await publicPatch(`/api/topics/${publicTopicId}`, {
      title: 'Attempted hijack by guest',
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('7. Edit topic with empty body -> 400', async () => {
    const res = await authPatch(`/api/topics/${publicTopicId}`, {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Topic Detail ────────────────────────────────────────────────────

  it('8. Topic detail returns memberCount, category, and proofType', async () => {
    const res = await authGet(`/api/topics/${publicTopicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topic = json.topic || json;

    expect(topic.id).toBe(publicTopicId);
    expect(typeof topic.memberCount).toBe('number');
    expect(topic.memberCount).toBeGreaterThanOrEqual(1); // at least the owner
    expect(topic.category).toBeDefined();
    // proofType can be null for open topics, but the field should exist
    expect('proofType' in topic).toBe(true);
  });

  it('9. Non-member can view public topic detail', async () => {
    const res = await publicGet(`/api/topics/${publicTopicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topic = json.topic || json;
    expect(topic.id).toBe(publicTopicId);
    expect(topic.title).toBeTruthy();
    expect(topic.category).toBeDefined();
  });

  // ── Topic Blind ─────────────────────────────────────────────────────

  it('10. Owner blinds topic -> 200, blinded: true', async () => {
    const res = await authPost(`/api/topics/${publicTopicId}/blind`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.blinded).toBe(true);
    expect(json.blindedBy).toBeTruthy();
  });

  it('11. Owner unblinds topic (toggle) -> 200, blinded: false', async () => {
    const res = await authPost(`/api/topics/${publicTopicId}/blind`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.blinded).toBe(false);
    expect(json.blindedBy).toBeNull();
  });

  it('12. Non-owner blinds topic -> 403', async () => {
    const res = await secondUserPost(`/api/topics/${publicTopicId}/blind`);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('13. Guest (unauthenticated) blinds topic -> 401', async () => {
    const res = await publicPost(`/api/topics/${publicTopicId}/blind`);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('14. Blinded topic is excluded from topic list', async () => {
    // First, blind the topic
    const blindRes = await authPost(`/api/topics/${publicTopicId}/blind`);
    expect(blindRes.status).toBe(200);
    const blindJson = await blindRes.json();
    expect(blindJson.blinded).toBe(true);

    // Fetch all topics and verify the blinded topic is excluded
    const listRes = await publicGet('/api/topics?view=all');
    expect(listRes.status).toBe(200);
    const listJson = await listRes.json();
    const topics = listJson.topics || listJson;
    expect(Array.isArray(topics)).toBe(true);

    const found = topics.find((t: { id: string }) => t.id === publicTopicId);
    expect(found).toBeUndefined();

    // Clean up: unblind for any subsequent tests
    const unblindRes = await authPost(`/api/topics/${publicTopicId}/blind`);
    expect(unblindRes.status).toBe(200);
    const unblindJson = await unblindRes.json();
    expect(unblindJson.blinded).toBe(false);
  });
});
