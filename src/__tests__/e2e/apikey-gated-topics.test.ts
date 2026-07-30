/**
 * API-key-gated agent access — END-TO-END against a REAL running container over
 * HTTP (no mocks, no weakened assertions).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Agent auth used to run through a ZK proof-of-identity login (Google OIDC
 * device flow → `POST /api/auth/verify/ai`). That path is dead for now — the
 * prover is intentionally offline and its Google OAuth client was deleted — so
 * `proof-gated-topics.test.ts` is skipped with that reason. The credential an
 * agent actually uses today is a durable, revocable API key
 * (`Authorization: Bearer osk_...`, `src/lib/apiKeys.ts`) whose OWN `cmd`
 * allowlist gates every request (`requireAiCapability`,
 * `src/lib/aiPermissions.ts`). This file is that replacement coverage.
 *
 * Companion files, and what is deliberately NOT re-tested here:
 *   - `api-keys.test.ts`      — CRUD happy path + the first scoped-agent scenario.
 *   - `ai-permissions.test.ts` — the retired `ai-permissions` endpoints, the
 *     fail-closed bare-isAI-JWT path, and per-cmd unlocking of four routes.
 * This file adds what neither covers: the full allow/deny sweep from ONE key,
 * scope REMOVAL via PATCH, the three chat back-fill surfaces, the create/update
 * validation boundary + hostile-input rows, the no-ownership-oracle checks, and
 * the concurrency rows.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → case mapping (case titles quoted verbatim)
 *   boundary            → 'name length boundary…', 'cmd count and type boundary…',
 *                         'historyGrant scope boundary…'
 *   hostile input       → 'hostile and multi-script names round-trip…',
 *                         'hostile cmd entries are rejected outright…',
 *                         'malformed osk_ bearer tokens are 401, never 500…'
 *   empty / whitespace  → 'name length boundary…' (empty, whitespace-only,
 *     / null / undefined     missing, null and non-string are five separate
 *                         assertions), 'cmd count and type boundary…' (undefined
 *                         vs null vs [] vs [''] vs [null])
 *   UTF-8               → 'hostile and multi-script names round-trip…' (Korean,
 *                         emoji, CJK, newline, tab)
 *   very large input    → 'name length boundary…' (cap+1 and cap*2 → 400),
 *                         'cmd count and type boundary…' (cap+1 entries → 400)
 *   authorization       → 'guest: every api-keys verb is 401…',
 *                         'a foreign keyId is indistinguishable from an unknown one…',
 *                         'FAIL-CLOSED: a key with an EMPTY cmd list can do nothing…'
 *   race / fire-and-forget → 'concurrent revoke…', 'concurrent re-scope…',
 *                         'lastUsedAt starts null and is bumped by use…'
 *   contract invocation → 'GET list advertises the server's own ALLOWED_CMDS…'
 *   result integrity    → 'list is newest-first and every issued key is distinct',
 *                         'the raw key is returned EXACTLY once…'
 *   external dependency → N/A: the API-key path touches only Postgres, which the
 *                         container under test owns. No R2 / RPC / prover.
 *
 * Three cases are `it.skip` with the gap named in the title — they assert the
 * SECURE behavior and are one word away from running once the gap is closed.
 * See the report accompanying this change.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ALLOWED_CMDS } from '@/lib/aiPermissions';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';

// Mirrors MAX_NAME_LEN / MAX_CMD_COUNT in src/lib/apiKeys.ts. Kept as literals
// on purpose: importing them would make the test agree with a changed cap
// automatically, which is exactly the regression this row exists to catch.
const NAME_MAX = 100;
const CMD_MAX = 32;

const b64 = (s: string) => Buffer.from(s).toString('base64');
const rnd = () => Math.random().toString(36).slice(2, 8);

function bearer(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

/**
 * `fetch()` with a bounded retry for pure network-layer failures — the
 * request never reached the server at all (`TypeError: fetch failed`, e.g.
 * `ECONNRESET` / `EADDRNOTAVAIL` / `ETIMEDOUT`). This suite fires ~250
 * sequential HTTPS requests at one staging origin per run (`sequence.concurrent:
 * false` in vitest.config.e2e.ts already serializes every `it`, and the only
 * in-file concurrency is three 2–3-way `Promise.all` groups that assert race
 * behavior on purpose); intermittently the local machine cannot get a fresh
 * ephemeral port or a pooled keep-alive socket resets before the retry
 * (especially when other suites are also hitting the same host concurrently),
 * and `connect`/`read` fails before any HTTP response exists.
 *
 * This does NOT retry a resolved Response — a 4xx/5xx from the server is
 * returned as-is on the first attempt, so every `expect(res.status)` in this
 * file is exactly as strong as it was: it only ever sees a real answer from
 * the server, resolved fetch() calls are never touched, and a genuinely dead
 * server still fails loudly after all attempts are exhausted.
 */
const NETWORK_RETRY_ATTEMPTS = 3;
const NETWORK_RETRY_DELAY_MS = 250;

async function resilientFetch(input: string, init?: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      if (attempt === NETWORK_RETRY_ATTEMPTS) break;
      await new Promise((r) => setTimeout(r, NETWORK_RETRY_DELAY_MS * attempt));
    }
  }
  throw lastErr;
}

