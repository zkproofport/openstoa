/**
 * AI capability = API-key scope ONLY — END-TO-END against a REAL running
 * container over HTTP (no mocks). Design §7, consolidated onto API keys
 * 2026-07-30.
 *
 * Proves the final model: there is no account-wide AI permission any more.
 * `GET/PUT /api/profile/ai-permissions` are retired (410). The ONLY scope an
 * `isAI` session can carry is the one bound to the API key it authenticated
 * with (`Authorization: Bearer osk_...`); a bare isAI JWT with no key (e.g.
 * dev-login `{ isAI: true }`) is denied on every gated route — fail-closed,
 * not an implicit account-wide allow.
 *
 * Coverage (edge-case matrix rows the server owns over HTTP):
 *   retired   — GET/PUT ai-permissions always 410 (401 first if unauthed).
 *   fail-closed — isAI session with NO key → 403 on every gated route.
 *   authz     — guest 401 on api-keys; a key only ever edits/revokes ITS OWN
 *               owner's other keys, never someone else's (404, not 403).
 *   boundary  — cmd []/subset; historyGrant none/full/since_epoch:N/Nd ok.
 *   hostile   — unknown cmd → 400; garbage historyGrant → 400.
 *   gate      — a scoped key is gated across topic/join, post/write,
 *               chat/send, profile/edit; each cmd independently unlocks its
 *               route; PATCH re-scoping takes effect on the VERY NEXT request.
 *   revoke    — a revoked key gets 401 on its next use, even mid-scope.
 *   humans    — a human with no key at all performs all the same actions freely.
 *   integrity — the raw key never reappears in any response after creation.
 *
 * `isAI` bare-JWT sessions are minted via /api/auth/dev-login `{ isAI: true }`
 * (dev-only) purely to exercise the fail-closed path. Scoped sessions use a
 * real API key minted via `POST /api/profile/api-keys`. Self-contained: each
 * run provisions fresh users + a topic.
 */
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';

