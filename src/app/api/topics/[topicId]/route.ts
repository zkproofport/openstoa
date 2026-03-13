import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers } from '@/lib/db/schema';
import { eq, and, count } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/[topicId]';

/**
 * @openapi
 * /api/topics/{topicId}:
 *   get:
 *     tags: [Topics]
 *     summary: Get topic detail
 *     description: >-
 *       Returns detailed information about a topic including the current user's role.
 *       Requires topic membership.
 *     operationId: getTopic
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
 *         description: Topic detail with current user role
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 topic:
 *                   allOf:
 *                     - $ref: '#/components/schemas/Topic'
 *                     - type: object
 *                       properties:
 *                         memberCount:
 *                           type: integer
 *                           description: Number of members in the topic
 *                 currentUserRole:
 *                   type: string
 *                   enum: [owner, admin, member]
 *                   description: Current user's role in the topic
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Not a member of this topic
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
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

    logger.info(ROUTE, 'Fetching topic detail', { userId: session.userId, topicId });

    // Check membership
    const membership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (!membership) {
      logger.warn(ROUTE, 'User is not a member of this topic', { userId: session.userId, topicId });
      return NextResponse.json(
        { error: 'Not a member of this topic' },
        { status: 403 },
      );
    }

    const topic = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
    });

    if (!topic) {
      logger.warn(ROUTE, 'Topic not found', { topicId });
      return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
    }

    // Get member count
    const [memberCount] = await db
      .select({ count: count() })
      .from(topicMembers)
      .where(eq(topicMembers.topicId, topicId));

    logger.info(ROUTE, 'Topic detail fetched', { topicId, memberCount: memberCount.count });
    return NextResponse.json({
      topic: {
        ...topic,
        memberCount: memberCount.count,
      },
      currentUserRole: membership.role,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
