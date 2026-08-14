import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * API key HTTP-contract tests (design §7 follow-up) — route wiring + the
 * `requireAiCapability` apiKeyCmd short-circuit. Mocks `@/lib/session` and
 * `@/lib/apiKeys` (db + hashing tested for real in apiKeys.test.ts) so this
 * file isolates the HTTP layer, mirroring ai-permissions.test.ts's structure.
 * Kept in its own file so its `@/lib/apiKeys` module mock never collides with
 * apiKeys.test.ts's `@/lib/db` mock.
 */
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  createApiKey: vi.fn(),
  listApiKeys: vi.fn(),
  revokeApiKey: vi.fn(),
  updateApiKey: vi.fn(),
  incr: vi.fn().mockResolvedValue(1),
  expire: vi.fn(),
  publish: vi.fn().mockResolvedValue(1),
  topicMembersFindFirst: vi.fn(),
  usersFindFirst: vi.fn(),
  insertReturning: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/redis', () => ({
  getRedis: () => ({ incr: mocks.incr, expire: mocks.expire, publish: mocks.publish }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/push', () => ({
  dispatchDummyForMessage: vi.fn().mockResolvedValue(undefined),
  dispatchCiphertextForMessage: vi.fn().mockResolvedValue(undefined),
  getPushProvider: () => null,
  getPushMode: () => 'content-free',
}));
vi.mock('@/lib/db', () => ({
  db: {
    query: {
      topicMembers: { findFirst: mocks.topicMembersFindFirst },
      users: { findFirst: mocks.usersFindFirst },
    },
    insert: () => ({ values: () => ({ returning: mocks.insertReturning }) }),
  },
}));
vi.mock('@/lib/apiKeys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/apiKeys')>();
  return {
    ...actual,
    createApiKey: mocks.createApiKey,
    listApiKeys: mocks.listApiKeys,
    revokeApiKey: mocks.revokeApiKey,
    updateApiKey: mocks.updateApiKey,
  };
});

import { POST as keysPOST, GET as keysGET } from '@/app/api/profile/api-keys/route';
import { PATCH as keysPATCH, DELETE as keysDELETE } from '@/app/api/profile/api-keys/[keyId]/route';
import { POST as chatPOST } from '@/app/api/topics/[topicId]/chat/route';
import { ApiKeyValidationError } from '@/lib/apiKeys';

const TOPIC = '00000000-0000-0000-0000-000000000001';
const KEY_ID = '00000000-0000-0000-0000-0000000000cc';
const b64 = (s: string) => Buffer.from(s).toString('base64');
const req = (body: unknown) =>
  ({ json: async () => body, url: 'http://x/api/profile/api-keys', cookies: { get: () => undefined }, headers: { get: () => null } }) as never;
const kParams = () => Promise.resolve({ keyId: KEY_ID });
const tParams = () => Promise.resolve({ topicId: TOPIC });

const human = { userId: 'human1', nickname: 'h', isAI: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.incr.mockResolvedValue(1);
});

// A session authenticated via `Authorization: Bearer osk_...` — carries
// `apiKeyId` (set only by `getApiKeySession`, src/lib/session.ts). Key
// MANAGEMENT must be unreachable from this shape regardless of the key's own
// `cmd` — see `requireNonApiKeySession` (src/lib/apiKeys.ts).
const apiKeyEmptyCmd = { userId: 'human1', nickname: 'h', isAI: true, apiKeyId: 'k-empty', apiKeyCmd: [] };
const apiKeyFullCmd = {
  userId: 'human1',
  nickname: 'h',
  isAI: true,
  apiKeyId: 'k-full',
  apiKeyCmd: [
    '/openstoa/topic/join', '/openstoa/post/write', '/openstoa/comment/write',
    '/openstoa/chat/read', '/openstoa/chat/send', '/openstoa/profile/edit',
  ],
};

