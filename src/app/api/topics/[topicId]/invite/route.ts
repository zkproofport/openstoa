import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers, inviteTokens } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import crypto from 'crypto';

const ROUTE = '/api/topics/[topicId]/invite';

/**
 * @openapi
 * /api/topics/{topicId}/invite:
 *   post:
 *     tags: [Topics]
 *     summary: Generate a single-use invite token
 *     description: >-
 *       Generates a single-use invite token for the topic. Only topic members can generate tokens.
 *       The token expires in 7 days and can only be used once.
 *     operationId: generateInviteToken
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       201:
 *         description: Invite token generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: Single-use invite token (16-char hex)
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                   description: Token expiry time (7 days from now)
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;

    const topic = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
    });

    if (!topic) {
      logger.warn(ROUTE, 'Topic not found', { topicId });
      return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
    }

    // Only members can generate invite tokens
    const membership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (!membership) {
      logger.warn(ROUTE, 'Non-member attempted to generate invite token', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 });
    }

    const token = crypto.randomBytes(8).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await db.insert(inviteTokens).values({
      topicId,
      token,
      createdBy: session.userId,
      expiresAt,
    });

    logger.info(ROUTE, 'Invite token generated', { userId: session.userId, topicId });
    return NextResponse.json({ token, expiresAt }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
