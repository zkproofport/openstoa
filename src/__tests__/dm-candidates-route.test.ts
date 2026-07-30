import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_CANDIDATE_LIMIT, MAX_CANDIDATE_LIMIT } from '@/lib/dmCandidates';

/**
 * `GET /api/dm/candidates` — handler branches.
 *
 * Split from `dm-candidates.test.ts` because this file mocks
 * `@/lib/dmCandidates` to intercept the query builder; that mock is
 * module-wide, so the SQL-shape assertions (which need the REAL builder) must
 * live in their own file. Here the builder is a spy, which buys the contract
 * assertions: the handler must hand it the caller's own id, the ESCAPED ilike
 * pattern and the CLAMPED limit — remove `normaliseSearchQuery` or
 * `clampCandidateLimit` from the route and these fail.
 */

const human = { userId: 'alice', nickname: 'alice', isAI: false };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  buildQuery: vi.fn(),
  getBatchUserBadges: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: {
    query: {
      // requireAiCapability's DB path (only hit when isAI has no apiKeyCmd).
      aiPermissions: { findFirst: vi.fn().mockResolvedValue(null) },
    },
  },
}));
vi.mock('@/lib/verification-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/verification-cache')>()),
  getBatchUserBadges: mocks.getBatchUserBadges,
}));
vi.mock('@/lib/dmCandidates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dmCandidates')>()),
  buildDmCandidatesQuery: mocks.buildQuery,
}));

const { GET } = await import('@/app/api/dm/candidates/route');

function req(query = '') {
  return {
    url: `http://x/api/dm/candidates${query}`,
    cookies: { get: () => undefined },
    headers: { get: () => null },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue(human);
  mocks.buildQuery.mockResolvedValue([]);
  mocks.getBatchUserBadges.mockResolvedValue(new Map());
});

describe('GET /api/dm/candidates — authz', () => {
  it('401 when unauthenticated', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it('403 when an isAI key lacks chat/read', async () => {
    mocks.getSession.mockResolvedValue({ userId: 'ai', nickname: 'ai', isAI: true, apiKeyCmd: [] });
    expect((await GET(req())).status).toBe(403);
  });

  it('200 when an isAI key holds chat/read', async () => {
    mocks.getSession.mockResolvedValue({
      userId: 'ai',
      nickname: 'ai',
      isAI: true,
      apiKeyCmd: ['/openstoa/chat/read'],
    });
    expect((await GET(req())).status).toBe(200);
  });
});

describe('GET /api/dm/candidates — response shaping', () => {
  it('200 with an empty list when the caller belongs to no topics (not an error)', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [] });
  });

  it('returns one entry per person carrying every shared topic', async () => {
    mocks.buildQuery.mockResolvedValue([
      {
        userId: 'bob',
        nickname: 'bob',
        profileImage: null,
        sharedTopics: [
          { id: 't1', title: 'Alpha' },
          { id: 't2', title: 'Beta' },
          { id: 't3', title: 'Gamma' },
        ],
        proofTypes: ['kyc', 'none'],
      },
    ]);
    mocks.getBatchUserBadges.mockResolvedValue(new Map([['bob', [{ type: 'kyc', label: 'KYC' }]]]));

    const body = await (await GET(req())).json();
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toEqual({
      userId: 'bob',
      nickname: 'bob',
      profileImage: null,
      badges: [{ type: 'kyc', label: 'KYC' }],
      sharedTopics: [
        { id: 't1', title: 'Alpha' },
        { id: 't2', title: 'Beta' },
        { id: 't3', title: 'Gamma' },
      ],
    });
  });

  it('shows no badge when the only shared topic is open, even if the peer has one', async () => {
    mocks.buildQuery.mockResolvedValue([
      {
        userId: 'bob',
        nickname: 'bob',
        profileImage: null,
        sharedTopics: [{ id: 't1', title: 'Open' }],
        proofTypes: ['none'],
      },
    ]);
    mocks.getBatchUserBadges.mockResolvedValue(new Map([['bob', [{ type: 'kyc', label: 'KYC' }]]]));
    const body = await (await GET(req())).json();
    expect(body.candidates[0].badges).toEqual([]);
  });

  it('survives UTF-8 and very long nicknames / titles without truncating', async () => {
    const longTitle = '토픽 '.repeat(200);
    mocks.buildQuery.mockResolvedValue([
      {
        userId: 'u1',
        nickname: '김철수 🦊',
        profileImage: 'https://cdn/x.png',
        sharedTopics: [{ id: 't1', title: longTitle }],
        proofTypes: ['none'],
      },
    ]);
    const body = await (await GET(req())).json();
    expect(body.candidates[0].nickname).toBe('김철수 🦊');
    expect(body.candidates[0].sharedTopics[0].title).toBe(longTitle);
  });

  it('tolerates a row whose aggregates came back null', async () => {
    mocks.buildQuery.mockResolvedValue([
      { userId: 'u1', nickname: 'u1', profileImage: undefined, sharedTopics: null, proofTypes: null },
    ]);
    const body = await (await GET(req())).json();
    expect(body.candidates[0]).toEqual({
      userId: 'u1',
      nickname: 'u1',
      profileImage: null,
      badges: [],
      sharedTopics: [],
    });
  });

  it('500 with a message when the query throws', async () => {
    mocks.buildQuery.mockRejectedValue(new Error('db down'));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('db down');
  });
});

describe('GET /api/dm/candidates — contract: what the handler hands the query', () => {
  it('passes the caller id, no pattern and the default limit by default', async () => {
    await GET(req());
    expect(mocks.buildQuery).toHaveBeenCalledWith(expect.anything(), 'alice', {
      qPattern: null,
      limit: DEFAULT_CANDIDATE_LIMIT,
    });
  });

  it('escapes ilike wildcards before they reach the query', async () => {
    await GET(req('?q=%25'));
    expect(mocks.buildQuery.mock.calls[0][2]).toMatchObject({ qPattern: '%\\%%' });
    mocks.buildQuery.mockClear();

    await GET(req('?q=a_b'));
    expect(mocks.buildQuery.mock.calls[0][2]).toMatchObject({ qPattern: '%a\\_b%' });
    mocks.buildQuery.mockClear();

    await GET(req('?q=a%5Cb'));
    expect(mocks.buildQuery.mock.calls[0][2]).toMatchObject({ qPattern: '%a\\\\b%' });
  });

  it('turns a whitespace-only q into "no filter"', async () => {
    await GET(req('?q=%20%20'));
    expect(mocks.buildQuery.mock.calls[0][2]).toMatchObject({ qPattern: null });
  });

  it('clamps a hostile limit before it reaches the query', async () => {
    await GET(req('?limit=999999'));
    expect(mocks.buildQuery.mock.calls[0][2]).toMatchObject({ limit: MAX_CANDIDATE_LIMIT });
    mocks.buildQuery.mockClear();

    await GET(req('?limit=-1'));
    expect(mocks.buildQuery.mock.calls[0][2]).toMatchObject({ limit: DEFAULT_CANDIDATE_LIMIT });
  });

  it('only asks the badge cache for the users actually returned', async () => {
    mocks.buildQuery.mockResolvedValue([
      { userId: 'bob', nickname: 'bob', profileImage: null, sharedTopics: [], proofTypes: [] },
    ]);
    await GET(req());
    expect(mocks.getBatchUserBadges).toHaveBeenCalledWith(['bob']);
  });
});