async function devLogin(prefix: string): Promise<{ token: string; userId: string }> {
  const nickname = `e2e_${prefix}_${Date.now().toString(36)}_${rnd()}`;
  const res = await resilientFetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { token: data.token, userId: data.userId };
}

interface KeyMeta {
  id: string;
  name: string;
  prefix: string;
  isAI: boolean;
  cmd: string[];
  historyGrant: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Raw POST so a case can assert the status itself. */
function postKey(token: string, body: unknown): Promise<Response> {
  return resilientFetch(`${BASE}/api/profile/api-keys`, { method: 'POST', headers: bearer(token), body: JSON.stringify(body) });
}

/** Issue a key that MUST succeed; returns the raw key + metadata. */
async function createKey(
  token: string,
  cmd: string[],
  historyGrant = 'none',
  name = `k_${rnd()}`,
): Promise<{ rawKey: string; key: KeyMeta }> {
  const res = await postKey(token, { name, cmd, historyGrant });
  if (res.status !== 201) throw new Error(`create key failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function patchKey(token: string, keyId: string, body: unknown): Promise<Response> {
  return resilientFetch(`${BASE}/api/profile/api-keys/${keyId}`, { method: 'PATCH', headers: bearer(token), body: JSON.stringify(body) });
}

function revokeKey(token: string, keyId: string): Promise<Response> {
  return resilientFetch(`${BASE}/api/profile/api-keys/${keyId}`, { method: 'DELETE', headers: bearer(token) });
}

async function listKeys(token: string): Promise<{ apiKeys: KeyMeta[]; allowedCmd: string[] }> {
  const res = await resilientFetch(`${BASE}/api/profile/api-keys`, { headers: bearer(token) });
  expect(res.status).toBe(200);
  return res.json();
}

describe.sequential('API-key-gated agent access (E2E, real container)', () => {
  // The key owner. A plain human account: every capability difference observed
  // below therefore comes from the KEY's own scope, never from the account.
  let owner: { token: string; userId: string };
  // A second, unrelated account — used for the cross-user authorization rows.
  let stranger: { token: string; userId: string };

  // owner is auto-enrolled as a member here (POST /api/topics enrols the
  // creator), so membership never masks a capability check.
  let memberTopicId: string;
  // Created by `stranger`, so owner starts as a NON-member: the only fixture on
  // which `topic/join` produces a real join instead of a 409.
  let joinTargetId: string;
  // A post in memberTopicId, for the comment/write and post/delete probes.
  let postId: string;

  beforeAll(async () => {
    const health = await resilientFetch(`${BASE}/api/health`).catch(() => null);
    if (!health || !health.ok) throw new Error(`container not reachable at ${BASE} — start it first`);

    owner = await devLogin('key_owner');
    stranger = await devLogin('key_stranger');

    const cats = await resilientFetch(`${BASE}/api/categories`, { headers: bearer(owner.token) });
    const categoryId = (await cats.json()).categories[0].id;

    const mine = await resilientFetch(`${BASE}/api/topics`, {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({ title: `E2E apikey member ${Date.now()}`, description: 'member fixture', visibility: 'public', categoryId }),
    });
    expect(mine.status).toBe(201);
    memberTopicId = (await mine.json()).topic.id;

    const theirs = await resilientFetch(`${BASE}/api/topics`, {
      method: 'POST',
      headers: bearer(stranger.token),
      body: JSON.stringify({ title: `E2E apikey join target ${Date.now()}`, description: 'join fixture', visibility: 'public', categoryId }),
    });
    expect(theirs.status).toBe(201);
    joinTargetId = (await theirs.json()).topic.id;

    const post = await resilientFetch(`${BASE}/api/topics/${memberTopicId}/posts`, {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({ title: 'apikey fixture post', content: 'body' }),
    });
    expect(post.status).toBe(201);
    postId = (await post.json()).post.id;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The capability sweep: ONE key, every gated route, both directions.
  //
  // `probe` calls each isAI-gated endpoint exactly once with the given
  // credential. Each entry is chosen so that the gate-PASS status is a
  // distinct, meaningful code rather than a generic success — e.g. `leave`
  // kicks the caller itself, which the route answers with 400 "Cannot kick
  // yourself" AFTER the gate, so pass (400) and block (403) can never be
  // confused. That is what makes the negative direction below load-bearing.
  // ─────────────────────────────────────────────────────────────────────────
  type ProbeName = 'join' | 'leave' | 'postWrite' | 'postDelete' | 'commentWrite' | 'chatRead' | 'chatSend' | 'profileEdit';

  const PASS_STATUS: Record<ProbeName, number[]> = {
    join: [201],
    leave: [400], // gate passed → route's own "Cannot kick yourself"
    postWrite: [201],
    postDelete: [200],
    commentWrite: [201],
    chatRead: [200],
    chatSend: [201],
    profileEdit: [200],
  };

  const CMD_FOR: Record<ProbeName, string> = {
    join: '/openstoa/topic/join',
    leave: '/openstoa/topic/leave',
    postWrite: '/openstoa/post/write',
    postDelete: '/openstoa/post/delete',
    commentWrite: '/openstoa/comment/write',
    chatRead: '/openstoa/chat/read',
    chatSend: '/openstoa/chat/send',
    profileEdit: '/openstoa/profile/edit',
  };

  /** A post the caller may delete — minted fresh so post/delete is repeatable. */
  async function freshPostId(): Promise<string> {
    const res = await resilientFetch(`${BASE}/api/topics/${memberTopicId}/posts`, {
      method: 'POST',
      headers: bearer(owner.token),
      body: JSON.stringify({ title: `deletable ${rnd()}`, content: 'body' }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).post.id;
  }

  async function probe(name: ProbeName, credential: string): Promise<number> {
    const h = bearer(credential);
    switch (name) {
      case 'join':
        return (await resilientFetch(`${BASE}/api/topics/${joinTargetId}/join`, { method: 'POST', headers: h, body: '{}' })).status;
      case 'leave':
        return (await resilientFetch(`${BASE}/api/topics/${memberTopicId}/members`, { method: 'DELETE', headers: h, body: JSON.stringify({ userId: owner.userId }) })).status;
      case 'postWrite':
        return (await resilientFetch(`${BASE}/api/topics/${memberTopicId}/posts`, { method: 'POST', headers: h, body: JSON.stringify({ title: `p_${rnd()}`, content: 'c' }) })).status;
      case 'postDelete':
        return (await resilientFetch(`${BASE}/api/posts/${await freshPostId()}`, { method: 'DELETE', headers: h })).status;
      case 'commentWrite':
        return (await resilientFetch(`${BASE}/api/posts/${postId}/comments`, { method: 'POST', headers: h, body: JSON.stringify({ content: `c_${rnd()}` }) })).status;
      case 'chatRead':
        return (await resilientFetch(`${BASE}/api/topics/${memberTopicId}/chat`, { headers: h })).status;
      case 'chatSend':
        return (await resilientFetch(`${BASE}/api/topics/${memberTopicId}/chat`, { method: 'POST', headers: h, body: JSON.stringify({ ciphertext: b64(`sealed ${rnd()}`), epoch: 0 }) })).status;
      case 'profileEdit':
        return (await resilientFetch(`${BASE}/api/profile/nickname`, { method: 'PUT', headers: h, body: JSON.stringify({ nickname: `nk_${rnd()}` }) })).status;
    }
  }

  const ALL_PROBES = Object.keys(CMD_FOR) as ProbeName[];

  it('a key scoped to exactly one cmd can do THAT operation and is 403 on every other gated one', async () => {
    // chat/read is the granted one. Every other gated route must answer 403
    // with the capability error — not 401 (the credential is valid), not a
    // route-level error (the gate runs first).
    const { rawKey } = await createKey(owner.token, ['/openstoa/chat/read']);

    expect(await probe('chatRead', rawKey)).toBe(200);

    for (const name of ALL_PROBES.filter((n) => n !== 'chatRead')) {
      const status = await probe(name, rawKey);
      expect(status, `${name} must be 403 for a chat/read-only key`).toBe(403);
    }

    // The 403s name the missing capability — a generic 403 from some other
    // rule (membership, ownership) would not, and would make this case pass
    // for the wrong reason.
    const denied = await resilientFetch(`${BASE}/api/topics/${memberTopicId}/posts`, {
      method: 'POST', headers: bearer(rawKey), body: JSON.stringify({ title: 't', content: 'c' }),
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toContain('/openstoa/post/write');
  });

  it('the mirror: a key holding every OTHER cmd passes all those routes and is 403 only on the one it lacks', async () => {
    // Proves each 403 above was the ABSENT cmd rather than something else about
    // the account, the topic, or the request shape.
    const held = ALL_PROBES.filter((n) => n !== 'chatRead').map((n) => CMD_FOR[n]);
    const { rawKey } = await createKey(owner.token, held);

    for (const name of ALL_PROBES.filter((n) => n !== 'chatRead')) {
      const status = await probe(name, rawKey);
      expect(PASS_STATUS[name], `${name} must pass the gate for a key holding ${CMD_FOR[name]}`).toContain(status);
    }
    expect(await probe('chatRead', rawKey)).toBe(403);
  });

  it('FAIL-CLOSED: a key with an EMPTY cmd list can do nothing — every gated route 403s', async () => {
    const { rawKey } = await createKey(owner.token, []);
    for (const name of ALL_PROBES) {
      const status = await probe(name, rawKey);
      expect(status, `${name} must be 403 for an empty-cmd key`).toBe(403);
    }
    // …while an UNGATED read still works: the key is a valid credential, it
    // just carries no abilities. This separates "fail-closed" from "broken".
    const read = await resilientFetch(`${BASE}/api/posts/${postId}`, { headers: bearer(rawKey) });
    expect(read.status).toBe(200);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH — re-scope IN PLACE, both directions, same raw key
  // ─────────────────────────────────────────────────────────────────────────

  it('PATCH re-scopes IN PLACE: the SAME raw key GAINS a capability on its very next request', async () => {
    const { rawKey, key } = await createKey(owner.token, []);
    expect(await probe('chatRead', rawKey)).toBe(403);

    const res = await patchKey(owner.token, key.id, { cmd: ['/openstoa/chat/read'], historyGrant: 'full' });
    expect(res.status).toBe(200);
    const updated = (await res.json()).key as KeyMeta;
    expect(updated.cmd).toEqual(['/openstoa/chat/read']);
    expect(updated.historyGrant).toBe('full');

    // No re-issue, no re-login — the same secret, immediately wider.
    expect(await probe('chatRead', rawKey)).toBe(200);
  });

  it('PATCH re-scopes IN PLACE: the SAME raw key LOSES a capability on its very next request', async () => {
    // The direction that matters operationally — narrowing a key that is
    // already in an agent's hands, without revoking it.
    const { rawKey, key } = await createKey(owner.token, ['/openstoa/chat/read', '/openstoa/chat/send']);
    expect(await probe('chatRead', rawKey)).toBe(200);
    expect(await probe('chatSend', rawKey)).toBe(201);

    const res = await patchKey(owner.token, key.id, { cmd: ['/openstoa/chat/read'], historyGrant: 'none' });
    expect(res.status).toBe(200);
    expect(((await res.json()).key as KeyMeta).cmd).toEqual(['/openstoa/chat/read']);

    expect(await probe('chatSend', rawKey)).toBe(403); // taken away
    expect(await probe('chatRead', rawKey)).toBe(200); // kept

    // Narrowing all the way to nothing also lands immediately.
    expect((await patchKey(owner.token, key.id, { cmd: [], historyGrant: 'none' })).status).toBe(200);
    expect(await probe('chatRead', rawKey)).toBe(403);
  });

  it('PATCH edits the scope ONLY — never the secret, the id, the prefix, the name or isAI', async () => {
    const name = `stable_${rnd()}`;
    const { rawKey, key } = await createKey(owner.token, ['/openstoa/chat/read'], 'none', name);

    const res = await patchKey(owner.token, key.id, { cmd: ['/openstoa/chat/send'], historyGrant: '7d' });
    expect(res.status).toBe(200);
    const updated = (await res.json()).key as KeyMeta;

    expect(updated.id).toBe(key.id);
    expect(updated.prefix).toBe(key.prefix);
    expect(updated.name).toBe(name);
    expect(updated.isAI).toBe(key.isAI);
    expect(updated.createdAt).toBe(key.createdAt);
    // The response of an edit must not re-expose the secret either.
    expect(JSON.stringify(updated)).not.toContain(rawKey);
    expect(JSON.stringify(updated)).not.toMatch(/keyHash/i);

    // The secret still authenticates — a re-scope is not a rotation.
    expect(await probe('chatSend', rawKey)).toBe(201);
  });

  it('PATCH validation: unknown cmd, non-array cmd, missing/garbage historyGrant, empty body, non-uuid id', async () => {
    const { key } = await createKey(owner.token, []);

    expect((await patchKey(owner.token, key.id, { cmd: ['/root/delete'], historyGrant: 'none' })).status).toBe(400);
    expect((await patchKey(owner.token, key.id, { cmd: '/openstoa/chat/read', historyGrant: 'none' })).status).toBe(400);
    expect((await patchKey(owner.token, key.id, { cmd: [] })).status).toBe(400); // historyGrant missing
    expect((await patchKey(owner.token, key.id, { cmd: [], historyGrant: 'whenever' })).status).toBe(400);
    expect((await patchKey(owner.token, key.id, {})).status).toBe(400);
    expect((await patchKey(owner.token, 'not-a-uuid', { cmd: [], historyGrant: 'none' })).status).toBe(400);

    // A rejected PATCH leaves the scope untouched — validation runs before the
    // write (`validateUpdateApiKeyInput` throws ahead of the db call).
    const after = (await listKeys(owner.token)).apiKeys.find((k) => k.id === key.id);
    expect(after?.cmd).toEqual([]);
    expect(after?.historyGrant).toBe('none');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Revocation
  // ─────────────────────────────────────────────────────────────────────────

  it('a revoked key is 401 IMMEDIATELY — not 403, and not merely scope-less', async () => {
    const { rawKey, key } = await createKey(owner.token, ['/openstoa/chat/read']);
    expect(await probe('chatRead', rawKey)).toBe(200);

    expect((await revokeKey(owner.token, key.id)).status).toBe(200);

    // 401, not 403: the credential itself is gone, so the request never even
    // reaches the capability gate.
    expect(await probe('chatRead', rawKey)).toBe(401);
    // …and it cannot be used to reach any other authenticated surface either.
    expect((await resilientFetch(`${BASE}/api/profile/api-keys`, { headers: bearer(rawKey) })).status).toBe(401);
    expect((await postKey(rawKey, { name: 'after-revoke', cmd: [], historyGrant: 'none' })).status).toBe(401);
  });

  it('a revoked key cannot be resurrected by PATCH, and stays listed as revoked', async () => {
    const { rawKey, key } = await createKey(owner.token, []);
    expect((await revokeKey(owner.token, key.id)).status).toBe(200);

    // updateApiKey's WHERE requires revokedAt IS NULL — a revoked key is not
    // re-scopable, so "revoke" cannot be undone into a working credential.
    expect((await patchKey(owner.token, key.id, { cmd: ['/openstoa/chat/read'], historyGrant: 'full' })).status).toBe(404);
    expect(await probe('chatRead', rawKey)).toBe(401);

    // The row survives for auditability, with revokedAt set.
    const row = (await listKeys(owner.token)).apiKeys.find((k) => k.id === key.id);
    expect(row).toBeDefined();
    expect(row!.revokedAt).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Chat back-fill
  // ─────────────────────────────────────────────────────────────────────────

  it('chat back-fill: all three history surfaces are gated by chat/read, not just the live feed', async () => {
    // A member without chat/read must not be able to reach the past through
    // ANY of the three doors — live history, the TAK archive, or the TAK key
    // bundles that would let it decrypt that archive.
    const paths = [
      `/api/topics/${memberTopicId}/chat`,
      `/api/topics/${memberTopicId}/archive`,
      `/api/topics/${memberTopicId}/tak/bundles?deviceId=e2e-${rnd()}`,
    ];

    const { rawKey: noRead } = await createKey(owner.token, [], 'full');
    for (const p of paths) {
      const res = await resilientFetch(`${BASE}${p}`, { headers: bearer(noRead) });
      expect(res.status, `${p} must be 403 without chat/read`).toBe(403);
      expect((await res.json()).error).toContain('/openstoa/chat/read');
    }

    const { rawKey: withRead } = await createKey(owner.token, ['/openstoa/chat/read'], 'none');
    for (const p of paths) {
      expect((await resilientFetch(`${BASE}${p}`, { headers: bearer(withRead) })).status, `${p} must be 200 with chat/read`).toBe(200);
    }

    // Same gate on the DM back-fill surfaces.
    for (const p of ['/api/dm', '/api/dm/candidates']) {
      expect((await resilientFetch(`${BASE}${p}`, { headers: bearer(noRead) })).status).toBe(403);
      expect((await resilientFetch(`${BASE}${p}`, { headers: bearer(withRead) })).status).toBe(200);
    }
  });

  it('historyGrant is stored, listed and re-editable — the scope travels with the key', async () => {
    const { key } = await createKey(owner.token, ['/openstoa/chat/read'], 'since_epoch:3');
    expect(key.historyGrant).toBe('since_epoch:3');
    expect((await listKeys(owner.token)).apiKeys.find((k) => k.id === key.id)?.historyGrant).toBe('since_epoch:3');

    const res = await patchKey(owner.token, key.id, { cmd: ['/openstoa/chat/read'], historyGrant: '7d' });
    expect(res.status).toBe(200);
    expect(((await res.json()).key as KeyMeta).historyGrant).toBe('7d');
    expect((await listKeys(owner.token)).apiKeys.find((k) => k.id === key.id)?.historyGrant).toBe('7d');
  });

  it.skip("SKIPPED [KNOWN GAP: historyGrant is validated and stored but never ENFORCED — no route reads session.apiKeyHistoryGrant; back-fill is gated by chat/read alone]", async () => {
    // Preserved so the intended contract is written down and one word away from
    // running. `getApiKeySession` (src/lib/session.ts) puts the key's grant on
    // the session as `apiKeyHistoryGrant`, but nothing consumes it: grep the
    // repo and the only hits are session.ts itself and a unit test. A key
    // issued with historyGrant 'none' can today read the ENTIRE history of any
    // topic it is a member of, as long as it holds chat/read.
    const { rawKey } = await createKey(owner.token, ['/openstoa/chat/read'], 'none');
    const res = await resilientFetch(`${BASE}/api/topics/${memberTopicId}/chat`, { headers: bearer(rawKey) });
    expect(res.status).toBe(403); // or 200 with an empty/limited window — the design decision is open
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Secret handling / result integrity
  // ─────────────────────────────────────────────────────────────────────────

  it('the raw key is returned EXACTLY once, at creation, and by no other response', async () => {
    const { rawKey, key } = await createKey(owner.token, ['/openstoa/chat/read'], 'none', `once_${rnd()}`);
    expect(rawKey.startsWith('osk_')).toBe(true);

    // Not in the list…
    const list = await listKeys(owner.token);
    expect(JSON.stringify(list)).not.toContain(rawKey);
    expect(JSON.stringify(list)).not.toMatch(/keyHash/i);
    const row = list.apiKeys.find((k) => k.id === key.id);
    expect(row).toBeDefined();

    // …not in an edit response, not in a revoke response.
    const patched = await patchKey(owner.token, key.id, { cmd: [], historyGrant: 'none' });
    expect(await patched.clone().text()).not.toContain(rawKey);
    const revoked = await revokeKey(owner.token, key.id);
    expect(await revoked.clone().text()).not.toContain(rawKey);

    // The displayed prefix identifies the key without approaching the secret:
    // 'osk_' + 8 hex chars out of a 48-char body.
    expect(row!.prefix).toBe(rawKey.slice(0, 12));
    expect(row!.prefix.length).toBe(12);
    expect(rawKey.length).toBeGreaterThan(row!.prefix.length + 32);
  });

  it('list is newest-first and every issued key is distinct', async () => {
    const made = await Promise.all([createKey(owner.token, []), createKey(owner.token, []), createKey(owner.token, [])]);
    expect(new Set(made.map((m) => m.rawKey)).size).toBe(3);
    expect(new Set(made.map((m) => m.key.prefix)).size).toBe(3);

    const { apiKeys } = await listKeys(owner.token);
    const times = apiKeys.map((k) => new Date(k.createdAt ?? 0).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1], 'createdAt must be monotonically non-increasing').toBeGreaterThanOrEqual(times[i]);
    }
    for (const m of made) expect(apiKeys.some((k) => k.id === m.key.id)).toBe(true);
  });

  it('lastUsedAt starts null and is bumped by use — a best-effort write that never blocks the request', async () => {
    const { rawKey, key } = await createKey(owner.token, ['/openstoa/chat/read']);
    expect(key.lastUsedAt).toBeNull();

    expect(await probe('chatRead', rawKey)).toBe(200);

    // `touchApiKeyLastUsed` is fired and forgotten inside getApiKeySession, so
    // it may land after the response — poll briefly rather than racing it.
    let seen: string | null = null;
    for (let i = 0; i < 10 && !seen; i++) {
      seen = (await listKeys(owner.token)).apiKeys.find((k) => k.id === key.id)?.lastUsedAt ?? null;
      if (!seen) await new Promise((r) => setTimeout(r, 300));
    }
    expect(seen, 'lastUsedAt should be set shortly after the key is used').toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Boundary rows
  // ─────────────────────────────────────────────────────────────────────────

  it('name length boundary: empty, whitespace-only, missing, null and over-cap are each rejected; the cap itself is accepted', async () => {
    expect((await postKey(owner.token, { name: 'a'.repeat(NAME_MAX), cmd: [], historyGrant: 'none' })).status).toBe(201);
    expect((await postKey(owner.token, { name: 'a'.repeat(NAME_MAX + 1), cmd: [], historyGrant: 'none' })).status).toBe(400);
    expect((await postKey(owner.token, { name: 'a'.repeat(NAME_MAX * 2), cmd: [], historyGrant: 'none' })).status).toBe(400);
    expect((await postKey(owner.token, { name: '', cmd: [], historyGrant: 'none' })).status).toBe(400);
    expect((await postKey(owner.token, { name: '   ', cmd: [], historyGrant: 'none' })).status).toBe(400);
    expect((await postKey(owner.token, { name: '\t\n ', cmd: [], historyGrant: 'none' })).status).toBe(400);
    expect((await postKey(owner.token, { cmd: [], historyGrant: 'none' })).status).toBe(400); // missing
    expect((await postKey(owner.token, { name: null, cmd: [], historyGrant: 'none' })).status).toBe(400);
    expect((await postKey(owner.token, { name: 123, cmd: [], historyGrant: 'none' })).status).toBe(400);

    // A surviving name is trimmed, not silently padded or truncated.
    const { key } = await createKey(owner.token, [], 'none', `  padded_${rnd()}  `);
    expect(key.name).toBe(key.name.trim());
    expect(key.name.startsWith('padded_')).toBe(true);
  });

  it('cmd count and type boundary: 0 and the cap pass, cap+1 fails, non-arrays and non-string entries fail', async () => {
    expect((await postKey(owner.token, { name: `c0_${rnd()}`, cmd: [], historyGrant: 'none' })).status).toBe(201);

    // Duplicates count BEFORE de-duplication, so the cap is testable without
    // needing CMD_MAX distinct commands to exist.
    expect((await postKey(owner.token, { name: `cmax_${rnd()}`, cmd: Array(CMD_MAX).fill('/openstoa/chat/read'), historyGrant: 'none' })).status).toBe(201);
    expect((await postKey(owner.token, { name: `cover_${rnd()}`, cmd: Array(CMD_MAX + 1).fill('/openstoa/chat/read'), historyGrant: 'none' })).status).toBe(400);

    // …and de-duplication really happens on the stored scope.
    const { key } = await createKey(owner.token, ['/openstoa/chat/read', '/openstoa/chat/read', '/openstoa/chat/send']);
    expect(key.cmd).toEqual(['/openstoa/chat/read', '/openstoa/chat/send']);

    for (const bad of [undefined, null, '/openstoa/chat/read', {}, 42, [123], [''], [null], [['/openstoa/chat/read']]]) {
      const res = await postKey(owner.token, { name: `bad_${rnd()}`, cmd: bad, historyGrant: 'none' });
      expect(res.status, `cmd=${JSON.stringify(bad)} must be rejected`).toBe(400);
    }
  });

  it('historyGrant scope boundary: every documented shape at its edges, valid and invalid', async () => {
    const valid = ['none', 'full', 'since_epoch:0', 'since_epoch:1', 'since_epoch:999999999999999', '1d', '365d', '999999999d', '1', '500'];
    for (const historyGrant of valid) {
      const res = await postKey(owner.token, { name: `hg_${rnd()}`, cmd: [], historyGrant });
      expect(res.status, `historyGrant=${historyGrant} must be accepted`).toBe(201);
      expect(((await res.json()).key as KeyMeta).historyGrant).toBe(historyGrant);
    }

    const invalid = [
      '', ' ', 'none ', ' none', 'NONE', 'Full', 'forever', 'whenever',
      '0d', '-1d', '0', '-1', '1.5d', 'since_epoch:', 'since_epoch:-1', 'since_epoch:1.5',
      'since_epoch:1e3', 'since_epoch:9999999999999999', 'f'.repeat(65), 'full;DROP TABLE api_keys',
      "none' OR '1'='1", 'full\nnone', null, undefined, 7, true, ['full'], { scope: 'full' },
    ];
    for (const historyGrant of invalid) {
      const res = await postKey(owner.token, { name: `hgx_${rnd()}`, cmd: [], historyGrant });
      expect(res.status, `historyGrant=${JSON.stringify(historyGrant)} must be rejected`).toBe(400);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Hostile input
  // ─────────────────────────────────────────────────────────────────────────

  it('hostile and multi-script names round-trip byte-identically — stored as data, never interpreted', async () => {
    const names = [
      "100% _off\\_ literal",                 // ilike wildcards + escape char
      "x'; DROP TABLE api_keys; --",          // SQL shape
      '<script>alert(1)</script>',            // HTML/script
      '{"$ne":null}',                         // NoSQL-ish / JSON shape
      '한글 이름 🔑 emoji 混在 mixed',          // UTF-8: Korean, emoji, CJK
      'line1\nline2\ttabbed',                 // newline + tab
      '../../etc/passwd',                     // traversal shape
      '${jndi:ldap://x/y}',                   // template injection shape
    ];

    for (const name of names) {
      const res = await postKey(owner.token, { name, cmd: [], historyGrant: 'none' });
      expect(res.status, `name=${JSON.stringify(name)} should be accepted verbatim`).toBe(201);
      const key = (await res.json()).key as KeyMeta;
      expect(key.name).toBe(name.trim());

      const row = (await listKeys(owner.token)).apiKeys.find((k) => k.id === key.id);
      expect(row?.name, 'the stored name must survive the round trip unchanged').toBe(name.trim());
    }
  });

  it('hostile cmd entries are rejected outright — an unknown ability is never silently granted', async () => {
    const bad = [
      '/root/delete',
      '/openstoa/chat/read; /openstoa/post/write',
      '/openstoa/chat/*',
      '%',
      '/openstoa/CHAT/READ',                  // case must not be normalized open
      ' /openstoa/chat/read',                 // leading space
      '/openstoa/chat/read ',                 // trailing space
      "/openstoa/chat/read' OR 1=1--",
      '../openstoa/chat/read',
    ];
    for (const c of bad) {
      const res = await postKey(owner.token, { name: `hx_${rnd()}`, cmd: [c], historyGrant: 'none' });
      expect(res.status, `cmd=${JSON.stringify(c)} must be rejected`).toBe(400);
    }

    // One bad entry poisons the whole request — no partial grant.
    const mixed = await postKey(owner.token, { name: `mix_${rnd()}`, cmd: ['/openstoa/chat/read', '/root/delete'], historyGrant: 'none' });
    expect(mixed.status).toBe(400);
  });

  it('malformed osk_ bearer tokens are 401, never 500 and never a silent pass', async () => {
    const { rawKey } = await createKey(owner.token, ['/openstoa/chat/read']);
    const tampered = rawKey.slice(0, -1) + (rawKey.endsWith('a') ? 'b' : 'a');

    const tokens = [
      'osk_',
      'osk_' + 'z'.repeat(48),
      'osk_' + '0'.repeat(48),
      'osk_%20',
      'osk_../../etc/passwd',
      "osk_' OR '1'='1",
      tampered,                      // one character off a live key
      rawKey.toUpperCase(),          // hash input is case-sensitive
      rawKey + 'a',                  // extended
      rawKey.slice(0, -1),           // truncated
    ];
    for (const token of tokens) {
      const res = await resilientFetch(`${BASE}/api/topics/${memberTopicId}/chat`, { headers: bearer(token) });
      expect(res.status, `token=${JSON.stringify(token.slice(0, 24))} must be 401`).toBe(401);
    }
    // Control: the untampered key still works, so the 401s above are the
    // tampering and not a broken fixture.
    expect(await probe('chatRead', rawKey)).toBe(200);
  });

  it.skip('SKIPPED [KNOWN GAP: a NUL byte in `name` reaches Postgres and surfaces as 500 with a raw driver message instead of 400 — validateCreateApiKeyInput does not reject control characters]', async () => {
    // Reproduced against the local container: POST with name "a\u0000b" answers
    // 500 {"error":"invalid byte sequence for encoding \"UTF8\": 0x00"}. The
    // fix belongs in validateCreateApiKeyInput (src/lib/apiKeys.ts), which is
    // where every other name rule lives; this case asserts the intended result.
    const res = await postKey(owner.token, { name: 'a\u0000b', cmd: [], historyGrant: 'none' });
    expect(res.status).toBe(400);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Authorization paths
  // ─────────────────────────────────────────────────────────────────────────

  it('guest: every api-keys verb is 401 before any validation runs', async () => {
    const anyId = '00000000-0000-0000-0000-000000000000';
    const h = { 'Content-Type': 'application/json' };
    expect((await resilientFetch(`${BASE}/api/profile/api-keys`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'g', cmd: [], historyGrant: 'none' }) })).status).toBe(401);
    expect((await resilientFetch(`${BASE}/api/profile/api-keys`)).status).toBe(401);
    expect((await resilientFetch(`${BASE}/api/profile/api-keys/${anyId}`, { method: 'PATCH', headers: h, body: '{}' })).status).toBe(401);
    expect((await resilientFetch(`${BASE}/api/profile/api-keys/${anyId}`, { method: 'DELETE' })).status).toBe(401);
    // 401 wins over 400: an unauthenticated caller must not be able to probe
    // the validator (which id shapes exist, which cmds are known).
    expect((await resilientFetch(`${BASE}/api/profile/api-keys/not-a-uuid`, { method: 'DELETE' })).status).toBe(401);
  });

  it("a foreign keyId is indistinguishable from an unknown one — no ownership oracle, and the victim's key keeps working", async () => {
    const { rawKey, key } = await createKey(owner.token, ['/openstoa/chat/read'], 'none', `victim_${rnd()}`);
    const unknownId = '00000000-0000-0000-0000-00000000dead';

    // Same status AND same body for "exists but not yours" vs "does not exist".
    const foreignPatch = await patchKey(stranger.token, key.id, { cmd: [], historyGrant: 'none' });
    const unknownPatch = await patchKey(stranger.token, unknownId, { cmd: [], historyGrant: 'none' });
    expect(foreignPatch.status).toBe(404);
    expect(unknownPatch.status).toBe(404);
    expect(await foreignPatch.text()).toBe(await unknownPatch.text());

    const foreignDelete = await revokeKey(stranger.token, key.id);
    const unknownDelete = await revokeKey(stranger.token, unknownId);
    expect(foreignDelete.status).toBe(404);
    expect(unknownDelete.status).toBe(404);
    expect(await foreignDelete.text()).toBe(await unknownDelete.text());

    // The stranger also cannot see it in their own list…
    expect((await listKeys(stranger.token)).apiKeys.some((k) => k.id === key.id)).toBe(false);
    // …and none of the above touched it: still active, still scoped.
    expect(await probe('chatRead', rawKey)).toBe(200);
    expect((await listKeys(owner.token)).apiKeys.find((k) => k.id === key.id)?.revokedAt).toBeNull();
  });

  it.skip('SKIPPED [KNOWN GAP: the api-keys endpoints themselves are not capability-gated, so an empty-cmd key can mint a wider key and read the owner\'s key list — `cmd` is not a containment boundary for a leaked key]', async () => {
    // Reproduced against the local container: an `osk_` key with cmd: [] gets
    // 201 from POST /api/profile/api-keys with any scope it likes, and 200 from
    // GET. Neither route calls requireAiCapability, so key management is
    // reachable by any credential that authenticates — including the narrow
    // agent key whose whole purpose is to be narrow. Closing this needs a
    // decision (deny isAI sessions outright, or add a /openstoa/key/manage
    // ability); this case asserts the deny-outright reading.
    const { rawKey } = await createKey(owner.token, []);
    expect((await postKey(rawKey, { name: `escalate_${rnd()}`, cmd: ['/openstoa/post/write'], historyGrant: 'full' })).status).toBe(403);
    expect((await resilientFetch(`${BASE}/api/profile/api-keys`, { headers: bearer(rawKey) })).status).toBe(403);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Contract invocation + concurrency
  // ─────────────────────────────────────────────────────────────────────────

  it("GET list advertises the server's own ALLOWED_CMDS, and every advertised cmd is actually accepted", async () => {
    // Contract row: if ALLOWED_CMDS grows but the validator or the response
    // stops agreeing with it, an agent reading `allowedCmd` would build a
    // request the server then rejects. This catches that drift.
    const { allowedCmd } = await listKeys(owner.token);
    expect(allowedCmd).toEqual([...ALLOWED_CMDS]);

    for (const cmd of allowedCmd) {
      const res = await postKey(owner.token, { name: `adv_${rnd()}`, cmd: [cmd], historyGrant: 'none' });
      expect(res.status, `advertised cmd ${cmd} must be accepted`).toBe(201);
      expect(((await res.json()).key as KeyMeta).cmd).toEqual([cmd]);
    }

    // The whole advertised set at once is also within the count cap.
    const all = await postKey(owner.token, { name: `advall_${rnd()}`, cmd: allowedCmd, historyGrant: 'full' });
    expect(all.status).toBe(201);
  });

  it('concurrent revoke: exactly one caller flips the key, the other gets 404 — never two successes', async () => {
    const { rawKey, key } = await createKey(owner.token, ['/openstoa/chat/read']);
    const results = await Promise.all([revokeKey(owner.token, key.id), revokeKey(owner.token, key.id)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 404]);
    expect(await probe('chatRead', rawKey)).toBe(401);
  });

  it('concurrent re-scope: both edits succeed, the key survives with one of the two scopes, never a mix', async () => {
    const { rawKey, key } = await createKey(owner.token, []);
    const results = await Promise.all([
      patchKey(owner.token, key.id, { cmd: ['/openstoa/chat/read'], historyGrant: 'full' }),
      patchKey(owner.token, key.id, { cmd: ['/openstoa/chat/send'], historyGrant: 'none' }),
    ]);
    for (const r of results) expect(r.status).toBe(200);

    const row = (await listKeys(owner.token)).apiKeys.find((k) => k.id === key.id);
    // Last writer wins wholesale — cmd and historyGrant come from the SAME
    // edit, never half of each.
    const outcomes = [
      { cmd: ['/openstoa/chat/read'], historyGrant: 'full' },
      { cmd: ['/openstoa/chat/send'], historyGrant: 'none' },
    ];
    expect(outcomes).toContainEqual({ cmd: row!.cmd, historyGrant: row!.historyGrant });

    // …and the surviving scope is the one actually enforced.
    const expected = row!.cmd[0] === '/openstoa/chat/read' ? 200 : 403;
    expect(await probe('chatRead', rawKey)).toBe(expected);
  });

  it('revoking one key does not disturb the account\'s other keys', async () => {
    const keep = await createKey(owner.token, ['/openstoa/chat/read'], 'none', `keep_${rnd()}`);
    const drop = await createKey(owner.token, ['/openstoa/chat/read'], 'none', `drop_${rnd()}`);

    expect((await revokeKey(owner.token, drop.key.id)).status).toBe(200);
    expect(await probe('chatRead', drop.rawKey)).toBe(401);
    expect(await probe('chatRead', keep.rawKey)).toBe(200);
  });
});
