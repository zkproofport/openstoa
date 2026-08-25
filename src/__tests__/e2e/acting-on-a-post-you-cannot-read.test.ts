import { E2E_DEVICE_HEADERS } from './helpers';
/**
 * You may only act on a post you can READ.
 *
 * THE DEFECT, found by probing a real container. `comments` checked membership;
 * `reactions`, `vote`, `bookmark` and `record` checked nothing. A signed-in
 * stranger holding a post id could react to and upvote a post inside somebody's
 * private topic — observed as `{"added":true}`, `{"upvoteCount":1}` and
 * `{"bookmarked":true}`, all 200, from an account with no membership anywhere
 * near it. The mark lands where the owner sees it and the vote moves the score.
 *
 * Four routes, one question, and only one of them was asking it.
 *
 * It predates personal spaces and applies to every private and secret topic.
 * What changed is the reach: every account now has private content by default,
 * so "some users have posts a stranger could touch" became "all of them do".
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   authz     → a stranger cannot react / vote / bookmark / record on a post
 *               in someone's personal space
 *   contract  → the OWNER still can, or the fix broke the feature
 *   boundary  → a PUBLIC post is unaffected: a non-member may still react and
 *               vote, which is the existing product rule and must not change
 *   integrity → the record route answers the refusal BEFORE its policy check,
 *               which would otherwise disclose the post's age to a stranger
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';
const bearer = (t: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${t}` });

async function login(prefix: string): Promise<{ token: string; userId: string }> {
  const r = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...E2E_DEVICE_HEADERS },
    body: JSON.stringify({ nickname: `e2e_${prefix}_${Date.now().toString(36)}` }),
  });
  return r.json();
}

async function post(token: string, topicId: string, title: string): Promise<string> {
  const r = await fetch(`${BASE}/api/topics/${topicId}/posts`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ title, content: 'body' }),
  });
  const b = await r.json();
  return b.post?.id ?? b.id;
}

describe('acting on a post you cannot read (E2E, real container)', () => {
  let owner: { token: string; userId: string };
  let stranger: { token: string; userId: string };
  let privatePost: string;
  let publicPost: string;

  beforeAll(async () => {
    owner = await login('act_owner');
    stranger = await login('act_stranger');

    const mine = await (await fetch(`${BASE}/api/topics`, { headers: bearer(owner.token) })).json();
    const space = (mine.topics as Array<{ id: string; personal?: boolean }>).find((t) => t.personal)!.id;
    privatePost = await post(owner.token, space, `zz-act-private-${Date.now().toString(36)}`);

    const cats = await (await fetch(`${BASE}/api/categories`)).json();
    const made = await (
      await fetch(`${BASE}/api/topics`, {
        method: 'POST',
        headers: bearer(owner.token),
        body: JSON.stringify({
          title: `e2e-act-public-${Date.now().toString(36)}`,
          description: 'control',
          visibility: 'public',
          categoryId: cats.categories[0].id,
        }),
      })
    ).json();
    publicPost = await post(owner.token, made.topic?.id ?? made.id, `zz-act-public-${Date.now().toString(36)}`);
  });

  const ACTIONS: Array<[string, (id: string) => [string, RequestInit]]> = [
    ['react', (id) => [`${BASE}/api/posts/${id}/reactions`, { method: 'POST', body: JSON.stringify({ emoji: '👍' }) }]],
    ['vote', (id) => [`${BASE}/api/posts/${id}/vote`, { method: 'POST', body: JSON.stringify({ value: 1 }) }]],
    ['bookmark', (id) => [`${BASE}/api/posts/${id}/bookmark`, { method: 'POST' }]],
  ];

  it.each(ACTIONS)('AUTHZ: a stranger cannot %s a post in a personal space', async (_n, build) => {
    const [url, init] = build(privatePost);
    const r = await fetch(url, { ...init, headers: bearer(stranger.token) });
    expect(r.status).toBe(403);
  });

  it('AUTHZ: a stranger cannot record it — and is not told how old it is', async () => {
    /*
     * The record route's policy check answers with facts about the post ("must
     * be at least 1 hour old, 6 minutes remaining"), so running it before the
     * authorisation would tell a stranger when a private post was written. The
     * refusal has to come first, and it has to be the membership one.
     */
    const r = await fetch(`${BASE}/api/posts/${privatePost}/record`, {
      method: 'POST',
      headers: bearer(stranger.token),
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(403);
    const body = await r.json();
    expect(body.error).not.toMatch(/hour|minute/i);
  });

  it.each(ACTIONS)('CONTRACT: the OWNER can still %s their own post', async (_n, build) => {
    const [url, init] = build(privatePost);
    const r = await fetch(url, { ...init, headers: bearer(owner.token) });
    expect([200, 201]).toContain(r.status);
  });

  it.each(ACTIONS)('BOUNDARY: a non-member may still %s a PUBLIC post', async (_n, build) => {
    /*
     * The existing product rule, and the thing a careless fix would break:
     * public topics are open to any signed-in reader without joining. A gate
     * that also closed this would pass every authorisation test and quietly
     * remove the community's main interaction.
     */
    const [url, init] = build(publicPost);
    const r = await fetch(url, { ...init, headers: bearer(stranger.token) });
    expect([200, 201]).toContain(r.status);
  });

  it('AUTHZ: a stranger cannot vote in a poll inside a personal space', async () => {
    /*
     * The fifth route of the same kind, and the one still missing the check
     * after the first four were fixed — found by sweeping every post-write
     * route for an authorisation call rather than by remembering it existed.
     *
     * A poll is worse than a reaction in one way: the tally moves, and the
     * owner sees a number they did not put there.
     */
    const mine = await (await fetch(`${BASE}/api/topics`, { headers: bearer(owner.token) })).json();
    const space = (mine.topics as Array<{ id: string; personal?: boolean }>).find((t) => t.personal)!.id;

    const made = await (
      await fetch(`${BASE}/api/topics/${space}/posts`, {
        method: 'POST',
        headers: bearer(owner.token),
        body: JSON.stringify({
          title: `zz-poll-${Date.now().toString(36)}`,
          content: 'private',
          poll: { question: 'mine only?', options: ['a', 'b'] },
        }),
      })
    ).json();
    const id = made.post?.id ?? made.id;

    const full = await (await fetch(`${BASE}/api/posts/${id}`, { headers: bearer(owner.token) })).json();
    const optionId = ((full.post ?? full).poll?.options ?? [])[0]?.id;
    expect(optionId, 'the poll did not come back with options').toBeTruthy();

    const r = await fetch(`${BASE}/api/posts/${id}/poll/vote`, {
      method: 'POST',
      headers: bearer(stranger.token),
      body: JSON.stringify({ optionIds: [optionId] }),
    });
    expect(r.status).toBe(403);

    // ...and the owner can still vote in their own poll.
    const own = await fetch(`${BASE}/api/posts/${id}/poll/vote`, {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({ optionIds: [optionId] }),
    });
    expect([200, 201]).toContain(own.status);
  });

});
