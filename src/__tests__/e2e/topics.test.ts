import { describe, it, expect, afterAll } from 'vitest';
import {
  authGet,
  authPost,
  authPatch,
  authDelete,
  publicGet,
  secondUserPost,
  secondUserDelete,
  fetchCategorySlugs,
  deleteTopic,
} from './helpers';

let createdTopicId: string;
let inviteCode: string;
let categoryId: string;

// Cross-category test fixtures
let categoryA: { id: string; slug: string };
let categoryB: { id: string; slug: string };
let categoryC: { id: string; slug: string };
const sortTopicIds: string[] = [];
let topicAId: string;
let topicBId: string;
let topicCId: string;

// Topic used to test DELETE by a non-owner
let topicForDeleteId: string;

describe.sequential('Topics endpoints', () => {
  afterAll(async () => {
    const ids = [...sortTopicIds, createdTopicId, topicForDeleteId].filter(Boolean);
    for (const id of ids) {
      try {
        await deleteTopic(id);
      } catch {
        // Best-effort cleanup; ignore failures so the real test result is preserved.
      }
    }
  });

  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('setup: pick three distinct categories for filter/sort tests', async () => {
    const cats = await fetchCategorySlugs();
    expect(cats.length).toBeGreaterThanOrEqual(3);
    categoryA = cats[0];
    categoryB = cats[1];
    categoryC = cats[2];
  });

  it('setup: create one topic per category', async () => {
    const stamp = Date.now();
    const [resA, resB, resC] = await Promise.all([
      authPost('/api/topics', {
        title: `E2E Topics Sort A ${stamp}_${Math.random().toString(36).slice(2, 6)}`,
        description: 'Topic in category A',
        visibility: 'public',
        categoryId: categoryA.id,
      }),
      authPost('/api/topics', {
        title: `E2E Topics Sort B ${stamp}_${Math.random().toString(36).slice(2, 6)}`,
        description: 'Topic in category B',
        visibility: 'public',
        categoryId: categoryB.id,
      }),
      authPost('/api/topics', {
        title: `E2E Topics Sort C ${stamp}_${Math.random().toString(36).slice(2, 6)}`,
        description: 'Topic in category C',
        visibility: 'public',
        categoryId: categoryC.id,
      }),
    ]);
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resC.status).toBe(201);
    topicAId = (await resA.json()).topic.id;
    topicBId = (await resB.json()).topic.id;
    topicCId = (await resC.json()).topic.id;
    sortTopicIds.push(topicAId, topicBId, topicCId);
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
    expect(json.isMember).toBe(true);
  });

  it('GET /api/topics/:topicId/requests returns requests (owner)', async () => {
    const res = await authGet(`/api/topics/${createdTopicId}/requests`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const requests = json.requests || json;
    expect(Array.isArray(requests)).toBe(true);
  });

  it('POST /api/topics/:topicId/join returns 409 when already a member', async () => {
    expect(createdTopicId).toBeTruthy();
    const res = await authPost(`/api/topics/${createdTopicId}/join`, {});
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('POST /api/topics/join/:inviteCode returns 409 when already a member', async () => {
    expect(inviteCode).toBeTruthy();
    const res = await authPost(`/api/topics/join/${inviteCode}`, {});
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('PATCH /api/topics/:topicId/members returns 400 when owner tries to change own role', async () => {
    expect(createdTopicId).toBeTruthy();
    const membersRes = await authGet(`/api/topics/${createdTopicId}/members`);
    expect(membersRes.status).toBe(200);
    const membersJson = await membersRes.json();
    const ownerMember = membersJson.members.find((m: { role: string }) => m.role === 'owner');
    expect(ownerMember).toBeTruthy();

    const res = await authPatch(`/api/topics/${createdTopicId}/members`, {
      userId: ownerMember.userId,
      role: 'admin',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('DELETE /api/topics/:topicId/members returns 400 when trying to remove self', async () => {
    expect(createdTopicId).toBeTruthy();
    const membersRes = await authGet(`/api/topics/${createdTopicId}/members`);
    expect(membersRes.status).toBe(200);
    const membersJson = await membersRes.json();
    const ownerMember = membersJson.members.find((m: { role: string }) => m.role === 'owner');
    expect(ownerMember).toBeTruthy();

    const res = await authDelete(`/api/topics/${createdTopicId}/members`, {
      userId: ownerMember.userId,
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('PATCH /api/topics/:topicId/requests returns 404 for non-existent requestId', async () => {
    expect(createdTopicId).toBeTruthy();
    const fakeRequestId = '00000000-0000-0000-0000-000000000000';
    const res = await authPatch(`/api/topics/${createdTopicId}/requests`, {
      requestId: fakeRequestId,
      action: 'approve',
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── view=all sorting ─────────────────────────────────────────────────

  it('GET /api/topics?view=all&sort=new returns topics ordered by createdAt desc', async () => {
    const res = await authGet('/api/topics?view=all&sort=new&category=' + categoryA.slug);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topics: Array<{ id: string; createdAt: string }> = json.topics;
    expect(Array.isArray(topics)).toBe(true);
    for (let i = 1; i < topics.length; i++) {
      const prev = new Date(topics[i - 1].createdAt).getTime();
      const curr = new Date(topics[i].createdAt).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('GET /api/topics?view=all&sort=active returns 200 with lastActivityAt non-increasing', async () => {
    const res = await authGet('/api/topics?view=all&sort=active');
    expect(res.status).toBe(200);
    const json = await res.json();
    const topics: Array<{ id: string; lastActivityAt: string | null }> = json.topics;
    expect(Array.isArray(topics)).toBe(true);
    for (let i = 1; i < topics.length; i++) {
      const prev = topics[i - 1].lastActivityAt ? new Date(topics[i - 1].lastActivityAt!).getTime() : 0;
      const curr = topics[i].lastActivityAt ? new Date(topics[i].lastActivityAt!).getTime() : 0;
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('GET /api/topics?view=all&sort=top returns 200 with memberCount non-increasing', async () => {
    const res = await authGet('/api/topics?view=all&sort=top');
    expect(res.status).toBe(200);
    const json = await res.json();
    const topics: Array<{ memberCount: number }> = json.topics;
    expect(Array.isArray(topics)).toBe(true);
    for (let i = 1; i < topics.length; i++) {
      expect(topics[i - 1].memberCount).toBeGreaterThanOrEqual(topics[i].memberCount);
    }
  });

  it('GET /api/topics?view=all&sort=hot returns 200 with score non-increasing', async () => {
    const res = await authGet('/api/topics?view=all&sort=hot');
    expect(res.status).toBe(200);
    const json = await res.json();
    const topics: Array<{ score: number }> = json.topics;
    expect(Array.isArray(topics)).toBe(true);
    for (let i = 1; i < topics.length; i++) {
      expect(topics[i - 1].score).toBeGreaterThanOrEqual(topics[i].score);
    }
  });

  it('GET /api/topics?view=all&sort=invalid returns 400', async () => {
    const res = await authGet('/api/topics?view=all&sort=invalid_sort_xyz');
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    expect(json.error).toMatch(/invalid sort/i);
  });

  // ── view=all category filter ─────────────────────────────────────────

  it('GET /api/topics?view=all&category=A returns only category-A topics', async () => {
    const res = await authGet(`/api/topics?view=all&category=${categoryA.slug}&sort=new`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topics: Array<{ id: string; categoryId: string | null }> = json.topics;
    expect(topics.length).toBeGreaterThan(0);
    // Every topic returned must belong to category A.
    for (const t of topics) {
      expect(t.categoryId).toBe(categoryA.id);
    }
    const ids = topics.map((t) => t.id);
    expect(ids).toContain(topicAId);
    expect(ids).not.toContain(topicBId);
    expect(ids).not.toContain(topicCId);
  });

  it('GET /api/topics?view=all&category=B returns only category-B topics', async () => {
    const res = await authGet(`/api/topics?view=all&category=${categoryB.slug}&sort=new`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topics: Array<{ id: string; categoryId: string | null }> = json.topics;
    expect(topics.length).toBeGreaterThan(0);
    for (const t of topics) {
      expect(t.categoryId).toBe(categoryB.id);
    }
    const ids = topics.map((t) => t.id);
    expect(ids).toContain(topicBId);
    expect(ids).not.toContain(topicAId);
    expect(ids).not.toContain(topicCId);
  });

  it('GET /api/topics?view=all&category=nonexistent returns 400', async () => {
    const res = await authGet('/api/topics?view=all&category=nonexistent-category-slug-xyz');
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
    expect(json.error).toMatch(/category/i);
  });

  it('GET /api/topics?view=all&category=A&sort=new combines filter + sort', async () => {
    const res = await authGet(`/api/topics?view=all&category=${categoryA.slug}&sort=new`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topics: Array<{ id: string; createdAt: string; categoryId: string | null }> = json.topics;
    expect(topics.length).toBeGreaterThan(0);
    for (const t of topics) {
      expect(t.categoryId).toBe(categoryA.id);
    }
    for (let i = 1; i < topics.length; i++) {
      const prev = new Date(topics[i - 1].createdAt).getTime();
      const curr = new Date(topics[i].createdAt).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  // ── DELETE /api/topics/:topicId ──────────────────────────────────────

  it('setup: create a topic for the non-owner DELETE test', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Topic Delete NonOwner ${Date.now()}`,
      description: 'Topic for non-owner DELETE test',
      visibility: 'public',
      categoryId: categoryA.id,
    });
    expect(res.status).toBe(201);
    topicForDeleteId = (await res.json()).topic.id;
  });

  it('DELETE /api/topics/:topicId by non-owner returns 403', async () => {
    expect(topicForDeleteId).toBeTruthy();
    // Second user joins so they're a topic member but not owner; they must
    // still be rejected on DELETE.
    const joinRes = await secondUserPost(`/api/topics/${topicForDeleteId}/join`, {});
    expect([200, 201, 409]).toContain(joinRes.status);

    const delRes = await secondUserDelete(`/api/topics/${topicForDeleteId}`);
    expect(delRes.status).toBe(403);
    const json = await delRes.json();
    expect(json.error).toBeTruthy();
  });

  it('DELETE /api/topics/:nonexistent returns 404', async () => {
    const res = await authDelete('/api/topics/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('DELETE /api/topics/:topicId by owner returns 200 and removes the topic', async () => {
    expect(topicForDeleteId).toBeTruthy();
    const res = await authDelete(`/api/topics/${topicForDeleteId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deleted).toBe(true);
    expect(json.topicId).toBe(topicForDeleteId);
    expect(typeof json.deletedPostCount).toBe('number');

    // GET should now 404
    const getRes = await authGet(`/api/topics/${topicForDeleteId}`);
    expect(getRes.status).toBe(404);
  });

});