describe('POST /api/profile/api-keys (authz / contract / integrity)', () => {
  it('401 when unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await keysPOST(req({ name: 'k', cmd: [], historyGrant: 'none' }));
    expect(res.status).toBe(401);
  });
  it('403 for an API-key session with an EMPTY cmd — a leaked narrow key cannot mint at all', async () => {
    mocks.getSession.mockResolvedValue(apiKeyEmptyCmd);
    const res = await keysPOST(req({ name: 'escalate', cmd: ['/openstoa/post/write'], historyGrant: 'full' }));
    expect(res.status).toBe(403);
    // Contract invocation: the gate must short-circuit BEFORE the route ever
    // calls createApiKey — a removed gate call would let this mock resolve
    // and the assertion above would flip to 201.
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });
  it('403 for an API-key session holding a WIDE set of cmds — cmd content is irrelevant to this gate (boundary)', async () => {
    mocks.getSession.mockResolvedValue(apiKeyFullCmd);
    const res = await keysPOST(req({ name: 'escalate', cmd: ['/openstoa/post/write'], historyGrant: 'full' }));
    expect(res.status).toBe(403);
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });
  it('403 wins over 400: a malformed body is still 403, never a 400 from the validator (no probing surface for a denied credential)', async () => {
    mocks.getSession.mockResolvedValue(apiKeyEmptyCmd);
    const res = await keysPOST({ json: async () => { throw new Error('bad'); }, cookies: { get: () => undefined }, headers: { get: () => null } } as never);
    expect(res.status).toBe(403);
    expect(mocks.createApiKey).not.toHaveBeenCalled();
  });
  it('201 returns the raw key ONCE plus metadata — never the hash', async () => {
    mocks.getSession.mockResolvedValue(human);
    mocks.createApiKey.mockResolvedValue({
      row: {
        id: 'k1', userId: 'human1', name: 'laptop', keyHash: 'HASH-NEVER-SENT', prefix: 'osk_abcd1234',
        isAI: true, cmd: ['/openstoa/chat/read'], historyGrant: 'none', createdAt: new Date(), lastUsedAt: null, revokedAt: null,
      },
      rawKey: 'osk_the_full_secret_value',
    });
    const res = await keysPOST(req({ name: 'laptop', cmd: ['/openstoa/chat/read'], historyGrant: 'none' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.rawKey).toBe('osk_the_full_secret_value');
    expect(body.key.id).toBe('k1');
    expect(body.key.cmd).toEqual(['/openstoa/chat/read']);
    // SI-1: response never carries the hash or userId.
    expect(JSON.stringify(body)).not.toContain('HASH-NEVER-SENT');
    expect(body.key.keyHash).toBeUndefined();
    expect(body.key.userId).toBeUndefined();
  });
  it('400 when createApiKey rejects invalid input (unknown cmd)', async () => {
    mocks.getSession.mockResolvedValue(human);
    mocks.createApiKey.mockRejectedValue(new ApiKeyValidationError('unknown cmd: /root/x'));
    const res = await keysPOST(req({ name: 'k', cmd: ['/root/x'], historyGrant: 'none' }));
    expect(res.status).toBe(400);
  });
  it('400 on invalid JSON body', async () => {
    mocks.getSession.mockResolvedValue(human);
    const res = await keysPOST({ json: async () => { throw new Error('bad'); }, cookies: { get: () => undefined }, headers: { get: () => null } } as never);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/profile/api-keys (authz / integrity)', () => {
  it('401 when unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await keysGET(req(null));
    expect(res.status).toBe(401);
  });
  it('403 for an API-key session — a leaked narrow key cannot enumerate its owner\'s other keys', async () => {
    mocks.getSession.mockResolvedValue(apiKeyEmptyCmd);
    const res = await keysGET(req(null));
    expect(res.status).toBe(403);
    expect(mocks.listApiKeys).not.toHaveBeenCalled();
  });
  it('403 for an API-key session holding a WIDE set of cmds too (boundary: cmd content is irrelevant)', async () => {
    mocks.getSession.mockResolvedValue(apiKeyFullCmd);
    const res = await keysGET(req(null));
    expect(res.status).toBe(403);
    expect(mocks.listApiKeys).not.toHaveBeenCalled();
  });
  it('200 lists metadata only for the caller — never a hash', async () => {
    mocks.getSession.mockResolvedValue(human);
    mocks.listApiKeys.mockResolvedValue([
      { id: 'k1', userId: 'human1', name: 'laptop', keyHash: 'SHOULD-NOT-LEAK', prefix: 'osk_abcd1234', isAI: true, cmd: [], historyGrant: 'none', createdAt: new Date(), lastUsedAt: null, revokedAt: null },
    ]);
    const res = await keysGET(req(null));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiKeys).toHaveLength(1);
    expect(body.apiKeys[0].id).toBe('k1');
    expect(JSON.stringify(body)).not.toContain('SHOULD-NOT-LEAK');
    expect(Array.isArray(body.allowedCmd)).toBe(true);
  });
});

describe('DELETE /api/profile/api-keys/{keyId} (authz / boundary / race)', () => {
  it('401 when unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await keysDELETE(req(null), { params: kParams() });
    expect(res.status).toBe(401);
  });
  it('403 for an API-key session — including revoking a key it minted itself', async () => {
    mocks.getSession.mockResolvedValue(apiKeyEmptyCmd);
    const res = await keysDELETE(req(null), { params: kParams() });
    expect(res.status).toBe(403);
    expect(mocks.revokeApiKey).not.toHaveBeenCalled();
  });
  it('403 wins over 400: an invalid (non-uuid) keyId from an API-key session is still 403, not 400 — the gate never reaches keyId parsing', async () => {
    mocks.getSession.mockResolvedValue(apiKeyEmptyCmd);
    const res = await keysDELETE(req(null), { params: Promise.resolve({ keyId: 'not-a-uuid' }) });
    expect(res.status).toBe(403);
    expect(mocks.revokeApiKey).not.toHaveBeenCalled();
  });
  it('400 when keyId is not a uuid', async () => {
    mocks.getSession.mockResolvedValue(human);
    const res = await keysDELETE(req(null), { params: Promise.resolve({ keyId: 'not-a-uuid' }) });
    expect(res.status).toBe(400);
    expect(mocks.revokeApiKey).not.toHaveBeenCalled();
  });
  it('404 when the key does not exist / is not owned by the caller', async () => {
    mocks.getSession.mockResolvedValue(human);
    mocks.revokeApiKey.mockResolvedValue(null);
    const res = await keysDELETE(req(null), { params: kParams() });
    expect(res.status).toBe(404);
  });
  it('200 revokes the caller\'s own key', async () => {
    mocks.getSession.mockResolvedValue(human);
    mocks.revokeApiKey.mockResolvedValue({ id: KEY_ID, userId: 'human1', revokedAt: new Date() });
    const res = await keysDELETE(req(null), { params: kParams() });
    expect(res.status).toBe(200);
    expect((await res.json()).revoked).toBe(true);
    expect(mocks.revokeApiKey).toHaveBeenCalledWith(expect.anything(), 'human1', KEY_ID);
  });
  it('404 on concurrent double-revoke (second flip is a no-op)', async () => {
    mocks.getSession.mockResolvedValue(human);
    mocks.revokeApiKey.mockResolvedValue(null);
    const res = await keysDELETE(req(null), { params: kParams() });
    expect(res.status).toBe(404);
  });
});