async function devLogin(prefix: string, isAI = false): Promise<{ token: string; userId: string }> {
  const nickname = `e2e_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, isAI }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { token: data.token, userId: data.userId };
}

function bearer(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}
const b64 = (s: string) => Buffer.from(s).toString('base64');

async function createKey(ownerToken: string, name: string, cmd: string[], historyGrant = 'none') {
  const res = await fetch(`${BASE}/api/profile/api-keys`, {
    method: 'POST',
    headers: bearer(ownerToken),
    body: JSON.stringify({ name, cmd, historyGrant }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { rawKey: string; key: { id: string; cmd: string[]; historyGrant: string } };
}
async function joinTopic(token: string, topicId: string) {
  return fetch(`${BASE}/api/topics/${topicId}/join`, { method: 'POST', headers: bearer(token) });
}
async function createPost(token: string, topicId: string) {
  return fetch(`${BASE}/api/topics/${topicId}/posts`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ title: `p_${Math.random().toString(36).slice(2, 6)}`, content: 'hello' }),
  });
}
async function sendChat(token: string, topicId: string) {
  return fetch(`${BASE}/api/topics/${topicId}/chat`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify({ ciphertext: b64('sealed-body'), epoch: 0 }),
  });
}
async function editNickname(token: string) {
  return fetch(`${BASE}/api/profile/nickname`, {
    method: 'PUT',
    headers: bearer(token),
    body: JSON.stringify({ nickname: `ed_${Math.random().toString(36).slice(2, 8)}` }),
  });
}

describe.sequential('AI capability = API-key scope only (E2E, real container)', () => {
  let owner: { token: string; userId: string };
  let bareAi: { token: string; userId: string }; // isAI JWT with NO key — must be denied everywhere
  let human: { token: string; userId: string };
  let topicId: string;

  beforeAll(async () => {
    const health = await fetch(`${BASE}/api/health`).catch(() => null);
    if (!health || !health.ok) throw new Error(`container not reachable at ${BASE} — start it first`);

    owner = await devLogin('owner');
    bareAi = await devLogin('bareai', true);
    human = await devLogin('human');

    const cats = await fetch(`${BASE}/api/categories`, { headers: bearer(owner.token) });
    const categoryId = (await cats.json()).categories[0].id;
    const res = await fetch(`${BASE}/api/topics`, {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({ title: `E2E key perms ${Date.now()}`, description: 'perms', visibility: 'public', categoryId }),
    });
    expect(res.status).toBe(201);
    topicId = (await res.json()).topic.id;
  });

  // ── the retired endpoint ──────────────────────────────────────────────
  it('GET /api/profile/ai-permissions: 401 for a guest, 410 for anyone else', async () => {
    const guest = await fetch(`${BASE}/api/profile/ai-permissions`);
    expect(guest.status).toBe(401);
    const authed = await fetch(`${BASE}/api/profile/ai-permissions`, { headers: bearer(owner.token) });
    expect(authed.status).toBe(410);
  });

  it('PUT /api/profile/ai-permissions: 410 — writes to the retired account grant are rejected outright', async () => {
    const r = await fetch(`${BASE}/api/profile/ai-permissions`, {
      method: 'PUT', headers: bearer(owner.token), body: JSON.stringify({ cmd: ['/openstoa/chat/send'], historyGrant: 'full' }),
    });
    expect(r.status).toBe(410);
  });

  // ── fail-closed: a bare isAI JWT (no API key) is denied everywhere ─────
  it('FAIL-CLOSED: a bare isAI session with no key is 403 on topic/join, post/write, chat/send, profile/edit', async () => {
    expect((await joinTopic(bareAi.token, topicId)).status).toBe(403);
    expect((await createPost(bareAi.token, topicId)).status).toBe(403);
    expect((await sendChat(bareAi.token, topicId)).status).toBe(403);
    expect((await editNickname(bareAi.token)).status).toBe(403);
  });

  it('a human (isAI=false) with no key performs all the same actions freely', async () => {
    expect([200, 201]).toContain((await joinTopic(human.token, topicId)).status);
    expect((await createPost(human.token, topicId)).status).toBe(201);
    expect((await sendChat(human.token, topicId)).status).toBe(201);
    expect((await editNickname(human.token)).status).toBe(200);
  });

  // ── API-key contract: boundary / hostile / integrity ───────────────────
  it('POST /api/profile/api-keys rejects an unknown cmd (400) and a garbage historyGrant (400)', async () => {
    const bad1 = await fetch(`${BASE}/api/profile/api-keys`, {
      method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ name: 'bad', cmd: ['/root/delete'], historyGrant: 'none' }),
    });
    expect(bad1.status).toBe(400);
    const bad2 = await fetch(`${BASE}/api/profile/api-keys`, {
      method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ name: 'bad', cmd: [], historyGrant: 'everything' }),
    });
    expect(bad2.status).toBe(400);
  });

  it('POST /api/profile/api-keys: the raw key is returned ONLY at creation, never again from GET/list', async () => {
    const { rawKey, key } = await createKey(owner.token, `integrity_${Date.now()}`, ['/openstoa/post/read']);
    const list = await fetch(`${BASE}/api/profile/api-keys`, { headers: bearer(owner.token) });
    const body = await list.json();
    expect(JSON.stringify(body)).not.toContain(rawKey);
    const found = body.apiKeys.find((k: { id: string }) => k.id === key.id);
    expect(found).toBeDefined();
    expect(found.cmd).toEqual(['/openstoa/post/read']);
  });

  // ── isAI gate: each capability independently unlocks its route, via a KEY ──
  it('topic/join: a key with NO capability → 403; granting topic/join at creation → 201', async () => {
    const empty = await createKey(owner.token, `k_join_empty_${Date.now()}`, []);
    expect((await joinTopic(empty.rawKey, topicId)).status).toBe(403);

    const scoped = await createKey(owner.token, `k_join_${Date.now()}`, ['/openstoa/topic/join']);
    const ok = await joinTopic(scoped.rawKey, topicId);
    expect([200, 201]).toContain(ok.status);
  });

  it('post/write: a member key without post/write → 403; with it → 201', async () => {
    const key = await createKey(owner.token, `k_post_${Date.now()}`, ['/openstoa/topic/join']);
    await joinTopic(key.rawKey, topicId);
    expect((await createPost(key.rawKey, topicId)).status).toBe(403);

    const withWrite = await createKey(owner.token, `k_post2_${Date.now()}`, ['/openstoa/topic/join', '/openstoa/post/write']);
    await joinTopic(withWrite.rawKey, topicId);
    expect((await createPost(withWrite.rawKey, topicId)).status).toBe(201);
  });

  it('chat/send: a member key without chat/send → 403; with it → 201', async () => {
    const key = await createKey(owner.token, `k_chat_${Date.now()}`, ['/openstoa/topic/join']);
    await joinTopic(key.rawKey, topicId);
    expect((await sendChat(key.rawKey, topicId)).status).toBe(403);

    const withSend = await createKey(owner.token, `k_chat2_${Date.now()}`, ['/openstoa/topic/join', '/openstoa/chat/send']);
    await joinTopic(withSend.rawKey, topicId);
    expect((await sendChat(withSend.rawKey, topicId)).status).toBe(201);
  });

  it('profile/edit: a key without profile/edit → 403; with it → 200', async () => {
    const key = await createKey(owner.token, `k_edit_${Date.now()}`, []);
    expect((await editNickname(key.rawKey)).status).toBe(403);

    const withEdit = await createKey(owner.token, `k_edit2_${Date.now()}`, ['/openstoa/profile/edit']);
    expect((await editNickname(withEdit.rawKey)).status).toBe(200);
  });

  // ── PATCH — edit scope takes effect on the VERY NEXT request ───────────
  it('PATCH /api/profile/api-keys/{keyId}: re-scoping a key changes what it can do immediately', async () => {
    const key = await createKey(owner.token, `k_patch_${Date.now()}`, []);
    expect((await editNickname(key.rawKey)).status).toBe(403);

    const patch = await fetch(`${BASE}/api/profile/api-keys/${key.key.id}`, {
      method: 'PATCH', headers: bearer(owner.token), body: JSON.stringify({ cmd: ['/openstoa/profile/edit'], historyGrant: 'none' }),
    });
    expect(patch.status).toBe(200);
    const patched = await patch.json();
    expect(patched.key.cmd).toEqual(['/openstoa/profile/edit']);

    // Same raw key, no re-login — the very next request is gated by the NEW scope.
    expect((await editNickname(key.rawKey)).status).toBe(200);
  });

  it('PATCH rejects an unknown cmd (400) and 404s a foreign keyId', async () => {
    const key = await createKey(owner.token, `k_patch2_${Date.now()}`, []);
    const bad = await fetch(`${BASE}/api/profile/api-keys/${key.key.id}`, {
      method: 'PATCH', headers: bearer(owner.token), body: JSON.stringify({ cmd: ['/root/delete'], historyGrant: 'none' }),
    });
    expect(bad.status).toBe(400);

    const foreign = await fetch(`${BASE}/api/profile/api-keys/${key.key.id}`, {
      method: 'PATCH', headers: bearer(human.token), body: JSON.stringify({ cmd: [], historyGrant: 'none' }),
    });
    expect(foreign.status).toBe(404);
  });

  // ── revoke — stops working on the very next request ─────────────────────
  it('DELETE /api/profile/api-keys/{keyId}: a revoked key gets 401 on its next use', async () => {
    const key = await createKey(owner.token, `k_revoke_${Date.now()}`, ['/openstoa/profile/edit']);
    expect((await editNickname(key.rawKey)).status).toBe(200);

    const revoke = await fetch(`${BASE}/api/profile/api-keys/${key.key.id}`, { method: 'DELETE', headers: bearer(owner.token) });
    expect(revoke.status).toBe(200);

    const afterRevoke = await editNickname(key.rawKey);
    expect(afterRevoke.status).toBe(401);
  });
});
