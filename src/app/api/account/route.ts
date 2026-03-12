import { NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/lib/session';
import { db } from '@/lib/db';
import { users, topicMembers, topics, votes, bookmarks } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { cookies } from 'next/headers';

const ROUTE = '/api/account';

export async function DELETE() {
  // 1. Auth check
  const session = await getSessionFromCookies();
  if (!session) {
    logger.warn(ROUTE, 'DELETE account: unauthenticated');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.userId;
  logger.info(ROUTE, 'DELETE account: starting anonymization', { userId });

  // 2. Check if user owns any topics
  const ownedTopics = await db
    .select({ id: topics.id, title: topics.title })
    .from(topics)
    .where(eq(topics.creatorId, userId));

  if (ownedTopics.length > 0) {
    logger.warn(ROUTE, 'DELETE account: user owns topics, blocking deletion', { userId, topicCount: ownedTopics.length });
    return NextResponse.json(
      { error: 'Must transfer topic ownership before deletion', topics: ownedTopics },
      { status: 409 }
    );
  }

  // 3. Delete topic memberships
  await db.delete(topicMembers).where(eq(topicMembers.userId, userId));
  logger.info(ROUTE, 'DELETE account: deleted topic memberships', { userId });

  // 4. Delete user's votes
  await db.delete(votes).where(eq(votes.userId, userId));
  logger.info(ROUTE, 'DELETE account: deleted user votes', { userId });

  // 5. Delete user's bookmarks
  await db.delete(bookmarks).where(eq(bookmarks.userId, userId));
  logger.info(ROUTE, 'DELETE account: deleted user bookmarks', { userId });

  // 6. Anonymize user record (keep posts/comments intact)
  const randomSuffix = Math.random().toString(36).slice(2, 10);
  await db.update(users).set({
    nickname: `[Withdrawn User]_${randomSuffix}`,
    deletedAt: new Date(),
  }).where(eq(users.id, userId));
  logger.info(ROUTE, 'DELETE account: user record anonymized', { userId });

  // 7. Clear session cookie
  const cookieStore = await cookies();
  cookieStore.delete('session');

  return NextResponse.json({ success: true });
}