describe('requireAiCapability apiKeyCmd short-circuit wired on a real guarded route (contract)', () => {
  beforeEach(() => {
    mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: 'x', role: 'member' });
    mocks.usersFindFirst.mockResolvedValue({ id: 'x', nickname: 'n', profileImage: null });
    mocks.insertReturning.mockResolvedValue([
      { id: 'm1', topicId: TOPIC, userId: 'bot1', ciphertext: Buffer.from('c'), epoch: 0, takVersion: null, type: 'message', isAI: true, createdAt: new Date() },
    ]);
  });
  it('an API-key session WITH chat/send in its own cmd list sends — no profile lookup needed', async () => {
    mocks.getSession.mockResolvedValue({ userId: 'bot1', nickname: 'b', isAI: true, apiKeyId: 'k1', apiKeyCmd: ['/openstoa/chat/send'] });
    const res = await chatPOST(req({ ciphertext: b64('c'), epoch: 0 }), { params: tParams() });
    expect(res.status).toBe(201);
  });
  it('an API-key session WITHOUT chat/send in its own cmd list is 403\'d even if isAI — key is authoritative', async () => {
    mocks.getSession.mockResolvedValue({ userId: 'bot1', nickname: 'b', isAI: true, apiKeyId: 'k1', apiKeyCmd: ['/openstoa/post/write'] });
    const res = await chatPOST(req({ ciphertext: b64('c'), epoch: 0 }), { params: tParams() });
    expect(res.status).toBe(403);
  });
  it('an API-key session with an EMPTY cmd array is 403\'d on every capability (safe default)', async () => {
    mocks.getSession.mockResolvedValue({ userId: 'bot1', nickname: 'b', isAI: true, apiKeyId: 'k1', apiKeyCmd: [] });
    const res = await chatPOST(req({ ciphertext: b64('c'), epoch: 0 }), { params: tParams() });
    expect(res.status).toBe(403);
  });
  it('FAIL-CLOSED: an isAI session with NO key scope at all (bare JWT, no apiKeyCmd) is 403\'d — never an implicit allow', async () => {
    // No apiKeyId/apiKeyCmd on the session — e.g. a dev-login or verify/ai JWT
    // that never went through an API key. Must be denied, not fall back to
    // any account-wide grant (there isn't one any more).
    mocks.getSession.mockResolvedValue({ userId: 'bot1', nickname: 'b', isAI: true });
    const res = await chatPOST(req({ ciphertext: b64('c'), epoch: 0 }), { params: tParams() });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/profile/api-keys/{keyId} (edit scope — authz / boundary / hostile / integrity)', () => {
  it('401 when unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await keysPATCH(req({ cmd: [], historyGrant: 'none' }), { params: kParams() });
    expect(res.status).toBe(401);
  });
  it('403 for an API-key session — including trying to widen (or narrow) itself in place', async () => {
    mocks.getSession.mockResolvedValue(apiKeyEmptyCmd);
    const res = await keysPATCH(req({ cmd: ['/openstoa/post/write'], historyGrant: 'full' }), { params: kParams() });
    expect(res.status).toBe(403);
    expect(mocks.updateApiKey).not.toHaveBeenCalled();
  });
  it('403 wins over 400: an invalid body from an API-key session is still 403, not 400 — the gate never reaches body parsing', async () => {
    mocks.getSession.mockResolvedValue(apiKeyEmptyCmd);
    const res = await keysPATCH({ json: async () => { throw new Error('bad'); }, cookies: { get: () => undefined }, headers: { get: () => null } } as never, { params: kParams() });
    expect(res.status).toBe(403);
    expect(mocks.updateApiKey).not.toHaveBeenCalled();
  });
  it('400 when keyId is not a uuid', async () => {
    mocks.getSession.mockResolvedValue(human);
    const res = await keysPATCH(req({ cmd: [], historyGrant: 'none' }), { params: Promise.resolve({ keyId: 'not-a-uuid' }) });
    expect(res.status).toBe(400);
    expect(mocks.updateApiKey).not.toHaveBeenCalled();
  });
  it('400 on invalid JSON body', async () => {
    mocks.getSession.mockResolvedValue(human);
    const res = await keysPATCH({ json: async () => { throw new Error('bad'); }, cookies: { get: () => undefined }, headers: { get: () => null } } as never, { params: kParams() });
    expect(res.status).toBe(400);
  });
  it('400 when updateApiKey rejects invalid input (unknown cmd / bad scope)', async () => {
    mocks.getSession.mockResolvedValue(human);
    mocks.updateApiKey.mockRejectedValue(new ApiKeyValidationError('unknown cmd: /root/x'));
    const res = await keysPATCH(req({ cmd: ['/root/x'], historyGrant: 'none' }), { params: kParams() });
    expect(res.status).toBe(400);
  });
  it('404 when the key does not exist / is not owned by the caller / already revoked', async () => {
    mocks.getSession.mockResolvedValue(human);
    mocks.updateApiKey.mockResolvedValue(null);
    const res = await keysPATCH(req({ cmd: [], historyGrant: 'none' }), { params: kParams() });
    expect(res.status).toBe(404);
  });
  it('200 updates the scope and returns metadata only — never the hash', async () => {
    mocks.getSession.mockResolvedValue(human);
    mocks.updateApiKey.mockResolvedValue({
      id: KEY_ID, userId: 'human1', name: 'laptop', keyHash: 'SHOULD-NOT-LEAK', prefix: 'osk_abcd1234',
      isAI: true, cmd: ['/openstoa/post/write'], historyGrant: '7d', createdAt: new Date(), lastUsedAt: null, revokedAt: null,
    });
    const res = await keysPATCH(req({ cmd: ['/openstoa/post/write'], historyGrant: '7d' }), { params: kParams() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.key.cmd).toEqual(['/openstoa/post/write']);
    expect(body.key.historyGrant).toBe('7d');
    expect(JSON.stringify(body)).not.toContain('SHOULD-NOT-LEAK');
    // Contract: scoped by the SESSION user, never a body-supplied id.
    expect(mocks.updateApiKey).toHaveBeenCalledWith(expect.anything(), 'human1', KEY_ID, { cmd: ['/openstoa/post/write'], historyGrant: '7d' });
  });
  it('name/isAI are not accepted in the PATCH body — only cmd/historyGrant reach updateApiKey', async () => {
    mocks.getSession.mockResolvedValue(human);
    mocks.updateApiKey.mockResolvedValue({
      id: KEY_ID, userId: 'human1', name: 'laptop', keyHash: 'h', prefix: 'osk_abcd1234',
      isAI: true, cmd: [], historyGrant: 'none', createdAt: new Date(), lastUsedAt: null, revokedAt: null,
    });
    await keysPATCH(req({ name: 'renamed', isAI: false, cmd: [], historyGrant: 'none' }), { params: kParams() });
    expect(mocks.updateApiKey).toHaveBeenCalledWith(expect.anything(), 'human1', KEY_ID, { cmd: [], historyGrant: 'none' });
  });
});
