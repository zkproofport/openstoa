import { describe, it, expect, vi, beforeEach } from 'vitest';

let selectCallCount = 0;
let selectResponses: number[] = [];

const mockDbSelectResult = (rows: object[]) => ({
  from: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(rows),
  }),
});

const { mockFindFirst, mockSelectFn, mockUpdateWhere, mockUpdateSet, mockUpdateFn } = vi.hoisted(() => {
  const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdateFn = vi.fn().mockReturnValue({ set: mockUpdateSet });
  const mockFindFirst = vi.fn();
  const mockSelectFn = vi.fn();
  return { mockFindFirst, mockSelectFn, mockUpdateWhere, mockUpdateSet, mockUpdateFn };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: mockSelectFn,
    query: {
      topics: {
        findFirst: mockFindFirst,
      },
    },
    update: mockUpdateFn,
  },
}));

vi.mock('@/lib/db/schema', () => ({
  topics: { id: 'id', createdAt: 'createdAt', score: 'score', lastActivityAt: 'lastActivityAt' },
  posts: { id: 'id', topicId: 'topicId', createdAt: 'createdAt' },
  topicMembers: { topicId: 'topicId' },
  comments: { postId: 'postId', createdAt: 'createdAt' },
  votes: { postId: 'postId', createdAt: 'createdAt' },
  reactions: { postId: 'postId', createdAt: 'createdAt' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  sql: vi.fn(),
  inArray: vi.fn(),
}));

import { updateTopicScore, TOPIC_SCORE_WEIGHTS } from '@/lib/topicScore';

/**
 * The score function makes the following calls in order:
 *
 *   1. select posts (returns rows: [{id, createdAt}, ...])
 *   2. select member count
 *   3. select comment count, vote count, reaction count (parallel — but
 *      the mock counts them in registration order)
 *
 * Configure `selectResponses` as the integer counts you want each
 * count(*) query to return. The post list (step 1) is configured via
 * `postRows` below.
 */
function configureMocks({
  postRows,
  memberCount,
  recentComments,
  recentVotes,
  recentReactions,
}: {
  postRows: Array<{ id: string; createdAt: Date }>;
  memberCount: number;
  recentComments: number;
  recentVotes: number;
  recentReactions: number;
}) {
  selectCallCount = 0;
  selectResponses = [memberCount, recentComments, recentVotes, recentReactions];

  mockSelectFn.mockImplementation(() => {
    selectCallCount++;
    if (selectCallCount === 1) {
      // post id+createdAt list
      return mockDbSelectResult(postRows);
    }
    const next = selectResponses.shift() ?? 0;
    return mockDbSelectResult([{ count: next }]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpdateFn.mockReturnValue({ set: mockUpdateSet });
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockResolvedValue(undefined);
});

describe('updateTopicScore', () => {
  it('returns early when topic is not found', async () => {
    configureMocks({
      postRows: [], memberCount: 0, recentComments: 0, recentVotes: 0, recentReactions: 0,
    });
    mockFindFirst.mockResolvedValueOnce(undefined);

    await updateTopicScore('topic-missing');

    expect(mockUpdateFn).not.toHaveBeenCalled();
  });

  it('writes lastActivityAt + score on every call', async () => {
    const createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    configureMocks({
      postRows: [{ id: 'p1', createdAt }],
      memberCount: 5, recentComments: 0, recentVotes: 0, recentReactions: 0,
    });
    mockFindFirst.mockResolvedValueOnce({ id: 'topic-1', createdAt });

    await updateTopicScore('topic-1');

    const setArg = mockUpdateSet.mock.calls[0][0];
    expect(typeof setArg.score).toBe('number');
    expect(setArg.score).toBeGreaterThan(0);
    expect(setArg.lastActivityAt).toBeInstanceOf(Date);
  });

  it('reflects every weighted activity term (post / comment / vote / reaction / member)', async () => {
    const now = Date.now();
    const ageDays = 3;
    const createdAt = new Date(now - ageDays * 24 * 60 * 60 * 1000);
    // One recent post + one older post (older not counted toward recentPosts).
    const recentPostDate = new Date(now - 1 * 24 * 60 * 60 * 1000);
    const oldPostDate = new Date(now - 10 * 24 * 60 * 60 * 1000);
    configureMocks({
      postRows: [
        { id: 'p-recent', createdAt: recentPostDate },
        { id: 'p-old', createdAt: oldPostDate },
      ],
      memberCount: 6,
      recentComments: 4,
      recentVotes: 10,
      recentReactions: 8,
    });
    mockFindFirst.mockResolvedValueOnce({ id: 'topic-1', createdAt });

    await updateTopicScore('topic-1');

    const setArg = mockUpdateSet.mock.calls[0][0];
    const timeDecay = Math.log2(ageDays + 2);
    const expected =
      6 * TOPIC_SCORE_WEIGHTS.member +
      1 * TOPIC_SCORE_WEIGHTS.post +
      4 * TOPIC_SCORE_WEIGHTS.comment +
      10 * TOPIC_SCORE_WEIGHTS.vote +
      8 * TOPIC_SCORE_WEIGHTS.reaction +
      (1 / timeDecay) * TOPIC_SCORE_WEIGHTS.ageDecayBoost;

    expect(setArg.score).toBeCloseTo(expected, 5);
  });

  it('comment activity moves the score (was the missing piece in the old formula)', async () => {
    const createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const post = [{ id: 'p1', createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) }];

    // Baseline: no comments / votes / reactions.
    configureMocks({ postRows: post, memberCount: 5, recentComments: 0, recentVotes: 0, recentReactions: 0 });
    mockFindFirst.mockResolvedValueOnce({ id: 'topic-1', createdAt });
    await updateTopicScore('topic-1');
    const baseline = mockUpdateSet.mock.calls[0][0].score;

    // Same fixture but with 5 fresh comments.
    mockUpdateSet.mockClear();
    configureMocks({ postRows: post, memberCount: 5, recentComments: 5, recentVotes: 0, recentReactions: 0 });
    mockFindFirst.mockResolvedValueOnce({ id: 'topic-1', createdAt });
    await updateTopicScore('topic-1');
    const withComments = mockUpdateSet.mock.calls[0][0].score;

    expect(withComments).toBeGreaterThan(baseline);
  });

  it('vote and reaction activity each move the score independently', async () => {
    const createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const post = [{ id: 'p1', createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) }];

    configureMocks({ postRows: post, memberCount: 5, recentComments: 0, recentVotes: 0, recentReactions: 0 });
    mockFindFirst.mockResolvedValueOnce({ id: 'topic-1', createdAt });
    await updateTopicScore('topic-1');
    const baseline = mockUpdateSet.mock.calls[0][0].score;

    mockUpdateSet.mockClear();
    configureMocks({ postRows: post, memberCount: 5, recentComments: 0, recentVotes: 10, recentReactions: 0 });
    mockFindFirst.mockResolvedValueOnce({ id: 'topic-1', createdAt });
    await updateTopicScore('topic-1');
    const withVotes = mockUpdateSet.mock.calls[0][0].score;
    expect(withVotes).toBeGreaterThan(baseline);

    mockUpdateSet.mockClear();
    configureMocks({ postRows: post, memberCount: 5, recentComments: 0, recentVotes: 0, recentReactions: 10 });
    mockFindFirst.mockResolvedValueOnce({ id: 'topic-1', createdAt });
    await updateTopicScore('topic-1');
    const withReactions = mockUpdateSet.mock.calls[0][0].score;
    expect(withReactions).toBeGreaterThan(baseline);
  });

  it('weight order: post > comment > vote > reaction (one unit each)', async () => {
    // The exported weights pin the ordering contract. If anyone re-tunes
    // them, they must explicitly update this assertion.
    expect(TOPIC_SCORE_WEIGHTS.post).toBeGreaterThan(TOPIC_SCORE_WEIGHTS.comment);
    expect(TOPIC_SCORE_WEIGHTS.comment).toBeGreaterThan(TOPIC_SCORE_WEIGHTS.vote);
    expect(TOPIC_SCORE_WEIGHTS.vote).toBeGreaterThan(TOPIC_SCORE_WEIGHTS.reaction);
  });

  it('skips engagement count queries entirely when topic has zero posts (avoid empty IN(...))', async () => {
    const createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    configureMocks({ postRows: [], memberCount: 0, recentComments: 0, recentVotes: 0, recentReactions: 0 });
    mockFindFirst.mockResolvedValueOnce({ id: 'topic-empty', createdAt });

    await updateTopicScore('topic-empty');

    // select() was called only for: (1) post list, (2) member count.
    // Without skipping, we'd also see 3 more calls for comments/votes/reactions.
    expect(selectCallCount).toBe(2);
  });
});
