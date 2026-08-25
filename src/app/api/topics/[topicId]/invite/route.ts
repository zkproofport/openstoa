import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers, inviteTokens } from '@/lib/db/schema';
import { resolveInviteExpiry } from '@/lib/inviteExpiry';
import { eq, and } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { isValidUUID } from '@/lib/uuid';
import crypto from 'crypto';
import { PERSONAL_TOPIC_CLOSED } from '@/lib/personalTopic';

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
 *     x-related-skills: [join-by-invite-code, lookup-invite-code]
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
    if (!isValidUUID(topicId)) {
      return NextResponse.json({ error: 'Invalid topicId' }, { status: 400 });
    }

    const topic = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
    });

    if (!topic) {
      logger.warn(ROUTE, 'Topic not found', { topicId });
      return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
    }

    // Only members can generate invite tokens
    /*
     * A personal space has no doors. Refused here rather than hidden in the
     * client: a button that is merely not drawn is still a route anyone can
     * call, and what is behind this one is somebody's private space.
     */
    if (topic.personal) {
      return NextResponse.json({ error: PERSONAL_TOPIC_CLOSED }, { status: 403 });
    }

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

    /*
     * Who may hand out a way in.
     *
     * Any member could, which is defensible for a public topic and is not for
     * the others: an invite bypasses visibility entirely, so on a secret topic
     * one member could quietly admit anyone, past the very property that makes
     * the tier a tier. Whoever runs the topic decides who joins it.
     */
    const canInvite = topic.visibility === 'public' || membership.role === 'owner' || membership.role === 'admin';
    if (!canInvite) {
      logger.warn(ROUTE, 'Member without invite rights attempted to generate a token', {
        userId: session.userId,
        topicId,
        visibility: topic.visibility,
        role: membership.role,
      });
      return NextResponse.json(
        { error: 'Only the topic owner or an admin can invite to this topic' },
        { status: 403 },
      );
    }

    const body = await request.json().catch(() => ({}));
    // The lifetime belongs to whoever runs the topic: they know whether this
    // link goes to one person now or sits in a channel for a month.
    const expiry = resolveInviteExpiry((body as { expiresInHours?: unknown })?.expiresInHours, new Date());
    if (!expiry.ok) {
      logger.warn(ROUTE, 'Invalid invite expiry', { userId: session.userId, topicId, error: expiry.error });
      return NextResponse.json({ error: expiry.error }, { status: 400 });
    }

    const token = crypto.randomBytes(8).toString('hex');

    await db.insert(inviteTokens).values({
      topicId,
      token,
      createdBy: session.userId,
      expiresAt: expiry.expiresAt,
    });

    logger.info(ROUTE, 'Invite token generated', {
      userId: session.userId,
      topicId,
      expiresAt: expiry.expiresAt.toISOString(),
    });
    return NextResponse.json({ token, expiresAt: expiry.expiresAt }, { status: 201 });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
