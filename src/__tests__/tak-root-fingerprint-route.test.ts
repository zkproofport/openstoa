import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Route-level tests for GET/PUT /api/topics/{topicId}/tak/root-fingerprint:
 * authz (401/403/404), tier gating (public only — private/secret archive keys are
 * per-epoch), rate limit (429), and the hostile-input matrix on the one field
 * that reaches a write-once column. The compare-and-set itself lives in SQL and
 * is proven against real Postgres in mls-archive.test.ts; here the data layer is
 * mocked so the HTTP envelope is isolated.
 */
const session = { userId: 'u1', nickname: 'alice', isAI: false };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  incr: vi.fn().mockResolvedValue(1),
  expire: vi.fn(),
  topicMembersFindFirst: vi.fn(),
  topicsFindFirst: vi.fn(),
  getArchiveRootIdentity: vi.fn(),
  claimArchiveRootFingerprint: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/redis', () => ({ getRedis: () => ({ incr: mocks.incr, expire: mocks.expire }) }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: {
    query: {
      topicMembers: { findFirst: mocks.topicMembersFindFirst },
      topics: { findFirst: mocks.topicsFindFirst },
    },
  },
}));
vi.mock('@/lib/mls/archive', () => ({
  getArchiveRootIdentity: mocks.getArchiveRootIdentity,
  claimArchiveRootFingerprint: mocks.claimArchiveRootFingerprint,
  // The holder route imports these; the non-public guard returns before any of
  // them runs, which is exactly what the tier-isolation test below asserts.
  claimOrRenewHolder: vi.fn(),
  updateHolderCoverage: vi.fn(),
  getHolder: vi.fn().mockResolvedValue(null),
}));

import { GET, PUT } from '@/app/api/topics/[topicId]/tak/root-fingerprint/route';
import {
  GET as holderGET,
  POST as holderPOST,
  PATCH as holderPATCH,
} from '@/app/api/topics/[topicId]/tak/holder/route';

const TOPIC = '00000000-0000-0000-0000-000000000001';
const params = () => Promise.resolve({ topicId: TOPIC });
const req = (body?: unknown) =>
  ({ json: async () => body, url: `http://x/api/topics/${TOPIC}/tak/root-fingerprint` }) as never;

/** base64 of exactly 16 bytes — the only accepted shape. */
const VALID_FP = Buffer.alloc(16, 7).toString('base64');

function asPublicMember() {
  mocks.getSession.mockResolvedValue(session);
  mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: 'u1', role: 'member' });
  mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'public' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.incr.mockResolvedValue(1);
  mocks.getArchiveRootIdentity.mockResolvedValue({ fingerprint: null, archiveCount: 0 });
  mocks.claimArchiveRootFingerprint.mockResolvedValue({ fingerprint: VALID_FP, claimed: true });
});

describe('root-fingerprint route — authorization', () => {
  it('401 for a guest (no session) on both verbs', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await GET(req(), { params: params() })).status).toBe(401);
    expect((await PUT(req({ fingerprint: VALID_FP }), { params: params() })).status).toBe(401);
  });

  it('403 for an authenticated NON-MEMBER on both verbs', async () => {
    mocks.getSession.mockResolvedValue(session);
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    expect((await GET(req(), { params: params() })).status).toBe(403);
    expect((await PUT(req({ fingerprint: VALID_FP }), { params: params() })).status).toBe(403);
    // A non-member never reaches the data layer.
    expect(mocks.getArchiveRootIdentity).not.toHaveBeenCalled();
    expect(mocks.claimArchiveRootFingerprint).not.toHaveBeenCalled();
  });

  it('404 when the topic does not exist', async () => {
    mocks.getSession.mockResolvedValue(session);
    mocks.topicMembersFindFirst.mockResolvedValue({ role: 'member' });
    mocks.topicsFindFirst.mockResolvedValue(undefined);
    expect((await GET(req(), { params: params() })).status).toBe(404);
    expect((await PUT(req({ fingerprint: VALID_FP }), { params: params() })).status).toBe(404);
  });

  it('200 for every member role — owner, admin and plain member all read and publish', async () => {
    for (const role of ['owner', 'admin', 'member']) {
      mocks.getSession.mockResolvedValue(session);
      mocks.topicMembersFindFirst.mockResolvedValue({ role });
      mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'public' });
      expect((await GET(req(), { params: params() })).status).toBe(200);
      expect((await PUT(req({ fingerprint: VALID_FP }), { params: params() })).status).toBe(200);
    }
  });

  it('404 for a missing topic is reported before the archive identity is read', async () => {
    mocks.getSession.mockResolvedValue(session);
    mocks.topicMembersFindFirst.mockResolvedValue({ role: 'owner' });
    mocks.claimArchiveRootFingerprint.mockResolvedValue(null); // topic vanished mid-flight
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility: 'public' });
    expect((await PUT(req({ fingerprint: VALID_FP }), { params: params() })).status).toBe(404);
  });
});

