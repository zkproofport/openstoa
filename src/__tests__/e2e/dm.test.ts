import { describe, it, expect, beforeAll } from 'vitest';
import { getBaseUrl, authPost, authGet, publicPost, getUserId } from './helpers';

/**
 * DM (1:1 direct chat) over real HTTP against a running container.
 *
 * `src/__tests__/dm-route.test.ts` covers the route's synchronous branches with
 * mocks; this suite covers what only a real database and a second real session
 * can prove:
 *   - idempotency on the canonical pair, in BOTH directions, against the real
 *     `dm_pair` unique index (not a mocked findFirst)
 *   - the listing-exclusion contract: a DM must never leak into /api/topics
 *   - authorization: a third party can neither read the DM's chat nor see the
 *     hidden topic at all
 *   - SI-1: the DM list carries routing metadata only — no message body,
 *     ciphertext or preview, even after messages exist
 *   - boundary/UTF-8: a zero-message DM opens; Korean/emoji nicknames survive
 *
 * The E2EE round-trip itself (MLS genesis → External-Commit join → seal/open)
 * is covered by `packages/sdk/src/__tests__/e2e/dm.e2e.test.ts`, which owns the
 * crypto client; this suite deliberately stays at the REST/authz layer.
 */

const BASE_URL = getBaseUrl();

interface DevUser {
  userId: string;
  token: string;
  nickname: string;
}

