/**
 * Deleting a topic means deleting eighteen other things first.
 *
 * `topics` is referenced by eighteen foreign keys and only six of them cascade.
 * The other twelve — chat messages, the archive, MLS group state, posts — hold
 * the row down, and the final `delete(topics)` fails with a foreign-key
 * violation. Inside a transaction that means the whole thing rolls back and the
 * caller sees a 500 with nothing to explain it.
 *
 * This has now happened twice, both times the same way: a table was added that
 * points at `topics`, and one caller was updated while the other was not.
 *
 *   - Deleting a topic that had ever been chatted in failed, because the
 *     end-to-end-encryption tables were added after that handler was written.
 *     Fixed there, in that handler.
 *   - Deleting an ACCOUNT then failed for exactly the same reason, because the
 *     account handler deletes the person's own space and nobody carried the
 *     fix across. Confirmed in production on 2026-08-29: the membership row was
 *     deleted, the space was not, and the account was left half-dismantled with
 *     no way to finish.
 *
 * So the order lives here, once, and both callers use it. A table added to the
 * schema still has to be added below — but there is one place to add it, and
 * the test that counts the non-cascading foreign keys fails until it is there.
 *
 * The caller supplies the transaction. Deleting a topic is never the whole of
 * what a caller is doing, and the rest of its work has to roll back with this.
 */
import { eq, inArray } from 'drizzle-orm';
import {
  topics,
  topicMembers,
  posts,
  comments,
  records,
  chatMedia,
  chatMessages,
  joinRequests,
  mlsGroups,
  mlsCommits,
  takBundles,
  chatArchive,
  archiveHolders,
  keyRequests,
} from '@/lib/db/schema';

/**
 * Anything that can run a query: the real transaction handle, or a test double.
 * Typing this as the concrete Drizzle transaction would drag the whole schema
 * generic through every caller for no benefit — the only thing used here is
 * `delete(...).where(...)` and `select(...).from(...).where(...)`.
 */
export interface TopicRowDeleter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete: (table: any) => { where: (cond: any) => Promise<unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select: (fields: any) => { from: (table: any) => { where: (cond: any) => Promise<any[]> } };
}

/**
 * Every row that must go before `topics` itself can, in the order the foreign
 * keys demand. Does NOT delete the topic — the caller does that, so it stays
 * obvious at the call site that the topic is going away.
 *
 * Storage objects are a separate world a transaction cannot reach; the caller
 * sweeps those after it commits.
 */
export async function deleteTopicRows(tx: TopicRowDeleter, topicId: string): Promise<number> {
  // Post-level rows that do not cascade have to go before the posts do.
  const topicPosts = await tx
    .select({ id: posts.id })
    .from(posts)
    .where(eq(posts.topicId, topicId));
  const postIds = topicPosts.map((p: { id: string }) => p.id);

  if (postIds.length > 0) {
    await tx.delete(comments).where(inArray(comments.postId, postIds));
    await tx.delete(records).where(inArray(records.postId, postIds));
    // Posts cascade to polls, postTags, bookmarks, reactions and votes.
    await tx.delete(posts).where(eq(posts.topicId, topicId));
  }

  await tx.delete(chatMessages).where(eq(chatMessages.topicId, topicId));
  // The attachment index goes with the topic; the objects it points at are
  // removed by the caller's prefix sweep, which needs no index at all.
  await tx.delete(chatMedia).where(eq(chatMedia.topicId, topicId));

  await tx.delete(chatArchive).where(eq(chatArchive.topicId, topicId));
  await tx.delete(archiveHolders).where(eq(archiveHolders.topicId, topicId));
  await tx.delete(takBundles).where(eq(takBundles.topicId, topicId));

  // Asks for keys in a room that will not exist have nothing to answer.
  await tx.delete(keyRequests).where(eq(keyRequests.topicId, topicId));
  // Commits before the group: a commit belongs to the group it advanced.
  await tx.delete(mlsCommits).where(eq(mlsCommits.topicId, topicId));
  await tx.delete(mlsGroups).where(eq(mlsGroups.topicId, topicId));

  await tx.delete(joinRequests).where(eq(joinRequests.topicId, topicId));
  await tx.delete(topicMembers).where(eq(topicMembers.topicId, topicId));

  // Deliberately absent, because these DO cascade with the topic:
  // chatDeliveryCursors, chatReads, pushTopicMutes, mlsDeviceJoins,
  // topicArchiveRoots, inviteTokens.

  return postIds.length;
}
