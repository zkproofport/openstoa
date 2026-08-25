import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { users, topics } from '@/lib/db/schema';
import { and, count, eq } from 'drizzle-orm';

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

  /*
   * Community topics only — not every row in the table.
   *
   * This number is read as "how big is this place", so it has to count the
   * things a reader could actually go and find. Two kinds of row are not that:
   * a DM is a private 1:1 channel modelled as a hidden topic, and a personal
   * space is one secret topic per ACCOUNT that nobody but its owner can enter.
   *
   * Unfiltered, the count drifts with the user base rather than with the
   * community: measured here at 916 rows for 261 real topics — 623 personal
   * spaces and 32 DMs — so the headline was more than triple the truth and
   * would keep climbing with every signup.
   */
  const [topicResult] = await db
    .select({ count: count() })
    .from(topics)
    .where(and(eq(topics.kind, 'topic'), eq(topics.personal, false)));
  const [memberResult] = await db.select({ count: count() }).from(users);

  return NextResponse.json({
    totalTopics: topicResult.count,
    totalMembers: memberResult.count,
  });
}
