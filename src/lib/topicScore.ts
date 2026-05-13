import { db } from '@/lib/db';
import { topics, posts, topicMembers, comments, votes, reactions } from '@/lib/db/schema';
import { eq, and, gte, sql, inArray } from 'drizzle-orm';

/**
 * Weights for the 7-day rolling activity terms. A new post moves the
 * score the most (it's the seed for everything else), then comments,
 * then upvotes/downvotes, then reactions.
 *
 * Touch these only with a story — they directly affect `sort=hot` ordering
 * on the topic list and will reshuffle every topic in production.
 */
const WEIGHTS = {
  member: 2,
  post: 3,
  comment: 1,
  vote: 0.5,
  reaction: 0.3,
  ageDecayBoost: 10,
} as const;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function updateTopicScore(topicId: string) {
  const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS_MS);

  // Gather the post id set for this topic once — comments / votes /
  // reactions all key off post id, not topic id, so we need an IN(...)
  // filter to scope them to this topic.
  const topicPostRows = await db
    .select({ id: posts.id, createdAt: posts.createdAt })
    .from(posts)
    .where(eq(posts.topicId, topicId));
  const topicPostIds = topicPostRows.map((r) => r.id);

  const recentPosts = topicPostRows.filter(
    (r) => r.createdAt && r.createdAt.getTime() >= sevenDaysAgo.getTime(),
  ).length;

  // Count members
  const [{ count: memberCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(topicMembers)
    .where(eq(topicMembers.topicId, topicId));

  // Recent comments / votes / reactions scoped to this topic's posts.
  // Skip the query entirely when there are no posts to avoid an IN()
  // against an empty array (which some drivers reject).
  let recentComments = 0;
  let recentVotes = 0;
  let recentReactions = 0;
  if (topicPostIds.length > 0) {
    const [c, v, r] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(comments)
        .where(and(inArray(comments.postId, topicPostIds), gte(comments.createdAt, sevenDaysAgo))),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(votes)
        .where(and(inArray(votes.postId, topicPostIds), gte(votes.createdAt, sevenDaysAgo))),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(reactions)
        .where(and(inArray(reactions.postId, topicPostIds), gte(reactions.createdAt, sevenDaysAgo))),
    ]);
    recentComments = c[0].count;
    recentVotes = v[0].count;
    recentReactions = r[0].count;
  }

  // Get topic creation date for time decay
  const topic = await db.query.topics.findFirst({ where: eq(topics.id, topicId) });
  if (!topic) return;

  const ageDays = (Date.now() - new Date(topic.createdAt!).getTime()) / (1000 * 60 * 60 * 24);
  const timeDecay = Math.log2(ageDays + 2);

  const score =
    memberCount * WEIGHTS.member +
    recentPosts * WEIGHTS.post +
    recentComments * WEIGHTS.comment +
    recentVotes * WEIGHTS.vote +
    recentReactions * WEIGHTS.reaction +
    (1 / timeDecay) * WEIGHTS.ageDecayBoost;

  await db.update(topics).set({
    score,
    lastActivityAt: new Date(),
  }).where(eq(topics.id, topicId));
}

export const TOPIC_SCORE_WEIGHTS = WEIGHTS;