describe('root-fingerprint route — tier gating (public only)', () => {
  it('400 on private and secret topics: their archive keys are per-epoch, not root-based', async () => {
    for (const visibility of ['private', 'secret']) {
      mocks.getSession.mockResolvedValue(session);
      mocks.topicMembersFindFirst.mockResolvedValue({ role: 'owner' });
      mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility });
      expect((await GET(req(), { params: params() })).status).toBe(400);
      expect((await PUT(req({ fingerprint: VALID_FP }), { params: params() })).status).toBe(400);
    }
    // Never touches storage for a non-public topic.
    expect(mocks.getArchiveRootIdentity).not.toHaveBeenCalled();
    expect(mocks.claimArchiveRootFingerprint).not.toHaveBeenCalled();
  });
});

describe('root-fingerprint route — GET response', () => {
  it('passes through the fingerprint and the archive row count', async () => {
    asPublicMember();
    mocks.getArchiveRootIdentity.mockResolvedValue({ fingerprint: VALID_FP, archiveCount: 42 });
    const res = await GET(req(), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fingerprint: VALID_FP, archiveCount: 42 });
  });

  it('reports the retroactive state (rows, no fingerprint) distinctly from a fresh topic', async () => {
    asPublicMember();
    mocks.getArchiveRootIdentity.mockResolvedValue({ fingerprint: null, archiveCount: 7 });
    expect(await (await GET(req(), { params: params() })).json()).toEqual({ fingerprint: null, archiveCount: 7 });
  });
});

