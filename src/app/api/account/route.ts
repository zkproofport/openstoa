import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { users, topicMembers, topics, bookmarks } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { cookies } from 'next/headers';

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
  if (ownSpace) {
    await db.delete(topicMembers).where(eq(topicMembers.topicId, ownSpace.id));
    await db.delete(topics).where(eq(topics.id, ownSpace.id));
    logger.info(ROUTE, 'DELETE account: removed the personal space', { userId, topicId: ownSpace.id });
  }

  // 4. Delete topic memberships
  await db.delete(topicMembers).where(eq(topicMembers.userId, userId));
  logger.info(ROUTE, 'DELETE account: deleted topic memberships', { userId });

  // 4. Delete user's bookmarks
  await db.delete(bookmarks).where(eq(bookmarks.userId, userId));
  logger.info(ROUTE, 'DELETE account: deleted user bookmarks', { userId });

  // 5. Anonymize user record (keep posts/comments/votes intact)
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  await db.update(users).set({
    nickname: `[Withdrawn User]_${randomSuffix}`,
    deletedAt: new Date(),
  }).where(eq(users.id, userId));
  logger.info(ROUTE, 'DELETE account: user record anonymized', { userId });

  // 6. Clear session cookie
  const cookieStore = await cookies();
  cookieStore.delete('session');

  return NextResponse.json({ success: true });
}
