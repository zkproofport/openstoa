import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { users, topicMembers, topics, bookmarks } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { cookies } from 'next/headers';
import { deleteTopicRows, type TopicRowDeleter } from '@/lib/deleteTopicRows';
import { deleteR2Prefix, topicObjectPrefix } from '@/lib/r2';

const ROUTE = '/api/account';

/**
 * @openapi
 * /api/account:
 *   delete:
 *     tags: [Account]
 *     summary: Delete user account
 *     description: >-
 *       Permanently deletes the user account. Anonymizes the user's nickname to '[Withdrawn User]_<random>',
 *       sets deletedAt, removes all memberships and bookmarks, and clears the session. Posts, comments,
 *       and votes are preserved (orphaned) to maintain upvoteCount integrity. Fails if the user owns any topics (must transfer ownership first).
 *     operationId: deleteAccount
 *     x-related-skills: [auth-details, change-member-role]
 *     responses:
 *       200:
 *         description: Account deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                   description: Deletion success indicator
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       409:
 *         description: User owns topics — must transfer ownership first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   description: Error message explaining the conflict
 *                 topics:
 *                   type: array
 *                   description: List of topics the user owns
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         description: Topic ID
 *                       title:
 *                         type: string
 *                         description: Topic title
 */
export async function DELETE(request: NextRequest) {
  // 1. Auth check
  const session = await getSession(request);
  if (!session) {
    logger.warn(ROUTE, 'DELETE account: unauthenticated');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.userId;
  logger.info(ROUTE, 'DELETE account: starting anonymization', { userId });

  /*
   * 2. Check if user owns any topics — except their own space.
   *
   * The rule is about people left behind: a community topic whose owner walks
   * away strands everyone still in it, so ownership has to be handed over
   * first. A PERSONAL space has nobody in it but the person leaving, and
   * nobody it could be handed to, so applying the rule there refuses every
   * account deletion in the product — which is what it did the moment personal
   * spaces existed. It goes with the account instead, below.
   */
  const ownedTopics = await db
    .select({ id: topics.id, title: topics.title })
    .from(topics)
    .where(and(eq(topics.creatorId, userId), eq(topics.personal, false)));

  if (ownedTopics.length > 0) {
    logger.warn(ROUTE, 'DELETE account: user owns topics, blocking deletion', { userId, topicCount: ownedTopics.length });
    return NextResponse.json(
      { error: 'Must transfer topic ownership before deletion', topics: ownedTopics },
      { status: 409 }
    );
  }

  /*
   * 3. The personal space goes with the account.
   *
   * Leaving the row would keep a secret topic alive with no members and no way
   * to reach it, and — because the unique index is on `(creator_id) where
   * personal` — it would also block this account from ever getting a fresh
   * space if the same nullifier signed in again.
   *
   * Deleted BEFORE the memberships so the membership row that points at it is
   * still there to be cleaned up by the same sweep. Its posts and chat rows go
   * with it: unlike a community topic, there is no one else whose reading of
   * this history is being taken away.
   */
  const [ownSpace] = await db
    .select({ id: topics.id })
    .from(topics)
    .where(and(eq(topics.creatorId, userId), eq(topics.personal, true)));

  /*
   * 4. One transaction, or none of it.
   *
   * This used to be five separate statements. In production on 2026-08-29 the
   * space deletion failed on a foreign key, and because nothing was wrapped,
   * the membership row deleted a line earlier stayed deleted: the account was
   * left owning a space it was not a member of, and every retry failed the
   * same way. Half-dismantling an account is worse than refusing to.
   */
  await db.transaction(async (tx) => {
    if (ownSpace) {
      /*
       * The space's own rows — chat, archive, MLS state — have to go before the
       * space can. That order is `deleteTopicRows`, shared with topic deletion,
       * because deleting the space by hand here is precisely what was missing.
       *
       * Only THIS person's space. Messages they wrote in other people's rooms
       * are left exactly where they are: the account is anonymised, not erased
       * from other people's conversations.
       */
      await deleteTopicRows(tx as unknown as TopicRowDeleter, ownSpace.id);
      await tx.delete(topics).where(eq(topics.id, ownSpace.id));
    }

    // Memberships in everyone else's rooms.
    await tx.delete(topicMembers).where(eq(topicMembers.userId, userId));

    await tx.delete(bookmarks).where(eq(bookmarks.userId, userId));

    /*
     * The row survives, anonymised, so posts, comments and votes still resolve
     * to an author and upvote counts stay honest — but it MUST STOP ANSWERING
     * TO THE NULLIFIER, or leaving is not leaving.
     *
     * The row's id IS the nullifier from the proof, and sign-in looks the
     * account up by exactly that. So an anonymised row still matched the next
     * sign-in with the same proof: the person came back to their own withdrawn
     * account, carrying the name `[Withdrawn User]_…`, with the personal space
     * recreated around them. Seen on a real device on 2026-08-29, minutes after
     * a deletion that had reported success.
     *
     * Retiring the id is what releases the identity. The nullifier is still
     * derivable from the retired id — it has to be, or the same proof could
     * withdraw twice into colliding ids — but nothing looks the account up that
     * way, so the next sign-in finds no row and builds a fresh account.
     *
     * The 31 columns that point at this row follow the rename themselves: every
     * foreign key into `users` now carries ON UPDATE CASCADE. Without it this
     * single UPDATE fails against all of them and the whole deletion rolls
     * back.
     *
     * The name is released too. Nicknames are unique, so keeping the withdrawn
     * one would quietly deny it to everyone, including the same person coming
     * back.
     */
    const retiredAt = Date.now();
    await tx.update(users).set({
      id: `withdrawn:${retiredAt}:${userId}`,
      nickname: `[Withdrawn User]_${retiredAt.toString(36)}`,
      deletedAt: new Date(retiredAt),
    }).where(eq(users.id, userId));
  });

  logger.info(ROUTE, 'DELETE account: rows removed and user anonymized', {
    userId,
    personalSpaceId: ownSpace?.id ?? null,
  });

  /*
   * 5. The space's stored objects. Storage is outside the transaction's reach,
   * and best-effort by design: the account IS gone, and failing now would tell
   * the person otherwise.
   */
  if (ownSpace) {
    try {
      const swept = await deleteR2Prefix(topicObjectPrefix(ownSpace.id));
      logger.info(ROUTE, 'DELETE account: swept the personal space objects', { userId, swept });
    } catch (err) {
      logger.warn(ROUTE, 'DELETE account: object sweep failed, rows already gone', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 6. Clear session cookie
  const cookieStore = await cookies();
  cookieStore.delete('session');

  return NextResponse.json({ success: true });
}
