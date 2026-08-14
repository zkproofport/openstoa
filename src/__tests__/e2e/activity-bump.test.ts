import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import {
  authGet,
  authPost,
  authDelete,
  secondUserPost,
  fetchCategorySlugs,
  deleteTopic,
} from './helpers';
import { envGate, announceEnvGates, getPostRow, getTopicRow, closeDb } from './db-helpers';

/**
 * End-to-end verification of the activity bump contract introduced in
 * 묶음1-C/A/B:
 *
 * 1. `posts.lastActivityAt` must bump on comment / vote / reaction add /
 *    reaction remove. This is the signal that `sort=active` rides on.
 * 2. `topics.lastActivityAt` must bump on the same activity events so
 *    topic-level `sort=active` also reflects new chatter, not just topic
 *    creation time.
 * 3. `posts.score` must be recomputed after a vote, so `sort=hot` is no
 *    longer a no-op.
 * 4. `topics.score` must be recomputed after activity (post create / vote /
 *    comment / reaction) so the topic list's default `sort=hot` reflects
 *    real momentum.
 *
 * The score/topic-side updates are fire-and-forget from the request
 * handlers, so the assertions poll for up to ~5 seconds.
 */

const POLL_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 250;

async function getTopic(topicId: string): Promise<{
  id: string;
  lastActivityAt: string | null;
  score: number;
}> {
  const res = await authGet(`/api/topics/${topicId}`);
  if (!res.ok) throw new Error(`GET /api/topics/${topicId} -> ${res.status}`);
  const json = await res.json();
  return json.topic ?? json;
}

async function getPost(postId: string): Promise<{
  id: string;
  lastActivityAt: string | null;
  upvoteCount: number;
  score: number;
}> {
  const res = await authGet(`/api/posts/${postId}`);
  if (!res.ok) throw new Error(`GET /api/posts/${postId} -> ${res.status}`);
  const json = await res.json();
  return json.post ?? json;
}

async function waitFor<T>(probe: () => Promise<T>, ok: (value: T) => boolean, label: string): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    last = await probe();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`waitFor(${label}) timed out; last=${JSON.stringify(last)}`);
}

let categorySlug: { id: string; slug: string };
let topicId: string;
let postId: string;
const createdTopicIds: string[] = [];

