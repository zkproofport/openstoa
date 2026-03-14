import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topicMembers } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/[topicId]/chat/presence';

/**
 * @openapi
 * /api/topics/{topicId}/chat/presence:
 *   get:
 *     tags: [Chat]
 *     summary: Get current chat presence
 *     description: >-
 *       Returns the list of users currently connected to the topic chat.
 *       Presence is tracked via Redis HASH and updated on SSE connect/disconnect.
 *       Only topic members can query presence.
 *     operationId: getChatPresence
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Current presence list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       userId:
 *                         type: string
 *                       nickname:
 *                         type: string
 *                       profileImage:
 *                         type: string
 *                         nullable: true
 *                       connectedAt:
 *                         type: string
 *                         format: date-time
 *                 count:
 *                   type: integer
 *                   description: Number of currently connected users
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;

    const membership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (!membership) {
      logger.warn(ROUTE, 'User is not a member', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 });
    }

    const redis = getRedis();
    const presenceRaw = await redis.hgetall(`chat:presence:${topicId}`);

    const presenceUsers = Object.entries(presenceRaw).map(([userId, val]) => {
      try {
        return { userId, ...JSON.parse(val) };
      } catch {
        return { userId };
      }
    });

    logger.info(ROUTE, 'Presence fetched', { userId: session.userId, topicId, count: presenceUsers.length });
    return NextResponse.json({ users: presenceUsers, count: presenceUsers.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
