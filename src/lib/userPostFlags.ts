import { db } from '@/lib/db';
import { bookmarks, records } from '@/lib/db/schema';
import { eq, and, inArray } from 'drizzle-orm';

/**
 * Resolves which posts in a batch are currently bookmarked / recorded
 * by the given user, returning two Sets for O(1) lookup. Designed for
 * list endpoints (feed, topic posts, my/*) so they can stamp the
 * boolean flags without an N+1 query per row.
 *
 * If `userId` is null (guest) both sets are empty.
 */
async function getUserPostFlagSets(
  postIds: string[],
  userId: string | null,
): Promise<{ bookmarked: Set<string>; recorded: Set<string> }> {
  if (!userId || postIds.length === 0) {
    return { bookmarked: new Set(), recorded: new Set() };
  }
  const [bRows, rRows] = await Promise.all([
    db
      .select({ postId: bookmarks.postId })
      .from(bookmarks)
      .where(and(eq(bookmarks.userId, userId), inArray(bookmarks.postId, postIds))),
    db
      .select({ postId: records.postId })
      .from(records)
      .where(
        and(eq(records.recorderNullifier, userId), inArray(records.postId, postIds)),
      ),
  ]);
  return {
    bookmarked: new Set(bRows.map((r) => r.postId)),
    recorded: new Set(rRows.map((r) => r.postId)),
  };
}

/**
 * Stamp `userBookmarked` and `userRecorded` on a list of posts in a
 * single batched pass. Drop-in wrapper for list endpoints.
 */
export async function attachUserFlagsToPosts<T extends { id: string }>(
  postRows: T[],
  userId: string | null,
): Promise<Array<T & { userBookmarked: boolean; userRecorded: boolean }>> {
  const { bookmarked, recorded } = await getUserPostFlagSets(
    postRows.map((p) => p.id),
    userId,
  );
  return postRows.map((p) => ({
    ...p,
    userBookmarked: bookmarked.has(p.id),
    userRecorded: recorded.has(p.id),
  }));
}
