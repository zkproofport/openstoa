// Note: this file actually houses poll helpers — the video URL helpers
// live in `./videoUrls.ts`. Keep the imports tight so polls don't drag in
// unrelated regex helpers.
import { db } from './db';
import { polls, pollOptions, pollVotes } from './db/schema';
import { eq, inArray, sql } from 'drizzle-orm';

// Web-side mirrors of the @openstoa/api-types `Poll` / `PollOption` shapes.
// The Next.js app doesn't pull that package in, but the mobile mini-app
// does — keep these definitions in lockstep so the wire format stays
// consistent across web and mobile clients.
export interface PollOption {
  id: string;
  text: string;
  position: number;
  voteCount: number;
}

export interface Poll {
  id: string;
  postId: string;
  question?: string | null;
  multipleChoice: boolean;
  closesAt?: string | null;
  options: PollOption[];
  totalVotes: number;
  userVotedOptionIds: string[];
  isClosed: boolean;
}

interface PostLike {
  id: string;
  poll?: Poll | null;
}

/**
 * Batch-load polls for a set of post IDs and the current user's vote
 * positions. Used by feed / topic-list / profile-list endpoints so a single
 * round-trip hydrates every post's poll block.
 *
 * @param userId  When present, populates `userVotedOptionIds`. Guests get
 *                empty arrays.
 * @returns       Map keyed by `postId → Poll`. Posts without a poll are
 *                absent from the map (caller treats absence as "no poll").
 */
export async function loadPollsForPosts(
  postIds: string[],
  userId: string | null,
): Promise<Map<string, Poll>> {
  const out = new Map<string, Poll>();
  if (postIds.length === 0) return out;

  const pollRows = await db
    .select({
      id: polls.id,
      postId: polls.postId,
      question: polls.question,
      multipleChoice: polls.multipleChoice,
      closesAt: polls.closesAt,
    })
    .from(polls)
    .where(inArray(polls.postId, postIds));
  if (pollRows.length === 0) return out;

  const pollIds = pollRows.map((p) => p.id);
  const optionRows = await db
    .select({
      id: pollOptions.id,
      pollId: pollOptions.pollId,
      text: pollOptions.text,
      position: pollOptions.position,
    })
    .from(pollOptions)
    .where(inArray(pollOptions.pollId, pollIds));

  const voteCountRows = await db
    .select({
      optionId: pollVotes.optionId,
      count: sql<number>`count(*)::int`,
    })
    .from(pollVotes)
    .where(inArray(pollVotes.pollId, pollIds))
    .groupBy(pollVotes.optionId);

  const voteCountByOption = new Map<string, number>();
  for (const r of voteCountRows) voteCountByOption.set(r.optionId, Number(r.count));

  const userVotesByPoll = new Map<string, string[]>();
  if (userId) {
    const userVoteRows = await db
      .select({ pollId: pollVotes.pollId, optionId: pollVotes.optionId })
      .from(pollVotes)
      .where(inArray(pollVotes.pollId, pollIds));
    for (const r of userVoteRows) {
      // Filter to current user only — `inArray` already narrowed the polls,
      // but we still need to drop other users' rows here. The user-scoped
      // query could also use a WHERE on userId; keeping the broader fetch
      // makes the optionCount and userVote queries reuse the same plan.
    }
    // Re-fetch user's own votes specifically — cheaper than client-side filter.
    const myVotes = await db
      .select({ pollId: pollVotes.pollId, optionId: pollVotes.optionId })
      .from(pollVotes)
      .where(
        sql`${pollVotes.pollId} IN ${pollIds} AND ${pollVotes.userId} = ${userId}`,
      );
    for (const r of myVotes) {
      const arr = userVotesByPoll.get(r.pollId) ?? [];
      arr.push(r.optionId);
      userVotesByPoll.set(r.pollId, arr);
    }
  }

  const optionsByPoll = new Map<string, PollOption[]>();
  for (const o of optionRows) {
    const arr = optionsByPoll.get(o.pollId) ?? [];
    arr.push({
      id: o.id,
      text: o.text,
      position: o.position,
      voteCount: voteCountByOption.get(o.id) ?? 0,
    });
    optionsByPoll.set(o.pollId, arr);
  }

  const now = Date.now();
  for (const p of pollRows) {
    const opts = (optionsByPoll.get(p.id) ?? []).sort((a, b) => a.position - b.position);
    const totalVotes = opts.reduce((s, o) => s + o.voteCount, 0);
    const isClosed = p.closesAt ? new Date(p.closesAt).getTime() < now : false;
    out.set(p.postId, {
      id: p.id,
      postId: p.postId,
      question: p.question,
      multipleChoice: p.multipleChoice,
      closesAt: p.closesAt ? new Date(p.closesAt).toISOString() : null,
      options: opts,
      totalVotes,
      userVotedOptionIds: userVotesByPoll.get(p.id) ?? [],
      isClosed,
    });
  }

  return out;
}

/**
 * Mutates the given post array in place, attaching `.poll` to each post that
 * has one. Posts without a poll keep `poll: undefined` (which serialises as
 * absent).
 */
export async function attachPollsToPosts<T extends PostLike>(
  posts: T[],
  userId: string | null,
): Promise<void> {
  if (posts.length === 0) return;
  const pollMap = await loadPollsForPosts(
    posts.map((p) => p.id),
    userId,
  );
  for (const post of posts) {
    const poll = pollMap.get(post.id);
    if (poll) post.poll = poll;
  }
}

/**
 * Persist a new poll for a post. Validates option count (2-4), text length
 * (≤80 chars), and optional `closesAt` (must be in the future).
 */
export async function createPollForPost(
  postId: string,
  input: { question?: string; options: string[]; multipleChoice?: boolean; closesAt?: string },
): Promise<void> {
  const opts = (input.options ?? [])
    .map((o) => (typeof o === 'string' ? o.trim() : ''))
    .filter((o) => o.length > 0 && o.length <= 80);
  if (opts.length < 2 || opts.length > 4) {
    throw new Error('Poll must have 2 to 4 options');
  }
  const closesAt = input.closesAt ? new Date(input.closesAt) : null;
  if (closesAt && (Number.isNaN(closesAt.getTime()) || closesAt.getTime() <= Date.now())) {
    throw new Error('Poll closesAt must be a future ISO timestamp');
  }

  const [poll] = await db
    .insert(polls)
    .values({
      postId,
      question: input.question?.trim() || null,
      multipleChoice: !!input.multipleChoice,
      closesAt,
    })
    .returning();

  await db.insert(pollOptions).values(
    opts.map((text, i) => ({ pollId: poll.id, text, position: i })),
  );
}

export async function getPollByPostId(postId: string): Promise<{
  id: string;
  multipleChoice: boolean;
  closesAt: Date | null;
} | null> {
  const [row] = await db
    .select({ id: polls.id, multipleChoice: polls.multipleChoice, closesAt: polls.closesAt })
    .from(polls)
    .where(eq(polls.postId, postId))
    .limit(1);
  return row ?? null;
}
