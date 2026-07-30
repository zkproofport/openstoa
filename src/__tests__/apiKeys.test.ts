import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Durable API keys (design §7 follow-up) — unit tests, layer 1+2.
 *
 *   1. Pure validation + hashing/format helpers (no db) — boundary/hostile/
 *      empty rows of the edge-case matrix.
 *   2. DB-backed CRUD (createApiKey/listApiKeys/revokeApiKey/verifyApiKey)
 *      against a mocked `@/lib/db` — authz (owner-only revoke), race (double
 *      revoke), integrity (never returns keyHash/raw key).
 *   3. `getSession()`'s API-key resolution path (real `@/lib/session` against
 *      the same mocked db) — valid/revoked/unknown key → session or null;
 *      isAI + capabilities come FROM THE KEY row.
 *
 * Route-level HTTP-contract tests (POST/GET/DELETE handlers + the
 * requireAiCapability apiKeyCmd short-circuit on a guarded route) live in
 * apiKeys-routes.test.ts, which mocks `@/lib/apiKeys` instead of `@/lib/db` —
 * kept in a separate file so the two files' module mocks never conflict.
 */

// ───────────────────────────────────────────────────────────────────────────
// Shared db mock (used by layers 2 and 3 below)
// ───────────────────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  apiKeysFindFirst: vi.fn(),
  apiKeysFindMany: vi.fn(),
  usersFindFirst: vi.fn(),
  insertReturning: vi.fn(),
  updateReturning: vi.fn(),
  updateSet: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      apiKeys: { findFirst: mocks.apiKeysFindFirst, findMany: mocks.apiKeysFindMany },
      users: { findFirst: mocks.usersFindFirst },
    },
    insert: () => ({ values: () => ({ returning: mocks.insertReturning }) }),
    update: () => ({
      set: (patch: unknown) => {
        mocks.updateSet(patch);
        return {
          where: () => {
            // Support both call shapes used in apiKeys.ts:
            //   await db.update(...).set(...).where(...)                (touchApiKeyLastUsed)
            //   await db.update(...).set(...).where(...).returning()    (revokeApiKey)
            const p = Promise.resolve(undefined) as Promise<unknown> & { returning?: () => Promise<unknown[]> };
            p.returning = () => Promise.resolve(mocks.updateReturning());
            return p;
          },
        };
      },
    }),
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  validateCreateApiKeyInput,
  validateUpdateApiKeyInput,
  hashApiKey,
  isApiKeyToken,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  updateApiKey,
  verifyApiKey,
  toApiKeyMeta,
  ApiKeyValidationError,
  API_KEY_PREFIX,
  MAX_CMD_COUNT,
  MAX_NAME_LEN,
  type ApiKeyRow,
} from '@/lib/apiKeys';
import { db } from '@/lib/db';

beforeEach(() => vi.clearAllMocks());

// ───────────────────────────────────────────────────────────────────────────
// 1. Pure validation + format (no db)
// ───────────────────────────────────────────────────────────────────────────
describe('validateCreateApiKeyInput — name (boundary / empty / hostile)', () => {
  it('rejects missing / empty / whitespace name', () => {
    expect(() => validateCreateApiKeyInput({ name: undefined, cmd: [], historyGrant: 'none' })).toThrow(/name is required/);
    expect(() => validateCreateApiKeyInput({ name: '', cmd: [], historyGrant: 'none' })).toThrow(/name is required/);
    expect(() => validateCreateApiKeyInput({ name: '   ', cmd: [], historyGrant: 'none' })).toThrow(/name is required/);
  });
  it('rejects a name over MAX_NAME_LEN, accepts exactly at the boundary', () => {
    expect(() => validateCreateApiKeyInput({ name: 'x'.repeat(MAX_NAME_LEN + 1), cmd: [], historyGrant: 'none' })).toThrow(/too long/);
    const n = validateCreateApiKeyInput({ name: 'x'.repeat(MAX_NAME_LEN), cmd: [], historyGrant: 'none' });
    expect(n.name.length).toBe(MAX_NAME_LEN);
  });
  it('trims the name', () => {
    const n = validateCreateApiKeyInput({ name: '  my key  ', cmd: [], historyGrant: 'none' });
    expect(n.name).toBe('my key');
  });
  it('accepts UTF-8 (Korean + emoji) names', () => {
    const n = validateCreateApiKeyInput({ name: '내 에이전트 🔑', cmd: [], historyGrant: 'none' });
    expect(n.name).toBe('내 에이전트 🔑');
  });
});

