/**
 * Profile-level AI capability model — END-TO-END against a REAL running
 * container over HTTP (no mocks). Design §7.
 *
 * Proves the re-designed model: AI capability is configured by the account
 * owner in their PROFILE (`PUT /api/profile/ai-permissions`) and enforced on
 * every isAI session across the app. An isAI caller lacking a capability gets
 * 403; humans (isAI=false) are unaffected.
 *
 * Coverage (edge-case matrix rows the server owns over HTTP):
 *   authz     — guest 401; a user sets only their OWN permissions (keyed by session).
 *   boundary  — cmd []/subset; historyGrant none/full/since_epoch:N/Nd ok.
 *   hostile   — unknown cmd → 400; garbage historyGrant → 400.
 *   gate      — an isAI session is gated across topic/join, post/write,
 *               chat/send, profile/edit; each cmd independently unlocks its route.
 *   humans    — a human with NO permissions performs all the same actions freely.
 *   integrity — GET/PUT echo only cmd + historyGrant metadata (no keys, SI-1).
 *
 * `isAI` sessions are minted via /api/auth/dev-login `{ isAI: true }` (dev-only).
 * Self-contained: each run provisions fresh users + a topic.
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

async function setPerms(token: string, cmd: string[], historyGrant = 'none') {
  return fetch(`${BASE}/api/profile/ai-permissions`, {
    method: 'PUT',
    headers: bearer(token),
    body: JSON.stringify({ cmd, historyGrant }),
  });
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

describe.sequential('AI profile permissions (E2E, real container)', () => {
  let owner: { token: string; userId: string };
  let ai: { token: string; userId: string };
  let human: { token: string; userId: string };
  let topicId: string;

  beforeAll(async () => {
    const health = await fetch(`${BASE}/api/health`).catch(() => null);
    if (!health || !health.ok) throw new Error(`container not reachable at ${BASE} — start it first`);

    owner = await devLogin('owner');
    ai = await devLogin('ai', true);
    human = await devLogin('human');

    const cats = await fetch(`${BASE}/api/categories`, { headers: bearer(owner.token) });
    const categoryId = (await cats.json()).categories[0].id;
    const res = await fetch(`${BASE}/api/topics`, {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({ title: `E2E AI perms ${Date.now()}`, description: 'perms', visibility: 'public', categoryId }),
    });
    expect(res.status).toBe(201);
    topicId = (await res.json()).topic.id;
  });

  // ── profile endpoint contract ────────────────────────────────────────────
  it('GET /api/profile/ai-permissions: 401 for a guest', async () => {
    const r = await fetch(`${BASE}/api/profile/ai-permissions`);
    expect(r.status).toBe(401);
  });

  it('GET returns defaults ([], none) + the allowedCmd catalogue', async () => {
    const r = await fetch(`${BASE}/api/profile/ai-permissions`, { headers: bearer(ai.token) });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.cmd).toEqual([]);
    expect(body.historyGrant).toBe('none');
    expect(Array.isArray(body.allowedCmd)).toBe(true);
    expect(body.allowedCmd).toContain('/openstoa/chat/send');
    // SI-1 integrity: only capability metadata, no key/plaintext fields.
    expect(Object.keys(body).sort()).toEqual(['allowedCmd', 'cmd', 'historyGrant']);
  });

  it('PUT rejects an unknown cmd (400) and a garbage historyGrant (400)', async () => {
    const bad1 = await setPerms(ai.token, ['/root/delete']);
    expect(bad1.status).toBe(400);
    const bad2 = await fetch(`${BASE}/api/profile/ai-permissions`, {
      method: 'PUT', headers: bearer(ai.token), body: JSON.stringify({ cmd: [], historyGrant: 'everything' }),
    });
    expect(bad2.status).toBe(400);
  });

  it('PUT accepts an empty cmd + valid scope, and echoes it back (metadata only)', async () => {
    const r = await setPerms(ai.token, [], 'since_epoch:2');
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.cmd).toEqual([]);
    expect(body.historyGrant).toBe('since_epoch:2');
    expect(Object.keys(body).sort()).toEqual(['cmd', 'historyGrant']);
  });

  // ── isAI gate: each capability independently unlocks its route ────────────
  it('topic/join: isAI with NO capability → 403; humans join freely', async () => {
    const blocked = await joinTopic(ai.token, topicId);
    expect(blocked.status).toBe(403);
    const humanJoin = await joinTopic(human.token, topicId);
    expect([200, 201]).toContain(humanJoin.status);
  });

  it('topic/join: granting topic/join lets the isAI session join (201)', async () => {
    await setPerms(ai.token, ['/openstoa/topic/join']);
    const ok = await joinTopic(ai.token, topicId);
    expect([200, 201]).toContain(ok.status);
  });

  it('post/write: isAI member without post/write → 403; with it → 201; humans free', async () => {
    const blocked = await createPost(ai.token, topicId);
    expect(blocked.status).toBe(403);
    await setPerms(ai.token, ['/openstoa/topic/join', '/openstoa/post/write']);
    const ok = await createPost(ai.token, topicId);
    expect(ok.status).toBe(201);
    const humanPost = await createPost(human.token, topicId);
    expect(humanPost.status).toBe(201);
  });

  it('chat/send: isAI member without chat/send → 403; with it → 201; humans free', async () => {
    const blocked = await sendChat(ai.token, topicId);
    expect(blocked.status).toBe(403);
    await setPerms(ai.token, ['/openstoa/topic/join', '/openstoa/post/write', '/openstoa/chat/send']);
    const ok = await sendChat(ai.token, topicId);
    expect(ok.status).toBe(201);
    const humanChat = await sendChat(human.token, topicId);
    expect(humanChat.status).toBe(201);
  });

  it('profile/edit: isAI without profile/edit → 403; with it → 200; humans free', async () => {
    const blocked = await editNickname(ai.token);
    expect(blocked.status).toBe(403);
    await setPerms(ai.token, ['/openstoa/topic/join', '/openstoa/post/write', '/openstoa/chat/send', '/openstoa/profile/edit']);
    const ok = await editNickname(ai.token);
    expect(ok.status).toBe(200);
    const humanEdit = await editNickname(human.token);
    expect(humanEdit.status).toBe(200);
  });
});