describe.sequential('Activity bump — posts/topics lastActivityAt + score', () => {
  beforeAll(async () => {
    // Console output at module-collection time (bare top-level code) is not
    // reliably surfaced by vitest's reporter — a beforeAll hook runs during
    // the execution phase, where it is. Counting still happened correctly at
    // collection time (it.skipIf(envGate(...)) below); this only decides
    // where the resulting warning gets PRINTED.
    announceEnvGates('activity-bump.test.ts');

    const cats = await fetchCategorySlugs();
    expect(cats.length).toBeGreaterThan(0);
    categorySlug = cats[0];

    const stamp = Date.now();
    const topicRes = await authPost('/api/topics', {
      title: `E2E Activity Bump ${stamp}_${Math.random().toString(36).slice(2, 6)}`,
      description: 'Topic that exercises lastActivityAt / score bumps',
      visibility: 'public',
      categoryId: categorySlug.id,
    });
    expect(topicRes.status).toBe(201);
    topicId = (await topicRes.json()).topic.id;
    createdTopicIds.push(topicId);

    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `E2E Activity Bump Post ${stamp}`,
      content: 'Activity bump probe',
    });
    expect(postRes.status).toBe(201);
    postId = (await postRes.json()).post.id;
  });

  afterAll(async () => {
    for (const id of createdTopicIds) {
      try {
        await deleteTopic(id);
      } catch {
        // best-effort cleanup
      }
    }
    await closeDb();
  });

  // ── Direct-DB verification ─────────────────────────────────────────
  //
  // The API-response checks above prove the route returns the bumped
  // value, but a misbehaving handler could in theory return a fresh
  // value while writing nothing to disk. These two cases close that
  // gap by reading the row straight from PostgreSQL.
  //
  // They auto-skip when `E2E_STAGING_DB_URL` is not set so the default
  // CI run still works without a Cloud SQL Proxy.

  it.skipIf(envGate('E2E_STAGING_DB_URL'))('vote actually writes the new upvote_count + score to the posts row (DB SELECT)', async () => {
    const beforeRow = await getPostRow(postId);
    expect(beforeRow).not.toBeNull();
    const beforeUp = beforeRow!.upvote_count;
    const beforeScore = Number(beforeRow!.score);

    await new Promise((r) => setTimeout(r, 50));

    // Vote +1 from User A (post author — voting on own post is allowed by route).
    const res = await authPost(`/api/posts/${postId}/vote`, { value: 1 });
    expect(res.status).toBe(200);

    // Wait for fire-and-forget updatePostScore to land.
    let afterRow = await getPostRow(postId);
    for (let i = 0; i < 20 && afterRow && Number(afterRow.score) === beforeScore; i++) {
      await new Promise((r) => setTimeout(r, 250));
      afterRow = await getPostRow(postId);
    }
    expect(afterRow).not.toBeNull();
    expect(afterRow!.upvote_count).toBe(beforeUp + 1);
    expect(Number(afterRow!.score)).not.toBe(beforeScore);
  });

  it.skipIf(envGate('E2E_STAGING_DB_URL'))('comment actually bumps topics.last_activity_at in the DB row', async () => {
    const beforeTopic = await getTopicRow(topicId);
    expect(beforeTopic).not.toBeNull();
    const beforeMs = new Date(beforeTopic!.last_activity_at!).getTime();

    await new Promise((r) => setTimeout(r, 100));

    const res = await authPost(`/api/posts/${postId}/comments`, {
      content: `db-row probe ${Date.now()}`,
    });
    expect(res.status).toBe(201);

    let afterTopic = await getTopicRow(topicId);
    for (let i = 0; i < 20 && afterTopic
      && new Date(afterTopic.last_activity_at!).getTime() <= beforeMs; i++) {
      await new Promise((r) => setTimeout(r, 250));
      afterTopic = await getTopicRow(topicId);
    }
    expect(afterTopic).not.toBeNull();
    expect(new Date(afterTopic!.last_activity_at!).getTime()).toBeGreaterThan(beforeMs);
  });

  it('comment bumps posts.lastActivityAt AND topics.lastActivityAt', async () => {
    const [postBefore, topicBefore] = await Promise.all([getPost(postId), getTopic(topicId)]);

    // Sleep a beat so any bump is strictly after `before` even with ms-level
    // clock skew between the API and the test runner.
    await new Promise((r) => setTimeout(r, 50));

    const res = await authPost(`/api/posts/${postId}/comments`, {
      content: `bump probe ${Date.now()}`,
    });
    expect(res.status).toBe(201);

    const postAfter = await waitFor(
      () => getPost(postId),
      (p) => new Date(p.lastActivityAt ?? 0).getTime() > new Date(postBefore.lastActivityAt ?? 0).getTime(),
      'post.lastActivityAt after comment',
    );
    expect(new Date(postAfter.lastActivityAt!).getTime())
      .toBeGreaterThan(new Date(postBefore.lastActivityAt!).getTime());

    const topicAfter = await waitFor(
      () => getTopic(topicId),
      (t) => new Date(t.lastActivityAt ?? 0).getTime() > new Date(topicBefore.lastActivityAt ?? 0).getTime(),
      'topic.lastActivityAt after comment',
    );
    expect(new Date(topicAfter.lastActivityAt!).getTime())
      .toBeGreaterThan(new Date(topicBefore.lastActivityAt!).getTime());
  });

  it('vote (+1) bumps posts.score, posts.lastActivityAt, topics.lastActivityAt, increments upvoteCount', async () => {
    const [postBefore, topicBefore] = await Promise.all([getPost(postId), getTopic(topicId)]);

    await new Promise((r) => setTimeout(r, 50));

    // Vote as the second user so this isn't a self-vote edge case.
    const res = await secondUserPost(`/api/posts/${postId}/vote`, { value: 1 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upvoteCount).toBe(postBefore.upvoteCount + 1);

    const postAfter = await waitFor(
      () => getPost(postId),
      (p) => p.score !== postBefore.score
        && new Date(p.lastActivityAt ?? 0).getTime() > new Date(postBefore.lastActivityAt ?? 0).getTime(),
      'post.score + lastActivityAt after vote',
    );
    expect(postAfter.upvoteCount).toBe(postBefore.upvoteCount + 1);
    expect(postAfter.score).not.toBe(postBefore.score);

    const topicAfter = await waitFor(
      () => getTopic(topicId),
      (t) => new Date(t.lastActivityAt ?? 0).getTime() > new Date(topicBefore.lastActivityAt ?? 0).getTime(),
      'topic.lastActivityAt after vote',
    );
    expect(new Date(topicAfter.lastActivityAt!).getTime())
      .toBeGreaterThan(new Date(topicBefore.lastActivityAt!).getTime());
  });

  it('vote toggle (same value) removes vote, decrements upvoteCount, still bumps activity', async () => {
    const before = await getPost(postId);
    await new Promise((r) => setTimeout(r, 50));

    const res = await secondUserPost(`/api/posts/${postId}/vote`, { value: 1 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.vote).toBeNull();
    expect(body.upvoteCount).toBe(before.upvoteCount - 1);

    const after = await waitFor(
      () => getPost(postId),
      (p) => new Date(p.lastActivityAt ?? 0).getTime() > new Date(before.lastActivityAt ?? 0).getTime(),
      'post.lastActivityAt after vote toggle off',
    );
    expect(after.upvoteCount).toBe(before.upvoteCount - 1);
  });

  it('reaction add bumps posts.lastActivityAt AND topics.lastActivityAt', async () => {
    const [postBefore, topicBefore] = await Promise.all([getPost(postId), getTopic(topicId)]);

    await new Promise((r) => setTimeout(r, 50));

    const res = await authPost(`/api/posts/${postId}/reactions`, { emoji: '🔥' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(true);

    const postAfter = await waitFor(
      () => getPost(postId),
      (p) => new Date(p.lastActivityAt ?? 0).getTime() > new Date(postBefore.lastActivityAt ?? 0).getTime(),
      'post.lastActivityAt after reaction add',
    );
    expect(new Date(postAfter.lastActivityAt!).getTime())
      .toBeGreaterThan(new Date(postBefore.lastActivityAt!).getTime());

    const topicAfter = await waitFor(
      () => getTopic(topicId),
      (t) => new Date(t.lastActivityAt ?? 0).getTime() > new Date(topicBefore.lastActivityAt ?? 0).getTime(),
      'topic.lastActivityAt after reaction add',
    );
    expect(new Date(topicAfter.lastActivityAt!).getTime())
      .toBeGreaterThan(new Date(topicBefore.lastActivityAt!).getTime());
  });

  it('reaction remove also bumps activity (toggle off counts as activity)', async () => {
    const before = await getPost(postId);
    await new Promise((r) => setTimeout(r, 50));

    const res = await authPost(`/api/posts/${postId}/reactions`, { emoji: '🔥' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(false);

    const after = await waitFor(
      () => getPost(postId),
      (p) => new Date(p.lastActivityAt ?? 0).getTime() > new Date(before.lastActivityAt ?? 0).getTime(),
      'post.lastActivityAt after reaction remove',
    );
    expect(new Date(after.lastActivityAt!).getTime())
      .toBeGreaterThan(new Date(before.lastActivityAt!).getTime());
  });

  it('topic.score is non-null and refreshed after activity', async () => {
    // We don't pin a specific numeric value (updateTopicScore depends on
    // members, recent posts, and time-decay), but after at least one
    // comment + vote + reaction the score must have been recomputed at
    // least once — i.e. not the default 0 unless every input genuinely
    // resolves to 0, which is impossible here (post count >= 1).
    const topic = await getTopic(topicId);
    expect(topic.score).toBeGreaterThan(0);
  });

  it('feed sort=active reorders so the bumped post climbs to the top', async () => {
    // Add a fresh post in another topic, then bump the original post — the
    // bumped post should outrank the fresh one under sort=active.
    const stamp = Date.now();
    const otherRes = await authPost('/api/topics', {
      title: `E2E Activity Other ${stamp}_${Math.random().toString(36).slice(2, 6)}`,
      description: 'Sibling topic for sort=active probe',
      visibility: 'public',
      categoryId: categorySlug.id,
    });
    expect(otherRes.status).toBe(201);
    const otherTopicId = (await otherRes.json()).topic.id;
    createdTopicIds.push(otherTopicId);

    const otherPostRes = await authPost(`/api/topics/${otherTopicId}/posts`, {
      title: `Fresher post ${stamp}`,
      content: 'Sibling post',
    });
    expect(otherPostRes.status).toBe(201);
    const otherPostId = (await otherPostRes.json()).post.id;

    // Bump the original post's activity AFTER the fresh post is created.
    await new Promise((r) => setTimeout(r, 50));
    const bump = await authPost(`/api/posts/${postId}/comments`, {
      content: `final bump ${stamp}`,
    });
    expect(bump.status).toBe(201);

    // Wait for the bump to land.
    await waitFor(
      () => getPost(postId),
      (p) => new Date(p.lastActivityAt ?? 0).getTime() > new Date(otherPostRes.headers.get('date') ?? 0).getTime(),
      'post.lastActivityAt past sibling creation',
    );

    const feed = await authGet('/api/feed?sort=active&limit=100');
    expect(feed.status).toBe(200);
    const json = await feed.json();
    const ids: string[] = json.posts.map((p: { id: string }) => p.id);
    const bumpedIdx = ids.indexOf(postId);
    const siblingIdx = ids.indexOf(otherPostId);
    expect(bumpedIdx).toBeGreaterThanOrEqual(0);
    expect(siblingIdx).toBeGreaterThanOrEqual(0);
    expect(bumpedIdx).toBeLessThan(siblingIdx);
  });

  it('rejects unknown sort with 400 (no silent fallback)', async () => {
    const res = await authGet('/api/feed?sort=banana');
    expect(res.status).toBe(400);
  });

  it('post DELETE cleanup leaves topic deletable', async () => {
    // Verify the test fixture deletes cleanly. Acts as a small contract
    // test for the parent suite's afterAll.
    const res = await authDelete(`/api/posts/${postId}`);
    expect([200, 204].includes(res.status)).toBe(true);
  });
});
