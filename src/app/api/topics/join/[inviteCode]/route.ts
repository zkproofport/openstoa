import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/join/[inviteCode]';

/**
 * @openapi
 * /api/topics/join/{inviteCode}:
 *   get:
 *     tags: [Topics]
 *     summary: Lookup topic by invite code
 *     description: >-
 *       Looks up a topic by its invite code. Returns topic info and whether the current user is
 *       already a member. Used to show a preview before joining.
 *     operationId: lookupInviteCode
 *     parameters:
 *       - name: inviteCode
 *         in: path
 *         required: true
 *         description: 8-character invite code
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Topic found by invite code
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 topic:
 *                   type: object
 *                   description: Topic preview information
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                       description: Topic ID
 *                     title:
 *                       type: string
 *                       description: Topic title
 *                     description:
 *                       type: string
 *                       nullable: true
 *                       description: Topic description
 *                     requiresCountryProof:
 *                       type: boolean
 *                       description: Whether country proof is required to join
 *                     allowedCountries:
 *                       type: array
 *                       items:
 *                         type: string
 *                       nullable: true
 *                       description: Allowed country codes
 *                     visibility:
 *                       type: string
 *                       enum: [public, private, secret]
 *                       description: Topic visibility level
 *                 isMember:
 *                   type: boolean
 *                   description: Whether the current user is already a member
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         description: Invalid invite code
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error404'
 *   post:
 *     tags: [Topics]
 *     summary: Join topic via invite code
 *     description: >-
 *       Joins a topic via invite code. Bypasses all visibility restrictions (public, private, secret).
 *       For country-gated topics, country proof is still required.
 *     operationId: joinByInviteCode
 *     parameters:
 *       - name: inviteCode
 *         in: path
 *         required: true
 *         description: 8-character invite code
 *         schema:
 *           type: string
 *     responses:
 *       201:
 *         description: Successfully joined the topic
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                   description: Join success indicator
 *                 topicId:
 *                   type: string
 *                   description: ID of the joined topic
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       404:
 *         description: Invalid invite code
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error404'
 *       409:
 *         description: Already a member of this topic
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error409'
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ inviteCode: string }> },
) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { inviteCode } = await params;

    logger.info(ROUTE, 'Looking up invite code', { userId: session.userId, inviteCode });

    const topic = await db.query.topics.findFirst({
      where: eq(topics.inviteCode, inviteCode),
    });

    if (!topic) {
      logger.warn(ROUTE, 'Invalid invite code', { inviteCode });
      return NextResponse.json(
        { error: 'Invalid invite code' },
        { status: 404 },
      );
    }

    const membership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topic.id),
        eq(topicMembers.userId, session.userId),
      ),
    });

    logger.info(ROUTE, 'Invite code resolved', { userId: session.userId, topicId: topic.id, isMember: !!membership });

    return NextResponse.json({
      topic: {
        id: topic.id,
        title: topic.title,
        description: topic.description,
        requiresCountryProof: topic.requiresCountryProof,
        allowedCountries: topic.allowedCountries,
        visibility: topic.visibility,
      },
      isMember: !!membership,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ inviteCode: string }> },
) {
  logger.info(ROUTE, 'POST request received (invite code join)');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { inviteCode } = await params;

    const topic = await db.query.topics.findFirst({
      where: eq(topics.inviteCode, inviteCode),
    });

    if (!topic) {
      logger.warn(ROUTE, 'Invalid invite code', { inviteCode });
      return NextResponse.json({ error: 'Invalid invite code' }, { status: 404 });
    }

    // Check if already a member
    const existingMembership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topic.id),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (existingMembership) {
      logger.warn(ROUTE, 'User already a member', { userId: session.userId, topicId: topic.id });
      return NextResponse.json({ error: 'Already a member of this topic' }, { status: 409 });
    }

    // Invite code bypasses visibility restrictions (works for public, private, and secret)
    await db.insert(topicMembers).values({
      topicId: topic.id,
      userId: session.userId,
      role: 'member',
    });

    logger.info(ROUTE, 'User joined topic via invite code', { userId: session.userId, topicId: topic.id, visibility: topic.visibility });
    return NextResponse.json({ success: true, topicId: topic.id }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