describe('root-fingerprint route — PUT input validation (hostile matrix)', () => {
  // Every one of these must be a 400 and must never reach the write-once column.
  const REJECTED: Array<[string, unknown]> = [
    ['missing field', {}],
    ['null', { fingerprint: null }],
    ['undefined', { fingerprint: undefined }],
    ['empty string', { fingerprint: '' }],
    ['single space', { fingerprint: ' ' }],
    ['whitespace only', { fingerprint: '    ' }],
    ['tab + newline', { fingerprint: '\t\n' }],
    ['non-base64 punctuation', { fingerprint: '!!!!!!!!!!!!!!!!!!!!!!!!' }],
    ['base64 with inner whitespace', { fingerprint: 'AAEC AwQFBgcICQoLDA0ODw==' }],
    ['url-safe base64 alphabet', { fingerprint: '-_-_-_-_-_-_-_-_-_-_-_==' }],
    ['bad padding', { fingerprint: 'AAECAwQFBgcICQoLDA0ODw=' }],
    ['non-canonical padding bits', { fingerprint: 'AAECAwQFBgcICQoLDA0ODx==' }],
    ['15 bytes (one short)', { fingerprint: Buffer.alloc(15, 1).toString('base64') }],
    ['17 bytes (one over)', { fingerprint: Buffer.alloc(17, 1).toString('base64') }],
    ['0 bytes', { fingerprint: Buffer.alloc(0).toString('base64') }],
    ['32 bytes (a whole root, not a tag)', { fingerprint: Buffer.alloc(32, 1).toString('base64') }],
    ['very large input (1 MiB)', { fingerprint: 'A'.repeat(1024 * 1024) }],
    ['korean', { fingerprint: '안녕하세요반갑습니다안녕하세' }],
    ['emoji', { fingerprint: '🔑🔑🔑🔑🔑🔑' }],
    ['mixed scripts', { fingerprint: 'abc안녕🔑def' }],
    ['embedded NUL byte', { fingerprint: 'AAECAwQFBgcI\u0000CQoLDA0ODw==' }],
    ['embedded newline', { fingerprint: 'AAECAwQFBgcI\nCQoLDA0ODw==' }],
    ['leading/trailing whitespace around a valid value', { fingerprint: `  ${VALID_FP}  ` }],
    ['sql-shaped', { fingerprint: "'; UPDATE topics SET archive_root_fingerprint=NULL; --" }],
    ['html/script', { fingerprint: '<script>alert(1)</script>' }],
    ['ilike wildcards', { fingerprint: '%_\\%_\\%_\\%_\\%_\\%_' }],
    ['number', { fingerprint: 12345678 }],
    ['boolean', { fingerprint: true }],
    ['array', { fingerprint: [VALID_FP] }],
    ['object', { fingerprint: { toString: () => VALID_FP } }],
    ['body is null', null],
    ['body is a string', 'fingerprint=' + VALID_FP],
    ['body is an array', [VALID_FP]],
  ];

  for (const [name, body] of REJECTED) {
    it(`400 — ${name}`, async () => {
      asPublicMember();
      const res = await PUT(req(body), { params: params() });
      expect(res.status).toBe(400);
      expect(mocks.claimArchiveRootFingerprint).not.toHaveBeenCalled();
    });
  }

  it('400 when the body is not valid JSON at all', async () => {
    asPublicMember();
    const bad = {
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
      url: `http://x/api/topics/${TOPIC}/tak/root-fingerprint`,
    } as never;
    expect((await PUT(bad, { params: params() })).status).toBe(400);
    expect(mocks.claimArchiveRootFingerprint).not.toHaveBeenCalled();
  });

  it('accepts exactly 16 base64 bytes and forwards it verbatim', async () => {
    asPublicMember();
    const res = await PUT(req({ fingerprint: VALID_FP }), { params: params() });
    expect(res.status).toBe(200);
    expect(mocks.claimArchiveRootFingerprint).toHaveBeenCalledWith(expect.anything(), TOPIC, VALID_FP);
  });

  it('reports the WINNER when the caller lost the compare-and-set', async () => {
    asPublicMember();
    const winner = Buffer.alloc(16, 9).toString('base64');
    mocks.claimArchiveRootFingerprint.mockResolvedValue({ fingerprint: winner, claimed: false });
    const res = await PUT(req({ fingerprint: VALID_FP }), { params: params() });
    expect(res.status).toBe(200);
    // claimed:false is how the client learns to adopt the winner's root instead
    // of archiving under its own.
    expect(await res.json()).toEqual({ fingerprint: winner, claimed: false });
  });
});

describe('root-fingerprint route — rate limit', () => {
  it('429 once the per-member window is exhausted, and nothing is written', async () => {
    asPublicMember();
    mocks.incr.mockResolvedValue(10_000);
    const res = await PUT(req({ fingerprint: VALID_FP }), { params: params() });
    expect(res.status).toBe(429);
    expect(mocks.claimArchiveRootFingerprint).not.toHaveBeenCalled();
  });

  it('does not rate-limit the read path', async () => {
    asPublicMember();
    mocks.incr.mockResolvedValue(10_000);
    expect((await GET(req(), { params: params() })).status).toBe(200);
  });
});

describe('root-fingerprint route — failure handling', () => {
  it('500s (rather than silently succeeding) when the data layer throws', async () => {
    asPublicMember();
    mocks.getArchiveRootIdentity.mockRejectedValue(new Error('db down'));
    expect((await GET(req(), { params: params() })).status).toBe(500);
    mocks.claimArchiveRootFingerprint.mockRejectedValue(new Error('db down'));
    expect((await PUT(req({ fingerprint: VALID_FP }), { params: params() })).status).toBe(500);
  });
});

describe('archive-holder route — still public-only (SI-6b, unchanged by this work)', () => {
  it('refuses holder operations on private and secret topics', async () => {
    for (const visibility of ['private', 'secret']) {
      mocks.getSession.mockResolvedValue(session);
      mocks.topicMembersFindFirst.mockResolvedValue({ role: 'owner' });
      mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, visibility });
      expect((await holderGET(req(), { params: params() })).status).toBe(400);
      expect((await holderPOST(req({ deviceId: 'd1' }), { params: params() })).status).toBe(400);
      expect(
        (await holderPATCH(req({ deviceId: 'd1', epochCovered: 1 }), { params: params() })).status,
      ).toBe(400);
    }
  });

  it('still serves a public topic (the guard is on visibility, not on the verb)', async () => {
    asPublicMember();
    expect((await holderGET(req(), { params: params() })).status).toBe(200);
  });
});
