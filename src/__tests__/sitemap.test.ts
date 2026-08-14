/**
 * `src/app/sitemap.ts` — search-engine discovery surface.
 *
 * Edge-case matrix rows covered here:
 *   boundary        — zero public topics/posts produces the static-only sitemap
 *   authz           — private/secret topics, and posts inside them, never
 *                     appear; a blinded PUBLIC topic (and its posts) is
 *                     excluded too — mirroring `/api/topics` and `/api/feed`
 *   integrity       — a soft-deleted post never appears even in a public,
 *                     non-blinded topic; post URLs use the real topicId/postId
 *   ext-dep-failure — a DB throw for either query degrades to an empty list
 *                     for THAT section, not a 500 for the whole route
 *   contract        — non-production (`APP_ENV !== 'production'`) returns []
 *                     entirely, without ever touching the DB
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSelectFn } = vi.hoisted(() => ({ mockSelectFn: vi.fn() }));

vi.mock('@/lib/db', () => ({ db: { select: mockSelectFn } }));

vi.mock('@/lib/db/schema', () => ({
  topics: { id: 'id', visibility: 'visibility', blindedAt: 'blindedAt', lastActivityAt: 'lastActivityAt' },
  posts: { id: 'id', topicId: 'topicId', isDeleted: 'isDeleted', lastActivityAt: 'lastActivityAt' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  isNull: (...args: unknown[]) => ({ isNull: args }),
  desc: (...args: unknown[]) => ({ desc: args }),
}));

/** `db.select().from().where()` — resolves at `.where()` (the topics query). */
function topicsChain(rows: unknown[] | (() => unknown[])) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockImplementation(async () => (typeof rows === 'function' ? rows() : rows)),
    }),
  };
}

/** `db.select().from().innerJoin().where().orderBy().limit()` — the posts query. */
function postsChain(rows: unknown[] | (() => unknown[])) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockImplementation(async () => (typeof rows === 'function' ? rows() : rows)),
          }),
        }),
      }),
    }),
  };
}

const ORIGINAL_APP_ENV = process.env.APP_ENV;

beforeEach(() => {
  process.env.APP_ENV = 'production';
  mockSelectFn.mockReset();
});

afterEach(() => {
  if (ORIGINAL_APP_ENV === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = ORIGINAL_APP_ENV;
  vi.resetModules();
});

async function loadSitemap() {
  const mod = await import('@/app/sitemap');
  return mod.default;
}

describe('sitemap', () => {
  it('CONTRACT: non-production returns [] without touching the DB', async () => {
    process.env.APP_ENV = 'staging';
    const sitemap = await loadSitemap();
    const result = await sitemap();
    expect(result).toEqual([]);
    expect(mockSelectFn).not.toHaveBeenCalled();
  });

  it('BOUNDARY: zero public topics and zero public posts still returns the static pages', async () => {
    mockSelectFn.mockReturnValueOnce(topicsChain([])).mockReturnValueOnce(postsChain([]));
    const sitemap = await loadSitemap();
    const result = await sitemap();
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => !r.url.includes('/topics/'))).toBe(true);
  });

  it('INTEGRITY: a public topic and one of its posts both appear with the right URLs', async () => {
    const topicId = 'aaaaaaaa-1111-4111-8111-111111111111';
    const postId = 'bbbbbbbb-2222-4222-8222-222222222222';
    mockSelectFn
      .mockReturnValueOnce(topicsChain([{ id: topicId, lastActivityAt: new Date('2026-01-01') }]))
      .mockReturnValueOnce(postsChain([{ id: postId, topicId, lastActivityAt: new Date('2026-01-02') }]));
    const sitemap = await loadSitemap();
    const result = await sitemap();
    expect(result.some((r) => r.url === 'https://www.openstoa.xyz/topics/aaaaaaaa-1111-4111-8111-111111111111')).toBe(true);
    expect(
      result.some(
        (r) => r.url === 'https://www.openstoa.xyz/topics/aaaaaaaa-1111-4111-8111-111111111111/posts/bbbbbbbb-2222-4222-8222-222222222222',
      ),
    ).toBe(true);
  });

  it('AUTHZ: the topics query filters visibility=public AND blindedAt IS NULL (never trusts caller-side filtering)', async () => {
    mockSelectFn.mockReturnValueOnce(topicsChain([])).mockReturnValueOnce(postsChain([]));
    const sitemap = await loadSitemap();
    await sitemap();
    const fromMock = mockSelectFn.mock.results[0].value.from as ReturnType<typeof vi.fn>;
    const whereMock = fromMock.mock.results[0].value.where as ReturnType<typeof vi.fn>;
    const whereArg = whereMock.mock.calls[0][0] as { and: unknown[] };
    expect(whereArg.and).toHaveLength(2); // eq(visibility, 'public') AND isNull(blindedAt)
  });

  it('AUTHZ: the posts query filters topic visibility=public, topic blindedAt IS NULL, AND post isDeleted=false', async () => {
    mockSelectFn.mockReturnValueOnce(topicsChain([])).mockReturnValueOnce(postsChain([]));
    const sitemap = await loadSitemap();
    await sitemap();
    const fromMock = mockSelectFn.mock.results[1].value.from as ReturnType<typeof vi.fn>;
    const innerJoinMock = fromMock.mock.results[0].value.innerJoin as ReturnType<typeof vi.fn>;
    const whereMock = innerJoinMock.mock.results[0].value.where as ReturnType<typeof vi.fn>;
    const whereArg = whereMock.mock.calls[0][0] as { and: unknown[] };
    expect(whereArg.and).toHaveLength(3);
  });

  it('EXT-DEP-FAILURE: a throwing topics query degrades to no topic pages, not a 500', async () => {
    mockSelectFn
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockRejectedValue(new Error('connection terminated')) }),
      })
      .mockReturnValueOnce(postsChain([]));
    const sitemap = await loadSitemap();
    const result = await sitemap();
    expect(result.some((r) => r.url.includes('/topics/aaaa'))).toBe(false);
    expect(result.length).toBeGreaterThan(0); // static pages still present
  });

  it('EXT-DEP-FAILURE: a throwing posts query degrades to no post pages, not a 500, even when topics succeeded', async () => {
    const topicId = 'aaaaaaaa-1111-4111-8111-111111111111';
    mockSelectFn
      .mockReturnValueOnce(topicsChain([{ id: topicId, lastActivityAt: new Date() }]))
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockRejectedValue(new Error('connection terminated')) }),
            }),
          }),
        }),
      });
    const sitemap = await loadSitemap();
    const result = await sitemap();
    expect(result.some((r) => r.url.includes(`/topics/${topicId}`) && !r.url.includes('/posts/'))).toBe(true);
    expect(result.some((r) => r.url.includes('/posts/'))).toBe(false);
  });
});
