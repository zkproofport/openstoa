/*
 * WHAT WAS WRONG. `/api/tags` read the `tags` table directly — no join to
 * posts, no topic check, `security: []`. A tag is free text a person typed on
 * a post, so the tag name IS content, and this handed it out:
 *
 *   A writes, inside their own private space, a post tagged #mysecret9ad92f82
 *   GET /api/tags?q=mysecret…            guest  200  → the tag, postCount 1
 *   GET /api/tags?topicId=<A's space>    guest  200  → A's whole vocabulary
 *   GET /api/tags                        guest  200  → it sits in the top 20
 *
 * No login needed for any of them. `?topicId=` never asked about membership at
 * all, so any topic id read out its tag list.
 *
 * The row that said "private posts do not leak" was checked by searching post
 * TITLES and getting zero. Tags are a different projection of the same post,
 * and nothing was asking about them.
 *
 * These run against the real container over HTTP, because the defect was in
 * what the route asks the database, and a mock would have answered whatever
 * the test wanted.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3200';

async function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = {
    'x-openstoa-device-kind': 'mobile',
    'x-openstoa-device-id': `tags-e2e-${Math.random().toString(36).slice(2, 10)}`,
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function signUp(): Promise<string> {
  const { body } = await api('/api/auth/dev-login', { method: 'POST', body: '{}' });
  return body.token as string;
}

const uniq = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

let ownerToken: string;
let strangerToken: string;
let spaceId: string;
let publicTopicId: string;
/** Used ONLY inside the owner's private space. */
let privateTag: string;
/** Used in the private space AND a public topic. */
let sharedTag: string;

beforeAll(async () => {
  ownerToken = await signUp();
  strangerToken = await signUp();
  privateTag = `zzpriv${uniq()}`;
  sharedTag = `zzboth${uniq()}`;

  const mine = await api('/api/topics', { token: ownerToken });
  spaceId = mine.body.topics[0].id;

  const all = await api('/api/topics?view=all', { token: ownerToken });
  publicTopicId = all.body.topics.find((t: { visibility: string }) => t.visibility === 'public').id;
  await api(`/api/topics/${publicTopicId}/join`, { method: 'POST', token: ownerToken, body: '{}' });

  await api(`/api/topics/${spaceId}/posts`, {
    method: 'POST', token: ownerToken,
    body: JSON.stringify({ title: 'note one', content: 'x', tags: [privateTag, sharedTag] }),
  });
  await api(`/api/topics/${spaceId}/posts`, {
    method: 'POST', token: ownerToken,
    body: JSON.stringify({ title: 'note two', content: 'x', tags: [privateTag] }),
  });
  await api(`/api/topics/${publicTopicId}/posts`, {
    method: 'POST', token: ownerToken,
    body: JSON.stringify({ title: 'open post', content: 'x', tags: [sharedTag] }),
  });
}, 60_000);

const slugsOf = (body: { tags?: Array<{ slug: string }> }) => (body.tags ?? []).map((t) => t.slug);
const countOf = (body: { tags?: Array<{ slug: string; postCount: number }> }, slug: string) =>
  (body.tags ?? []).find((t) => t.slug === slug)?.postCount;

describe('a tag written in private stays private (E2E, real container)', () => {
  it('the owner finds their own tag — the control, so a later zero means something', async () => {
    const res = await api(`/api/tags?q=${privateTag}`, { token: ownerToken });
    expect(res.status).toBe(200);
    expect(slugsOf(res.body)).toContain(privateTag);
  });

  it('a stranger searching that exact tag gets nothing', async () => {
    const res = await api(`/api/tags?q=${privateTag}`, { token: strangerToken });
    expect(res.status).toBe(200);
    expect(slugsOf(res.body)).not.toContain(privateTag);
  });

  it('a logged-out caller gets nothing either', async () => {
    const res = await api(`/api/tags?q=${privateTag}`);
    expect(res.status).toBe(200);
    expect(slugsOf(res.body)).not.toContain(privateTag);
  });

  it('it does not surface in the unfiltered popular list', async () => {
    for (const token of [undefined, strangerToken]) {
      const res = await api('/api/tags', token ? { token } : {});
      expect(slugsOf(res.body)).not.toContain(privateTag);
    }
  });

  it('?topicId= on a topic the caller is not in returns an empty list, not its vocabulary', async () => {
    for (const token of [undefined, strangerToken]) {
      const res = await api(`/api/tags?topicId=${spaceId}`, token ? { token } : {});
      expect(res.status).toBe(200);
      expect(slugsOf(res.body)).toEqual([]);
    }
  });

  it('?topicId= still works for someone who IS in the topic', async () => {
    const res = await api(`/api/tags?topicId=${spaceId}`, { token: ownerToken });
    expect(res.status).toBe(200);
    expect(slugsOf(res.body)).toContain(privateTag);
  });

  it('a tag used in both places is visible to a stranger — but only the public use is counted', async () => {
    const stranger = await api(`/api/tags?q=${sharedTag}`, { token: strangerToken });
    expect(slugsOf(stranger.body)).toContain(sharedTag);
    expect(countOf(stranger.body, sharedTag)).toBe(1);

    const owner = await api(`/api/tags?q=${sharedTag}`, { token: ownerToken });
    expect(countOf(owner.body, sharedTag)).toBe(2);
  });

  it('the count is the truth, not one short of it', async () => {
    // `tags.postCount` is incremented only in the ON CONFLICT path, so the post
    // that creates a tag never counted. Two posts carry `privateTag`.
    const res = await api(`/api/tags?q=${privateTag}`, { token: ownerToken });
    expect(countOf(res.body, privateTag)).toBe(2);
  });

  it('an unknown topic id is answered the same as an invisible one', async () => {
    const res = await api('/api/tags?topicId=00000000-0000-4000-8000-000000000000', {
      token: strangerToken,
    });
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual([]);
  });

  it('hostile search input is data, not syntax', async () => {
    for (const q of ['%', '_', '\\', "'; drop table tags;--", '％', 'zz%priv']) {
      const res = await api(`/api/tags?q=${encodeURIComponent(q)}`, { token: strangerToken });
      expect(res.status).toBe(200);
      expect(slugsOf(res.body)).not.toContain(privateTag);
    }
  });
});
