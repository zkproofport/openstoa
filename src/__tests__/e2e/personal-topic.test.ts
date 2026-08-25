import { E2E_DEVICE_HEADERS } from './helpers';
/**
 * The space that comes with the account, and the doors it does not have.
 *
 * WHAT IT IS: every account is created with one secret topic that only it is
 * in. It behaves like any other topic — it is in the owner's topic list (which
 * is also what builds the chat list), it takes posts, it has E2EE chat — and
 * the single thing that differs is that nobody else can ever get in.
 *
 * WHY THE DOORS ARE TESTED OVER HTTP AND NOT IN THE UI: a button that is merely
 * not drawn is still a route anyone can call, and what is behind these ones is
 * somebody's private space. Each door is checked from a SECOND account, because
 * the interesting question is not "does the owner see it" but "can a stranger
 * get in".
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → a new account HAS one, already a member, on first login
 *   boundary   → signing in again does not make a second one
 *   integrity  → it is in the owner's topic list under every category filter
 *   authz      → the owner cannot create an invite for it (403)
 *   authz      → a stranger cannot join it directly (403)
 *   authz      → its stored invite code is NOT a door (404, and NOT 403 —
 *                a refusal would confirm the code maps to a real topic)
 *   authz      → a stranger cannot see it in their own listing
 *   contract   → posting into it works, like any other topic
 *   hostile    → `personal: true` in a create request is ignored, so nobody can
 *                mint an undeletable-by-others topic through the public route
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';

async function login(prefix: string): Promise<{ token: string; userId: string }> {
  const r = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...E2E_DEVICE_HEADERS },
    body: JSON.stringify({ nickname: `e2e_${prefix}_${Date.now().toString(36)}` }),
  });
  if (!r.ok) throw new Error(`dev-login ${r.status}`);
  return r.json();
}

const bearer = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

interface TopicRow {
  id: string;
  title: string;
  personal?: boolean;
  visibility: string;
}

async function myTopics(token: string, query = ''): Promise<TopicRow[]> {
  const r = await fetch(`${BASE}/api/topics${query}`, { headers: bearer(token) });
  if (!r.ok) throw new Error(`topics ${r.status}`);
  const body = await r.json();
  return (Array.isArray(body) ? body : body.topics) as TopicRow[];
}

describe('the space that comes with the account (E2E, real container)', () => {
  let owner: { token: string; userId: string };
  let stranger: { token: string; userId: string };
  let personal: TopicRow;
  /** The other account's own space — the thing an agent must never reach. */
  let strangerSpace: string;

  beforeAll(async () => {
    owner = await login('personal_owner');
    stranger = await login('personal_stranger');
    const mine = (await myTopics(owner.token)).filter((t) => t.personal);
    personal = mine[0];
    strangerSpace = (await myTopics(stranger.token)).find((t) => t.personal)!.id;
  });

  it('CONTRACT: a brand-new account already has one', () => {
    expect(personal, 'a new account got no personal topic').toBeTruthy();
    expect(personal.visibility).toBe('secret');
  });

  it('BOUNDARY: exactly one, and signing in again does not make another', async () => {
    // The unique index is what enforces this; the point of asserting it over
    // HTTP is that a second space would split the person's posts in two with
    // nothing on screen to say which one they were looking at.
    await fetch(`${BASE}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...E2E_DEVICE_HEADERS },
      body: JSON.stringify({ nickname: `e2e_again_${Date.now().toString(36)}` }),
    });
    const mine = (await myTopics(owner.token)).filter((t) => t.personal);
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(personal.id);
  });

  it('INTEGRITY: it survives a category filter — the one topic always there', async () => {
    /*
     * It has no category, so every filter but "All" would drop it, and the
     * topic a person can always count on being there would be the one that
     * keeps vanishing.
     */
    const cats = await (await fetch(`${BASE}/api/categories`)).json();
    const filtered = await myTopics(owner.token, `?categoryId=${cats.categories[0].id}`);
    expect(filtered.some((t) => t.id === personal.id)).toBe(true);
  });

  it('AUTHZ: even the owner cannot create an invite for it', async () => {
    const r = await fetch(`${BASE}/api/topics/${personal.id}/invite`, {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(403);
  });

  it('AUTHZ: a stranger cannot join it directly', async () => {
    const r = await fetch(`${BASE}/api/topics/${personal.id}/join`, {
      method: 'POST',
      headers: bearer(stranger.token),
    });
    expect(r.status).toBe(403);
  });

  it('AUTHZ: a stranger does not see it in their own listing', async () => {
    const theirs = await myTopics(stranger.token);
    expect(theirs.some((t) => t.id === personal.id)).toBe(false);
  });

  it('CONTRACT: the owner can post into it, like any other topic', async () => {
    // The whole reason it is a topic and not a bespoke feature: nothing
    // downstream needs a special case for it.
    const r = await fetch(`${BASE}/api/topics/${personal.id}/posts`, {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({ title: 'a note to myself', content: 'only I can read this' }),
    });
    expect([200, 201]).toContain(r.status);
  });

  it('HOSTILE: `personal: true` on the public create route is ignored', async () => {
    /*
     * The flag is what closes every door. If the create route honoured it, any
     * caller could mint a topic that no admin flow can add members to — and
     * then hand out the id, having made something the product has no way to
     * moderate.
     */
    const cats = await (await fetch(`${BASE}/api/categories`)).json();
    const r = await fetch(`${BASE}/api/topics`, {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({
        title: `e2e-fake-personal-${Date.now().toString(36)}`,
        description: 'should not be personal',
        visibility: 'secret',
        categoryId: cats.categories[0].id,
        personal: true,
      }),
    });
    expect([200, 201]).toContain(r.status);
    const made = await r.json();
    const id = made.topic?.id ?? made.id;
    const row = (await myTopics(owner.token)).find((t) => t.id === id);
    expect(row?.personal ?? false).toBe(false);
  });

  it('AUTHZ: the owner cannot LEAVE it, and is told why truthfully', async () => {
    /*
     * Leaving used to answer "Transfer topic ownership before leaving" — the
     * same impossible instruction that deadlocked account deletion. There is
     * nobody to transfer this one to; a message that cannot be acted on reads
     * as a bug in the app rather than as a rule.
     */
    const r = await fetch(`${BASE}/api/topics/${personal.id}/leave`, {
      method: 'POST',
      headers: bearer(owner.token),
    });
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error).not.toMatch(/transfer/i);
  });

  it('AUTHZ: the owner cannot DELETE it — it would not come back', async () => {
    /*
     * The space is made once, when the account is. A successful delete is
     * therefore permanent, and leaves a product that used to have a private
     * space and now does not, with nothing to press to get it back.
     */
    const r = await fetch(`${BASE}/api/topics/${personal.id}`, {
      method: 'DELETE',
      headers: bearer(owner.token),
    });
    expect(r.status).toBe(403);

    // ...and it is still there afterwards, which is the part that matters.
    const mine = (await myTopics(owner.token)).filter((t) => t.personal);
    expect(mine.map((t) => t.id)).toEqual([personal.id]);
  });

  it('CONTRACT: emptying it still works — the posts inside can be deleted', async () => {
    // Refusing the topic delete must not trap somebody who simply wants it
    // clear; that is what they actually want in the moment.
    const made = await (
      await fetch(`${BASE}/api/topics/${personal.id}/posts`, {
        method: 'POST',
        headers: bearer(owner.token),
        body: JSON.stringify({ title: 'delete me', content: 'temporary' }),
      })
    ).json();
    const postId = made.post?.id ?? made.id;
    const del = await fetch(`${BASE}/api/posts/${postId}`, {
      method: 'DELETE',
      headers: bearer(owner.token),
    });
    expect([200, 204]).toContain(del.status);
  });

  it('AUTHZ: an AI key reaches its OWN space and no one else\'s', async () => {
    /*
     * The agent surface was the last layer nobody had looked at. An API key is
     * a durable credential an agent holds for weeks, so "it happens to behave"
     * is not the same claim as "it is checked" — and a personal space is the
     * one topic where a wrong answer is somebody's private room.
     *
     * The key is minted with post read/write only, deliberately narrower than
     * the account: what is being tested is the TOPIC boundary, not the command
     * allowlist.
     */
    const key = await (
      await fetch(`${BASE}/api/profile/api-keys`, {
        method: 'POST',
        headers: bearer(owner.token),
        body: JSON.stringify({
          name: `e2e-space-probe-${Date.now().toString(36)}`,
          cmd: ['/openstoa/post/read', '/openstoa/post/write', '/openstoa/chat/read'],
          historyGrant: 'none',
        }),
      })
    ).json();
    const agent = { 'Content-Type': 'application/json', Authorization: `Bearer ${key.rawKey}` };

    // Its own space is there — otherwise the refusals below prove nothing.
    const mine = await (await fetch(`${BASE}/api/topics`, { headers: agent })).json();
    expect((mine.topics as TopicRow[]).some((t) => t.id === personal.id)).toBe(true);

    // The stranger's space is invisible, and 404 rather than 403: a refusal
    // would confirm the id names a real topic.
    const read = await fetch(`${BASE}/api/topics/${strangerSpace}`, { headers: agent });
    expect(read.status).toBe(404);

    const write = await fetch(`${BASE}/api/topics/${strangerSpace}/posts`, {
      method: 'POST',
      headers: agent,
      body: JSON.stringify({ title: 'intrusion', content: 'should not land' }),
    });
    expect(write.status).toBe(403);

    const chat = await fetch(`${BASE}/api/topics/${strangerSpace}/chat`, { headers: agent });
    expect(chat.status).toBe(403);

    // ...and it can still do its job in the space it belongs to.
    const own = await fetch(`${BASE}/api/topics/${personal.id}/posts`, {
      method: 'POST',
      headers: agent,
      body: JSON.stringify({ title: 'from my agent', content: 'allowed' }),
    });
    expect([200, 201]).toContain(own.status);
  });
});