describe('validateCreateApiKeyInput — cmd allowlist (boundary / empty / hostile)', () => {
  it('accepts an EMPTY cmd array (key grants nothing)', () => {
    const n = validateCreateApiKeyInput({ name: 'k', cmd: [], historyGrant: 'none' });
    expect(n.cmd).toEqual([]);
  });
  it('accepts a subset of ALLOWED_CMDS', () => {
    const n = validateCreateApiKeyInput({ name: 'k', cmd: ['/openstoa/chat/read', '/openstoa/post/write'], historyGrant: 'none' });
    expect(n.cmd).toEqual(['/openstoa/chat/read', '/openstoa/post/write']);
  });
  it('rejects a non-array cmd', () => {
    expect(() => validateCreateApiKeyInput({ name: 'k', cmd: '/openstoa/chat/read', historyGrant: 'none' })).toThrow(ApiKeyValidationError);
  });
  it('rejects unknown cmd (no silent allow)', () => {
    expect(() => validateCreateApiKeyInput({ name: 'k', cmd: ['/root/delete'], historyGrant: 'none' })).toThrow(/unknown cmd/);
  });
  it('rejects a non-string cmd entry', () => {
    expect(() => validateCreateApiKeyInput({ name: 'k', cmd: [42], historyGrant: 'none' })).toThrow(ApiKeyValidationError);
  });
  it('rejects too many cmd entries (SI-4 cap)', () => {
    const many = Array.from({ length: MAX_CMD_COUNT + 1 }, () => '/ai/summarize');
    expect(() => validateCreateApiKeyInput({ name: 'k', cmd: many, historyGrant: 'none' })).toThrow(/too many/);
  });
  it('dedupes repeated cmd entries', () => {
    const n = validateCreateApiKeyInput({ name: 'k', cmd: ['/ai/summarize', '/ai/summarize'], historyGrant: 'none' });
    expect(n.cmd).toEqual(['/ai/summarize']);
  });
});

describe('validateCreateApiKeyInput — historyGrant + isAI (boundary / hostile)', () => {
  it('accepts none | full | since_epoch:N | Nd', () => {
    for (const s of ['none', 'full', 'since_epoch:5', '30d']) {
      const n = validateCreateApiKeyInput({ name: 'k', cmd: [], historyGrant: s });
      expect(n.historyGrant).toBe(s);
    }
  });
  it('rejects garbage scope', () => {
    for (const s of ['everything', 'since_epoch:', '', 'drop table', '0d']) {
      expect(() => validateCreateApiKeyInput({ name: 'k', cmd: [], historyGrant: s })).toThrow(ApiKeyValidationError);
    }
  });
  it('defaults isAI to true when omitted; accepts explicit true/false', () => {
    expect(validateCreateApiKeyInput({ name: 'k', cmd: [], historyGrant: 'none' }).isAI).toBe(true);
    expect(validateCreateApiKeyInput({ name: 'k', cmd: [], historyGrant: 'none', isAI: false }).isAI).toBe(false);
    expect(validateCreateApiKeyInput({ name: 'k', cmd: [], historyGrant: 'none', isAI: true }).isAI).toBe(true);
  });
  it('rejects a non-boolean isAI', () => {
    expect(() => validateCreateApiKeyInput({ name: 'k', cmd: [], historyGrant: 'none', isAI: 'yes' })).toThrow(/isAI must be a boolean/);
  });
});

