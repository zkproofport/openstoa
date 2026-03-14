import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { users, topics } from '@/lib/db/schema';
import { count } from 'drizzle-orm';

/**
 * @openapi
 * /api/stats:
 *   get:
 *     summary: Get community statistics
 *     description: Returns total number of topics and unique members.
 *     operationId: getCommunityStats
 *     security: []
 *     responses:
 *       200:
 *         description: Community statistics
 */
export async function GET() {
  const db = getDb();

  const [topicResult] = await db.select({ count: count() }).from(topics);
  const [memberResult] = await db.select({ count: count() }).from(users);

  return NextResponse.json({
    totalTopics: topicResult.count,
    totalMembers: memberResult.count,
  });
}
