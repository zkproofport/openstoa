import { db } from '@/lib/db';
import { topics, posts, topicMembers } from '@/lib/db/schema';
import { eq, and, gte, sql } from 'drizzle-orm';

export async function updateTopicScore(topicId: string) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Count recent posts (7 days)
  const [{ count: recentPosts }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(posts)
    .where(and(eq(posts.topicId, topicId), gte(posts.createdAt, sevenDaysAgo)));

  // Count members
  const [{ count: memberCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(topicMembers)
    .where(eq(topicMembers.topicId, topicId));

  // Get topic creation date for time decay
  const topic = await db.query.topics.findFirst({ where: eq(topics.id, topicId) });
  if (!topic) return;

  const ageDays = (Date.now() - new Date(topic.createdAt!).getTime()) / (1000 * 60 * 60 * 24);
  const timeDecay = Math.log2(ageDays + 2);

  const score = (memberCount * 2) + (recentPosts * 3) + (1 / timeDecay) * 10;

  await db.update(topics).set({
    score,
    lastActivityAt: new Date(),
  }).where(eq(topics.id, topicId));
}