describe('hashApiKey / isApiKeyToken (integrity / format)', () => {
  it('is deterministic and looks like a sha256 hex digest', () => {
    const h1 = hashApiKey('osk_abc123');
    const h2 = hashApiKey('osk_abc123');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
  it('different keys hash to different digests', () => {
    expect(hashApiKey('osk_a')).not.toBe(hashApiKey('osk_b'));
  });
  it('recognizes the API key prefix and rejects everything else (JWTs, empty, non-string)', () => {
    expect(isApiKeyToken(`${API_KEY_PREFIX}deadbeef`)).toBe(true);
    expect(isApiKeyToken('eyJhbGciOiJIUzI1NiJ9.x.y')).toBe(false);
    expect(isApiKeyToken('')).toBe(false);
    expect(isApiKeyToken(undefined)).toBe(false);
    expect(isApiKeyToken(123)).toBe(false);
  });
});

describe('toApiKeyMeta — SI-1 integrity (never leaks keyHash or userId)', () => {
  it('strips keyHash and userId from the wire shape', () => {
    const row: ApiKeyRow = {
      id: 'k1', userId: 'u1', name: 'n', keyHash: 'HASH', prefix: 'osk_abcd1234',
      isAI: true, cmd: ['/openstoa/chat/read'], historyGrant: 'none',
      createdAt: new Date(), lastUsedAt: null, revokedAt: null,
    };
    const meta = toApiKeyMeta(row);
    expect(Object.keys(meta).sort()).toEqual(['cmd', 'createdAt', 'historyGrant', 'id', 'isAI', 'lastUsedAt', 'name', 'prefix', 'revokedAt'].sort());
    expect((meta as Record<string, unknown>).keyHash).toBeUndefined();
    expect((meta as Record<string, unknown>).userId).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. DB-backed CRUD (mocked db)
// ───────────────────────────────────────────────────────────────────────────
describe('createApiKey — issuance (contract / integrity)', () => {
  it('generates a raw key with the osk_ prefix, stores only its hash, and returns the raw key once', async () => {
    mocks.insertReturning.mockImplementation(async () => {
      // Simulate the insert echoing back what create() computed. Grab the
      // hash createApiKey passed in via the values() call — simplest: assert
      // shape only, since the mock db doesn't thread .values() args here.
      return [{
        id: 'k1', userId: 'u1', name: 'my key', keyHash: 'irrelevant-for-this-assert',
        prefix: 'osk_aaaaaaaa', isAI: true, cmd: [], historyGrant: 'none',
        createdAt: new Date(), lastUsedAt: null, revokedAt: null,
      }];
    });
    const { row, rawKey } = await createApiKey(db, 'u1', { name: 'my key', cmd: [], historyGrant: 'none' });
    expect(rawKey.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(rawKey.length).toBeGreaterThan(20);
    expect(row.id).toBe('k1');
    // The returned row (as persisted) never carries the raw key itself.
    expect(row.keyHash).not.toBe(rawKey);
  });
  it('rejects invalid input before ever touching the db', async () => {
    await expect(createApiKey(db, 'u1', { name: '', cmd: [], historyGrant: 'none' })).rejects.toThrow(ApiKeyValidationError);
    expect(mocks.insertReturning).not.toHaveBeenCalled();
  });
});

describe('listApiKeys / revokeApiKey (authz / race)', () => {
  it('lists rows for the given user, newest first (delegates ordering to the db call)', async () => {
    mocks.apiKeysFindMany.mockResolvedValue([{ id: 'k1', userId: 'u1' }]);
    const rows = await listApiKeys(db, 'u1');
    expect(rows).toHaveLength(1);
  });
  it('revoke scopes the WHERE by userId — a foreign keyId matches no row (mocked as null)', async () => {
    mocks.updateReturning.mockResolvedValue([]);
    const result = await revokeApiKey(db, 'attacker', 'someone-elses-key');
    expect(result).toBeNull();
  });
  it('revoke succeeds for the owning user', async () => {
    mocks.updateReturning.mockResolvedValue([{ id: 'k1', userId: 'u1', revokedAt: new Date() }]);
    const result = await revokeApiKey(db, 'u1', 'k1');
    expect(result?.id).toBe('k1');
  });
  it('double-revoke race: second flip is a no-op (already-revoked row matches no WHERE)', async () => {
    mocks.updateReturning.mockResolvedValueOnce([{ id: 'k1', revokedAt: new Date() }]).mockResolvedValueOnce([]);
    const first = await revokeApiKey(db, 'u1', 'k1');
    const second = await revokeApiKey(db, 'u1', 'k1');
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});

describe('validateUpdateApiKeyInput — edit scope (boundary / empty / hostile)', () => {
  it('accepts an EMPTY cmd array (narrow to nothing)', () => {
    const n = validateUpdateApiKeyInput({ cmd: [], historyGrant: 'none' });
    expect(n.cmd).toEqual([]);
  });
  it('accepts a subset of ALLOWED_CMDS', () => {
    const n = validateUpdateApiKeyInput({ cmd: ['/openstoa/chat/read'], historyGrant: '7d' });
    expect(n.cmd).toEqual(['/openstoa/chat/read']);
    expect(n.historyGrant).toBe('7d');
  });
  it('rejects unknown cmd, non-array cmd, too many entries, and garbage historyGrant — same rules as create', () => {
    expect(() => validateUpdateApiKeyInput({ cmd: ['/root/delete'], historyGrant: 'none' })).toThrow(/unknown cmd/);
    expect(() => validateUpdateApiKeyInput({ cmd: 'nope', historyGrant: 'none' })).toThrow(ApiKeyValidationError);
    const many = Array.from({ length: MAX_CMD_COUNT + 1 }, () => '/ai/summarize');
    expect(() => validateUpdateApiKeyInput({ cmd: many, historyGrant: 'none' })).toThrow(/too many/);
    expect(() => validateUpdateApiKeyInput({ cmd: [], historyGrant: 'everything' })).toThrow(ApiKeyValidationError);
  });
  it('does NOT accept name/isAI — only cmd/historyGrant exist on the input shape', () => {
    const n = validateUpdateApiKeyInput({ cmd: [], historyGrant: 'none' });
    expect(Object.keys(n).sort()).toEqual(['cmd', 'historyGrant'].sort());
  });
});

describe('updateApiKey (authz / integrity / race)', () => {
  it('rejects invalid input before ever touching the db', async () => {
    await expect(updateApiKey(db, 'u1', 'k1', { cmd: ['/root/x'], historyGrant: 'none' })).rejects.toThrow(ApiKeyValidationError);
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
  it('updates ONLY cmd/historyGrant — never touches name/isAI/keyHash', async () => {
    mocks.updateReturning.mockResolvedValue([
      { id: 'k1', userId: 'u1', name: 'laptop', keyHash: 'h', prefix: 'osk_abcd1234', isAI: true, cmd: ['/openstoa/chat/read'], historyGrant: '7d', createdAt: new Date(), lastUsedAt: null, revokedAt: null },
    ]);
    const row = await updateApiKey(db, 'u1', 'k1', { cmd: ['/openstoa/chat/read'], historyGrant: '7d' });
    expect(row?.cmd).toEqual(['/openstoa/chat/read']);
    expect(mocks.updateSet).toHaveBeenCalledWith({ cmd: ['/openstoa/chat/read'], historyGrant: '7d' });
  });
  it('scopes the WHERE by userId — a foreign keyId matches no row (mocked as null)', async () => {
    mocks.updateReturning.mockResolvedValue([]);
    const result = await updateApiKey(db, 'attacker', 'someone-elses-key', { cmd: [], historyGrant: 'none' });
    expect(result).toBeNull();
  });
  it('an already-revoked key matches no row (isNull(revokedAt) in the WHERE — same shape as revoke)', async () => {
    mocks.updateReturning.mockResolvedValue([]);
    const result = await updateApiKey(db, 'u1', 'revoked-key', { cmd: ['/ai/search'], historyGrant: 'none' });
    expect(result).toBeNull();
  });
});

describe('verifyApiKey (authz / hostile)', () => {
  it('returns null for an unknown key', async () => {
    mocks.apiKeysFindFirst.mockResolvedValue(undefined);
    expect(await verifyApiKey(db, 'osk_nope')).toBeNull();
  });
  it('returns the row for a valid, non-revoked key', async () => {
    mocks.apiKeysFindFirst.mockResolvedValue({ id: 'k1', userId: 'u1', cmd: ['/openstoa/chat/read'], historyGrant: 'none', isAI: true, revokedAt: null });
    const row = await verifyApiKey(db, 'osk_valid');
    expect(row?.id).toBe('k1');
  });
  it('a revoked key is filtered out at the query layer (isNull(revokedAt) in the WHERE)', async () => {
    // The mocked findFirst doesn't evaluate the WHERE — this test documents the
    // real Drizzle query includes isNull(apiKeys.revokedAt), which the E2E
    // suite proves end-to-end (real WHERE evaluated against real Postgres).
    mocks.apiKeysFindFirst.mockResolvedValue(undefined);
    expect(await verifyApiKey(db, 'osk_revoked')).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. getSession()'s API-key resolution (real @/lib/session, mocked db above)
// ───────────────────────────────────────────────────────────────────────────
const fakeRequest = (bearer?: string) =>
  ({
    cookies: { get: () => undefined },
    headers: { get: (h: string) => (h.toLowerCase() === 'authorization' && bearer ? `Bearer ${bearer}` : null) },
  }) as never;

describe('getSession — API-key path (authz / hostile / integrity)', () => {
  beforeEach(() => {
    process.env.COMMUNITY_JWT_SECRET = 'test-secret-key-for-jwt-signing-minimum-length';
  });

  it('an unknown/garbage osk_ token resolves to null (401 upstream), not a crash', async () => {
    mocks.apiKeysFindFirst.mockResolvedValue(undefined);
    const { getSession } = await import('@/lib/session');
    const session = await getSession(fakeRequest('osk_garbage'));
    expect(session).toBeNull();
  });

  it('a valid key resolves userId/nickname/isAI/apiKeyCmd/apiKeyHistoryGrant FROM THE KEY row', async () => {
    mocks.apiKeysFindFirst.mockResolvedValue({
      id: 'k1', userId: 'bot-owner-1', cmd: ['/openstoa/chat/read', '/openstoa/post/write'],
      historyGrant: '7d', isAI: true, revokedAt: null,
    });
    mocks.usersFindFirst.mockResolvedValue({ id: 'bot-owner-1', nickname: 'agentowner' });
    const { getSession } = await import('@/lib/session');
    const session = await getSession(fakeRequest('osk_validkey'));
    expect(session).toMatchObject({
      userId: 'bot-owner-1',
      nickname: 'agentowner',
      isAI: true,
      apiKeyId: 'k1',
      apiKeyCmd: ['/openstoa/chat/read', '/openstoa/post/write'],
      apiKeyHistoryGrant: '7d',
    });
  });

  it('key resolves to a user that no longer exists → null (integrity, no orphaned session)', async () => {
    mocks.apiKeysFindFirst.mockResolvedValue({ id: 'k1', userId: 'deleted-user', cmd: [], historyGrant: 'none', isAI: true, revokedAt: null });
    mocks.usersFindFirst.mockResolvedValue(undefined);
    const { getSession } = await import('@/lib/session');
    const session = await getSession(fakeRequest('osk_orphankey'));
    expect(session).toBeNull();
  });

  it('a non-osk bearer token falls through to JWT verification (unaffected by API-key path)', async () => {
    const { getSession, createSession } = await import('@/lib/session');
    const jwt = await createSession('human-1', 'human_nick');
    const session = await getSession(fakeRequest(jwt));
    expect(session?.userId).toBe('human-1');
    expect(mocks.apiKeysFindFirst).not.toHaveBeenCalled();
  });

  it('no Authorization header at all → null, no db calls', async () => {
    const { getSession } = await import('@/lib/session');
    const session = await getSession(fakeRequest(undefined));
    expect(session).toBeNull();
    expect(mocks.apiKeysFindFirst).not.toHaveBeenCalled();
  });
});