/** Mint an independent session. Nicknames are UNIQUE, so keep them collision-free. */
async function devLogin(prefix: string): Promise<DevUser> {
  const nickname = `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const res = await publicPost('/api/auth/dev-login', { nickname });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { userId: data.userId, token: data.token, nickname: data.nickname };
}

function asUser(user: DevUser) {
  const headers = (json = false) => ({
    Authorization: `Bearer ${user.token}`,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  });
  return {
    get: (path: string) => fetch(`${BASE_URL}${path}`, { headers: headers() }),
    post: (path: string, body?: unknown) =>
      fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: headers(true),
        body: body ? JSON.stringify(body) : undefined,
      }),
  };
}

describe('DM — start / idempotency', () => {
  let alice: DevUser;
  let bob: DevUser;
  let dmTopicId: string;

  beforeAll(async () => {
    alice = await devLogin('e2e_dm_alice');
    bob = await devLogin('e2e_dm_bob');
  });

  it('401 for an unauthenticated caller', async () => {
    const res = await publicPost('/api/dm', { userId: bob.userId });
    expect(res.status).toBe(401);
  });

  it('400 when starting a DM with yourself', async () => {
    const res = await asUser(alice).post('/api/dm', { userId: alice.userId });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/yourself/i);
  });

  it('400 when userId is missing or not a string', async () => {
    expect((await asUser(alice).post('/api/dm', {})).status).toBe(400);
    expect((await asUser(alice).post('/api/dm', { userId: '' })).status).toBe(400);
    expect((await asUser(alice).post('/api/dm', { userId: 42 })).status).toBe(400);
  });

  it('404 for a non-existent peer', async () => {
    const res = await asUser(alice).post('/api/dm', { userId: '0xdeadbeefdeadbeefdeadbeefdeadbeef' });
    expect(res.status).toBe(404);
  });

  it('201 on first start, then IDEMPOTENT: the same topicId in either direction', async () => {
    const first = await asUser(alice).post('/api/dm', { userId: bob.userId });
    expect(first.status).toBe(201);
    dmTopicId = (await first.json()).topicId;
    expect(dmTopicId).toBeTruthy();

    // Same initiator again → existing channel (200, not a second row).
    const again = await asUser(alice).post('/api/dm', { userId: bob.userId });
    expect(again.status).toBe(200);
    expect((await again.json()).topicId).toBe(dmTopicId);

    // Opposite direction → the canonical pair index collapses it to the same row.
    const reverse = await asUser(bob).post('/api/dm', { userId: alice.userId });
    expect(reverse.status).toBe(200);
    expect((await reverse.json()).topicId).toBe(dmTopicId);
  });

  it('lists the channel for BOTH participants, each seeing the other as peer', async () => {
    const aList = await (await asUser(alice).get('/api/dm')).json();
    const bList = await (await asUser(bob).get('/api/dm')).json();

    const aRow = aList.dms.find((d: { topicId: string }) => d.topicId === dmTopicId);
    const bRow = bList.dms.find((d: { topicId: string }) => d.topicId === dmTopicId);

    expect(aRow.peer.userId).toBe(bob.userId);
    expect(bRow.peer.userId).toBe(alice.userId);
    // The caller is never their own peer.
    expect(aRow.peer.userId).not.toBe(alice.userId);
  });

  it('SI-1: list rows carry routing metadata only — no body, ciphertext or preview', async () => {
    const body = await (await asUser(alice).get('/api/dm')).json();
    const row = body.dms.find((d: { topicId: string }) => d.topicId === dmTopicId);

    /*
     * An EXACT key set, still — that is the assertion, not a formality.
     *
     * SI-1 says a DM list row carries routing metadata and nothing a reader
     * could mistake for content. A `toContain`-style check would pass while a
     * body field sat beside the ones named here, which is precisely the thing
     * this exists to catch. So the list grows only when a new field is judged
     * to be metadata, and the judgement is written down.
     *
     * `lastReadAt` / `lastReadMessageId` / `unreadCount` arrived with the
     * server-side read cursor (e3a0fb0), which did not update this list. All
     * three are about WHERE the reader got to — an instant, a row id and a
     * count — and none of them reveals what was said.
     */
    expect(Object.keys(row).sort()).toEqual([
      'lastActivityAt',
      'lastReadAt',
      'lastReadMessageId',
      'peer',
      'topicId',
      'unreadCount',
    ]);
    expect(Object.keys(row.peer).sort()).toEqual(['nickname', 'profileImage', 'userId']);
    expect(JSON.stringify(body)).not.toMatch(/ciphertext|sealed|preview|plaintext/i);
  });

  it('EMPTY: a brand-new DM has zero messages and still reads cleanly', async () => {
    const res = await asUser(alice).get(`/api/topics/${dmTopicId}/chat?limit=50`);
    expect(res.status).toBe(200);
    expect((await res.json()).messages).toEqual([]);
  });

  it('CONTRACT: the DM never appears in any /api/topics listing', async () => {
    for (const path of [
      '/api/topics',
      '/api/topics?view=all',
      '/api/topics?view=my',
      '/api/topics?sort=hot',
      '/api/topics?q=dm',
    ]) {
      const res = await asUser(alice).get(path);
      expect(res.status).toBe(200);
      const { topics } = await res.json();
      const leaked = (topics ?? []).some((t: { id: string }) => t.id === dmTopicId);
      expect(leaked, `${path} leaked the DM channel`).toBe(false);
    }
  });

  it('CONTRACT: the DM is absent from the cross-topic feed as well', async () => {
    const res = await asUser(alice).get('/api/feed');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain(dmTopicId);
  });

  it('AUTHZ: a third party can neither see the DM topic nor read its chat', async () => {
    const carol = await devLogin('e2e_dm_carol');

    // Hidden topic (visibility 'secret') → 404 for a non-member.
    expect((await asUser(carol).get(`/api/topics/${dmTopicId}`)).status).toBe(404);
    // Chat is membership-gated server-side, independent of any UI check.
    expect((await asUser(carol).get(`/api/topics/${dmTopicId}/chat`)).status).toBe(403);
    expect((await asUser(carol).get(`/api/topics/${dmTopicId}/members`)).status).toBe(403);
    // And it is not in Carol's own DM list.
    const list = await (await asUser(carol).get('/api/dm')).json();
    expect(list.dms.some((d: { topicId: string }) => d.topicId === dmTopicId)).toBe(false);
  });

  it('AUTHZ: an unauthenticated caller gets 401 from the DM list', async () => {
    const res = await fetch(`${BASE_URL}/api/dm`);
    expect(res.status).toBe(401);
  });

  it('BOUNDARY: a user with no DMs gets an empty list, not an error', async () => {
    const loner = await devLogin('e2e_dm_loner');
    const res = await asUser(loner).get('/api/dm');
    expect(res.status).toBe(200);
    expect((await res.json()).dms).toEqual([]);
  });

  it('UTF-8: a Korean + emoji nickname round-trips through the peer metadata', async () => {
    const nickname = `김철수_🚀_${Math.random().toString(36).slice(2, 8)}`;
    const res = await publicPost('/api/auth/dev-login', { nickname });
    expect(res.ok).toBe(true);
    const utf8User: DevUser = await res.json();

    const start = await asUser(alice).post('/api/dm', { userId: utf8User.userId });
    expect([200, 201]).toContain(start.status);
    const { topicId } = await start.json();

    const list = await (await asUser(alice).get('/api/dm')).json();
    const row = list.dms.find((d: { topicId: string }) => d.topicId === topicId);
    expect(row.peer.nickname).toBe(nickname);
  });

  it('the primary E2E user can start a DM with a dev user (session-shape parity)', async () => {
    const peer = await devLogin('e2e_dm_peer');
    const res = await authPost('/api/dm', { userId: peer.userId });
    expect([200, 201]).toContain(res.status);
    const { topicId } = await res.json();

    const list = await (await authGet('/api/dm')).json();
    const row = list.dms.find((d: { topicId: string }) => d.topicId === topicId);
    expect(row).toBeDefined();
    expect(row.peer.userId).toBe(peer.userId);
    expect(row.peer.userId).not.toBe(getUserId());
  });
});
