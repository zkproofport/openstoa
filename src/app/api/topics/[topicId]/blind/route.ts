import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/[topicId]/blind';

/**
 * @openapi
 * /api/topics/{topicId}/blind:
 *   post:
 *     tags: [Topics]
 *     summary: Blind (soft delete) or unblind a topic
 *     description: >-
 *       Toggle topic visibility. Topic owner can blind/unblind their own topic.
 *       Site admin can blind/unblind any topic. If already blinded, this unblind it (toggle).
 *       Blinded topics are hidden from listings but accessible via direct URL with a banner.
 *     operationId: blindTopic
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
 *         description: Topic blinded or unblinded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 blinded:
 *                   type: boolean
 *                   description: Whether the topic is now blinded
 *                 blindedBy:
 *                   type: string
 *                   nullable: true
 *                   enum: [owner, admin]
 *                   description: Who blinded the topic (null if unblinded)
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Not authorized to blind this topic
 *       404:
 *         description: Topic not found
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;

    const topic = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
    });

    if (!topic) {
      return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
    }

    // Check authorization: owner or site admin
    const isOwner = topic.creatorId === session.userId;

    let isAdmin = false;
    if (!isOwner) {
      const user = await db.query.users.findFirst({
        where: eq(users.id, session.userId),
      });
      isAdmin = user?.role === 'admin';
    }

    if (!isOwner && !isAdmin) {
      logger.warn(ROUTE, 'Unauthorized blind attempt', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Only the topic owner or site admin can blind a topic' }, { status: 403 });
    }

    // Toggle: if already blinded, unblind
    if (topic.blindedAt) {
      await db
        .update(topics)
        .set({ blindedAt: null, blindedBy: null })
        .where(eq(topics.id, topicId));

      logger.info(ROUTE, 'Topic unblinded', { userId: session.userId, topicId });
      return NextResponse.json({ success: true, blinded: false, blindedBy: null });
    }

    // Blind the topic
    const blindedBy = isOwner ? 'owner' : 'admin';
    await db
      .update(topics)
      .set({ blindedAt: new Date(), blindedBy })
      .where(eq(topics.id, topicId));

    logger.info(ROUTE, 'Topic blinded', { userId: session.userId, topicId, blindedBy });
    return NextResponse.json({ success: true, blinded: true, blindedBy });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
