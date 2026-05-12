import { db } from '@/lib/db';
import { reactions } from '@/lib/db/schema';
import { eq, and, inArray, sql } from 'drizzle-orm';

export interface ReactionSummary {
  emoji: string;
  count: number;
  userReacted: boolean;
}

/**
 * Fetch aggregated emoji reaction summaries for a batch of posts. Returns
 * a Map from postId to its sorted (count desc) array of summaries. Posts
 * with zero reactions are simply absent from the map. When `userId` is
 * provided, each summary reflects whether that user has reacted with
 * that emoji; without a userId all `userReacted` values are false.
 *
 * Designed to be called once per list endpoint so the response can
 * inline reactions without N+1 queries per card.
 */
export async function getReactionSummariesForPosts(
  postIds: string[],
  userId: string | null,
): Promise<Map<string, ReactionSummary[]>> {
  if (postIds.length === 0) return new Map();

  const rows = userId
    ? await db
        .select({
          postId: reactions.postId,
          emoji: reactions.emoji,
          count: sql<number>`count(distinct ${reactions.userId})::int`,
          userReacted: sql<boolean>`bool_or(${reactions.userId} = ${userId})`,
        })
        .from(reactions)
        .where(inArray(reactions.postId, postIds))
        .groupBy(reactions.postId, reactions.emoji)
    : await db
        .select({
          postId: reactions.postId,
          emoji: reactions.emoji,
          count: sql<number>`count(distinct ${reactions.userId})::int`,
          userReacted: sql<boolean>`false`,
        })
        .from(reactions)
        .where(inArray(reactions.postId, postIds))
        .groupBy(reactions.postId, reactions.emoji);

  const byPost = new Map<string, ReactionSummary[]>();
  for (const r of rows) {
    const list = byPost.get(r.postId) ?? [];
    list.push({ emoji: r.emoji, count: r.count, userReacted: r.userReacted });
    byPost.set(r.postId, list);
  }
  // Sort each post's reactions by count desc for stable client rendering.
  for (const list of byPost.values()) {
    list.sort((a, b) => b.count - a.count);
  }
  return byPost;
}

/**
 * Attach reactions to an array of posts in-place. Each post gets a
 * `reactions: ReactionSummary[]` field (empty array if none). Convenient
 * wrapper for list endpoints that just need to fold the data in.
 */
export async function attachReactionsToPosts<T extends { id: string }>(
  postRows: T[],
  userId: string | null,
): Promise<Array<T & { reactions: ReactionSummary[] }>> {
  const summaries = await getReactionSummariesForPosts(
    postRows.map((p) => p.id),
    userId,
  );
  return postRows.map((p) => ({
    ...p,
    reactions: summaries.get(p.id) ?? [],
  }));
}

// Re-export commonly used drizzle helpers so callers don't need a
// separate import for them (keeps endpoint files tidy).
export { reactions, eq, and };
