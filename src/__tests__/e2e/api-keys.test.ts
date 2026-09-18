/**
 * Durable API keys — END-TO-END against a REAL running container over HTTP
 * (design §7 follow-up, no mocks).
 *
 * A login session authenticates the account; its owner-issued key independently
 * limits each business request. Key-only calls remain unauthenticated (401),
 * while scope denial, owner mismatch, or revocation with a valid session is403.
 * Tests cover allowed and refused operations without replacing the login.
 *
 * Also covers the CRUD contract (create/list/revoke) and boundary/hostile rows
 * (unknown cmd, invalid scope, guest, foreign-key revoke) over real HTTP.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { E2E_DEVICE_HEADERS } from './helpers';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';

async function devLogin(prefix: string): Promise<{ token: string; userId: string }> {
  const nickname = `e2e_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    // The suite stands in for the mobile app; a login that declares nothing
    // defaults to `web`, and chat / MLS / TAK are refused to a web session.
    headers: { 'Content-Type': 'application/json', ...E2E_DEVICE_HEADERS },
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { token: data.token, userId: data.userId };
}

// A fixture key selects permissions alongside its issuer's existing login.
// Unknown keys stay literal Bearer inputs for the explicit authentication-negative tests.
const keySessions = new Map<string, string>();
function bearer(token: string) {
  const session = keySessions.get(token);
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${session ?? token}`, ...(session ? { 'X-OpenStoa-API-Key': token } : {}) };
}
const b64 = (s: string) => Buffer.from(s).toString('base64');

async function createKey(ownerToken: string, cmd: string[], historyGrant = 'none', name = 'e2e-key') {
  const res = await fetch(`${BASE}/api/profile/api-keys`, {
    method: 'POST',
    headers: bearer(ownerToken),
    body: JSON.stringify({ name, cmd, historyGrant }),
  });
  if (res.status !== 201) throw new Error(`create key failed: ${res.status} ${await res.text()}`);
  const created = await res.json() as { rawKey: string; key: { id: string; prefix: string; cmd: string[] } };
  keySessions.set(created.rawKey, ownerToken);
  return created;
}

describe.sequential('API keys (E2E, real container)', () => {
  let owner: { token: string; userId: string };
  // Owner's OWN topic — owner is auto-added as its 'owner' member on creation
  // (see src/app/api/topics/route.ts), so this is the right fixture for
  // capability checks that only need "already a member" (chat/read, post/write).
  let topicId: string;
  // A SEPARATE topic created by a third party, so `owner` starts out as a
  // non-member — the right fixture to prove the topic/join capability
  // actually performs a real join (not just "gate passes"), without the
  // pre-existing membership from topicId masking it behind a 409.
  let joinTopicId: string;

  beforeAll(async () => {
    const health = await fetch(`${BASE}/api/health`).catch(() => null);
    if (!health || !health.ok) throw new Error(`container not reachable at ${BASE} — start it first`);

    owner = await devLogin('key_owner');
    const seed = await devLogin('key_seed');

    const cats = await fetch(`${BASE}/api/categories`, { headers: bearer(owner.token) });
    const categoryId = (await cats.json()).categories[0].id;

    const res = await fetch(`${BASE}/api/topics`, {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({ title: `E2E API keys ${Date.now()}`, description: 'api keys', visibility: 'public', categoryId }),
    });
    expect(res.status).toBe(201);
    topicId = (await res.json()).topic.id;

    const res2 = await fetch(`${BASE}/api/topics`, {
      method: 'POST',
      headers: bearer(seed.token),
      body: JSON.stringify({ title: `E2E API keys join-target ${Date.now()}`, description: 'join target', visibility: 'public', categoryId }),
    });
    expect(res2.status).toBe(201);
    joinTopicId = (await res2.json()).topic.id;
  });

  // ── CRUD contract + validation ───────────────────────────────────────────
  it('POST /api/profile/api-keys: 401 for a guest', async () => {
    const r = await fetch(`${BASE}/api/profile/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', cmd: [], historyGrant: 'none' }),
    });
    expect(r.status).toBe(401);
  });

  it('POST rejects an unknown cmd (400) and a garbage historyGrant (400)', async () => {
    const bad1 = await fetch(`${BASE}/api/profile/api-keys`, {
      method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ name: 'x', cmd: ['/root/delete'], historyGrant: 'none' }),
    });
    expect(bad1.status).toBe(400);
    const bad2 = await fetch(`${BASE}/api/profile/api-keys`, {
      method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ name: 'x', cmd: [], historyGrant: 'whenever' }),
    });
    expect(bad2.status).toBe(400);
  });

  it('POST issues a key: 201, raw key shown once, SI-1 — response never carries a hash', async () => {
    const created = await createKey(owner.token, ['/openstoa/chat/read'], 'none', 'crud-probe');
    expect(created.rawKey.startsWith('osk_')).toBe(true);
    expect(JSON.stringify(created)).not.toMatch(/keyHash/i);
    // GET list surfaces the metadata, never the raw key.
    const list = await (await fetch(`${BASE}/api/profile/api-keys`, { headers: bearer(owner.token) })).json();
    const mine = list.apiKeys.find((k: { id: string }) => k.id === created.key.id);
    expect(mine).toBeTruthy();
    expect(mine.prefix).toBe(created.key.prefix);
    expect(JSON.stringify(list)).not.toContain(created.rawKey);
  });

  it('DELETE: 404 for an unknown/foreign keyId; 401 for a guest', async () => {
    const guest = await fetch(`${BASE}/api/profile/api-keys/00000000-0000-0000-0000-000000000000`, { method: 'DELETE' });
    expect(guest.status).toBe(401);
    const notFound = await fetch(`${BASE}/api/profile/api-keys/00000000-0000-0000-0000-000000000000`, {
      method: 'DELETE', headers: bearer(owner.token),
    });
    expect(notFound.status).toBe(404);
  });

  it('requires a login and an owner-matching selected key; a key alone never authenticates', async () => {
    const created = await createKey(owner.token, ['/openstoa/chat/read'], 'full');
    const other = await devLogin('key_wrong_owner');
    const url = `${BASE}/api/topics/${topicId}/chat`;
    expect((await fetch(url, {headers: {'X-OpenStoa-API-Key': created.rawKey}})).status).toBe(401);
    expect((await fetch(url, {headers: {Authorization: `Bearer ${created.rawKey}`}})).status).toBe(401);
    const mismatch = await fetch(url, {headers: {...bearer(other.token), 'X-OpenStoa-API-Key': created.rawKey}});
    expect(mismatch.status).toBe(403);
    expect((await fetch(url, {headers: bearer(created.rawKey)})).status).toBe(200);
  });

  // ── the requested scenario: scoped key, allowed vs out-of-scope, then revoke ──
  it('a logged-in agent using a scoped key can do allowed ops but is 403\'d on an out-of-scope op; revoke → 403', async () => {
    // Scoped to topic/join + chat/read — deliberately NOT post/write.
    // historyGrant 'full': this case is about the CMD allowlist, and a bounded
    // grant would 403 the chat read below for an unrelated reason (grant
    // enforcement lives in `src/lib/historyGrant.ts` and is covered by
    // apikey-gated-topics.test.ts).
    const created = await createKey(owner.token, ['/openstoa/topic/join', '/openstoa/chat/read'], 'full', 'scoped-agent-key');
    const agentAuth = bearer(created.rawKey);

    // Allowed: join a topic owner is NOT already a member of, using the
    // saved login plus selected permission key — proves a REAL join, not just a
    // gate pass-through masked by a pre-existing membership.
    const join = await fetch(`${BASE}/api/topics/${joinTopicId}/join`, { method: 'POST', headers: agentAuth });
    expect([200, 201]).toContain(join.status);

    // Allowed: read chat history using the login plus selected key (topicId — owner is
    // already a member there via topic creation, so this isolates the
    // chat/read capability check from membership/join mechanics).
    const read = await fetch(`${BASE}/api/topics/${topicId}/chat`, { headers: agentAuth });
    expect(read.status).toBe(200);

    // Out of scope: post/write is NOT in this key's cmd — 403, not silently allowed.
    const write = await fetch(`${BASE}/api/topics/${topicId}/posts`, {
      method: 'POST', headers: agentAuth, body: JSON.stringify({ title: 't', content: 'c' }),
    });
    expect(write.status).toBe(403);

    // Sanity: the SAME account via a full JWT (owner.token) CAN post — proves the
    // 403 above is the key's OWN narrower scope, not a topic/account-wide block.
    const ownerWrite = await fetch(`${BASE}/api/topics/${topicId}/posts`, {
      method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ title: 'owner post', content: 'c' }),
    });
    expect(ownerWrite.status).toBe(201);

    // Revoke — takes effect immediately.
    const revoke = await fetch(`${BASE}/api/profile/api-keys/${created.key.id}`, { method: 'DELETE', headers: bearer(owner.token) });
    expect(revoke.status).toBe(200);

    // Same login remains valid; the revoked permission key now refuses the operation (403).
    const readAfterRevoke = await fetch(`${BASE}/api/topics/${topicId}/chat`, { headers: agentAuth });
    expect(readAfterRevoke.status).toBe(403);

    // Double-revoke is idempotent-safe: second DELETE finds nothing to flip.
    const revokeAgain = await fetch(`${BASE}/api/profile/api-keys/${created.key.id}`, { method: 'DELETE', headers: bearer(owner.token) });
    expect(revokeAgain.status).toBe(404);
  });

  it('a key with an EMPTY cmd array grants nothing — every capability 403s', async () => {
    const created = await createKey(owner.token, [], 'none', 'empty-scope-key');
    const agentAuth = bearer(created.rawKey);
    // Gate runs before any membership/business logic, so this 403s even
    // against owner's own topic (already a member) — the empty allowlist
    // alone is decisive.
    const join = await fetch(`${BASE}/api/topics/${topicId}/join`, { method: 'POST', headers: agentAuth });
    expect(join.status).toBe(403);
  });

  it('chat/send: scoped key can send only with chat/send in its cmd (contract, uses base64 sealed body)', async () => {
    const created = await createKey(owner.token, ['/openstoa/chat/send'], 'none', 'sender-key');
    const agentAuth = bearer(created.rawKey);
    // topicId: owner is already a member (via topic creation) — isolates the
    // chat/send capability check from join mechanics.
    const send = await fetch(`${BASE}/api/topics/${topicId}/chat`, {
      method: 'POST', headers: agentAuth, body: JSON.stringify({ ciphertext: b64('sealed'), epoch: 0 }),
    });
    expect(send.status).toBe(201);
  });
});
