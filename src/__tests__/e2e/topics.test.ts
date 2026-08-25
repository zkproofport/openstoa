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
let searchStamp: string;
const TOPIC_UTF8 = '안녕토픽검색';

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
    searchStamp = `topicq${stamp}`;
    const [resA, resB, resC] = await Promise.all([
      authPost('/api/topics', {
        title: `E2E Topics Sort A ${searchStamp}_${Math.random().toString(36).slice(2, 6)}`,
        description: `Topic in category A ${searchStamp}`,
        visibility: 'public',
        categoryId: categoryA.id,
      }),
      authPost('/api/topics', {
        title: `E2E Topics Sort B ${searchStamp}_${Math.random().toString(36).slice(2, 6)}`,
        description: `Topic in category B ${searchStamp} ${TOPIC_UTF8}`,
        visibility: 'public',
        categoryId: categoryB.id,
      }),
      authPost('/api/topics', {
        title: `E2E Topics Sort C ${searchStamp}_${Math.random().toString(36).slice(2, 6)}`,
        description: `Topic in category C ${searchStamp}`,
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

  // ── Search (q=) ──────────────────────────────────────────────────────

  it('GET /api/topics?view=all&q matches title via unique stamp (auth path)', async () => {
    const res = await authGet(`/api/topics?view=all&q=${searchStamp}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids: string[] = json.topics.map((t: { id: string }) => t.id);
    expect(ids).toContain(topicAId);
    expect(ids).toContain(topicBId);
    expect(ids).toContain(topicCId);
  });

  it('GET /api/topics?view=all&q matches description (B-only substring)', async () => {
    const res = await authGet(
      `/api/topics?view=all&q=${encodeURIComponent('Topic in category B ' + searchStamp)}`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids: string[] = json.topics.map((t: { id: string }) => t.id);
    expect(ids).toContain(topicBId);
    expect(ids).not.toContain(topicAId);
    expect(ids).not.toContain(topicCId);
  });

  it('GET /api/topics?view=all&q matches UTF-8 (Korean) description', async () => {
    const res = await authGet(
      `/api/topics?view=all&q=${encodeURIComponent(TOPIC_UTF8)}`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids: string[] = json.topics.map((t: { id: string }) => t.id);
    expect(ids).toContain(topicBId);
    expect(ids).not.toContain(topicAId);
    expect(ids).not.toContain(topicCId);
  });

  it('GET /api/topics?view=all&q is case-insensitive', async () => {
    const res = await authGet(
      `/api/topics?view=all&q=${encodeURIComponent(searchStamp.toUpperCase())}`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids: string[] = json.topics.map((t: { id: string }) => t.id);
    for (const id of [topicAId, topicBId, topicCId]) expect(ids).toContain(id);
  });

  it('GET /api/topics?view=all&q trims surrounding whitespace', async () => {
    const res = await authGet(
      `/api/topics?view=all&q=${encodeURIComponent('   ' + searchStamp + '   ')}`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids: string[] = json.topics.map((t: { id: string }) => t.id);
    for (const id of [topicAId, topicBId, topicCId]) expect(ids).toContain(id);
  });

  it('GET /api/topics?view=all&q (whitespace-only) acts as no filter', async () => {
    /*
     * Asserted on CONTENT, not on a count.
     *
     * This compared `a.topics.length` to `b.topics.length` across two separate
     * requests against a live table, and went red at 2056 vs 2057 the moment any
     * other suite created a topic between them — which several do. It was also a
     * weak assertion even when it passed: two different sets of rows can be the
     * same size, so an equal count never proved the filter was absent.
     *
     * What the case is really about is that a blank `q` must not narrow the
     * result. So: the whitespace query returns this fixture's topics (a real
     * filter on `"  "` would match none of them), and it returns FAR more than
     * the three a genuine `q` selects — both immune to a concurrent insert.
     */
    const [withQ, withStampQ] = await Promise.all([
      authGet('/api/topics?view=all&q=%20%20&sort=new'),
      authGet(`/api/topics?view=all&q=${encodeURIComponent(searchStamp)}&sort=new`),
    ]);
    expect(withQ.status).toBe(200);
    expect(withStampQ.status).toBe(200);
    const blank = await withQ.json();
    const filtered = await withStampQ.json();

    const blankIds: string[] = blank.topics.map((t: { id: string }) => t.id);
    for (const id of [topicAId, topicBId, topicCId]) expect(blankIds).toContain(id);
    // A real filter selects a handful; no filter at all selects the corpus.
    expect(filtered.topics.length).toBeLessThan(blank.topics.length);
  });

  it('GET /api/topics?view=all&q combines with sort=new', async () => {
    const res = await authGet(`/api/topics?view=all&q=${searchStamp}&sort=new`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topics: Array<{ id: string; createdAt: string }> = json.topics;
    const ids = topics.map((t) => t.id);
    for (const id of [topicAId, topicBId, topicCId]) expect(ids).toContain(id);
    for (let i = 1; i < topics.length; i++) {
      const prev = new Date(topics[i - 1].createdAt).getTime();
      const curr = new Date(topics[i].createdAt).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('GET /api/topics?view=all&q combines with category filter', async () => {
    const res = await authGet(
      `/api/topics?view=all&q=${searchStamp}&category=${categoryA.slug}`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids: string[] = json.topics.map((t: { id: string }) => t.id);
    expect(ids).toContain(topicAId);
    expect(ids).not.toContain(topicBId);
    expect(ids).not.toContain(topicCId);
  });

  it('GET /api/topics?view=all&q works for guests (no auth)', async () => {
    const res = await publicGet(`/api/topics?view=all&q=${searchStamp}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids: string[] = json.topics.map((t: { id: string }) => t.id);
    for (const id of [topicAId, topicBId, topicCId]) expect(ids).toContain(id);
  });

  it('GET /api/topics?view=all&q with no matches returns empty list', async () => {
    const res = await authGet('/api/topics?view=all&q=zzz_no_topic_match_xyz_unique_token');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.topics).toEqual([]);
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

  /**
   * REGRESSION: a topic that has been CHATTED IN can be deleted.
   *
   * The case above deletes a topic nobody ever spoke in, and that is why the
   * defect it misses survived. Five tables arrived with E2EE — `mls_groups`,
   * `mls_commits`, `tak_bundles`, `chat_archive`, `archive_holders` — all
   * referencing `topics` with `ON DELETE NO ACTION`, and the delete handler
   * touched none of them. So the final `delete(topics)` hit a foreign-key
   * violation, the transaction rolled back, and the owner of any room with a
   * single message in it got a 500 and could never remove it.
   *
   * Found on staging, where a room holding 13 commits and 13 bundles refused
   * to go. What makes it reproducible here is CHATTING FIRST: posting one
   * message is what creates the MLS group and the rows that blocked the
   * delete.
   */
  it('REGRESSION: DELETE succeeds on a topic that has been chatted in', async () => {
    const created = await authPost('/api/topics', {
      title: `E2E Topic Delete AfterChat ${Date.now()}`,
      description: 'Deleting a room someone actually spoke in',
      visibility: 'public',
      categoryId: categoryA.id,
    });
    expect(created.status).toBe(201);
    const chattedTopicId = (await created.json()).topic.id;

    /*
     * A real sealed message. The server is blind (SI-1) and stores the bytes
     * without opening them, which is all this case needs — what matters is
     * that the row exists and that posting it creates the MLS group behind it.
     */
    const posted = await authPost(`/api/topics/${chattedTopicId}/chat`, {
      ciphertext: Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64'),
      epoch: 1,
    });
    expect(posted.status).toBe(201);

    // The message really is there — otherwise this case would pass for the
    // wrong reason on a build where posting silently failed.
    const listed = await authGet(`/api/topics/${chattedTopicId}/chat?limit=5`);
    expect(listed.status).toBe(200);
    expect((await listed.json()).messages.length).toBeGreaterThan(0);

    const del = await authDelete(`/api/topics/${chattedTopicId}`);
    expect(del.status).toBe(200);
    expect((await del.json()).deleted).toBe(true);

    const gone = await authGet(`/api/topics/${chattedTopicId}`);
    expect(gone.status).toBe(404);
  });

});
