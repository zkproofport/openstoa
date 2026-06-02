import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { users, topics } from '@/lib/db/schema';
import { count } from 'drizzle-orm';

/**
 * @openapi
 * /api/stats:
 *   get:
 *     summary: Get community statistics
 *     description: |
 *       Returns a cheap, **no-auth** snapshot of OpenStoa community size: total topic count
 *       and the number of unique members (deduplicated across topics). Agents use this to
 *       surface "<n> active topics, <m> members" widgets without paginating every endpoint.
 *       Counts are read-time live — no cache layer.
 *     operationId: getCommunityStats
 *     security: []
 *     x-related-skills: [list-topics, feed]
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
