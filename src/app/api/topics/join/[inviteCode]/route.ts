import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers, inviteTokens } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { broadcastMembershipSystemEvent } from '@/lib/chat';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';

const ROUTE = '/api/topics/join/[inviteCode]';

/**
 * @openapi
 * /api/topics/join/{inviteCode}:
 *   get:
 *     tags: [Topics]
 *     summary: Lookup topic by invite code
 *     description: |
 *       Looks up a topic by its invite code, before joining it.
 *
 *       **Read the gate before you try the door.** The response carries
 *       `requiresCountryProof` and, when that is true, the `allowedCountries` the topic
 *       accepts (ISO 3166-1 alpha-2). A caller that posts to the join endpoint without the
 *       matching proof is refused, and the refusal does not say which countries would have
 *       worked — this lookup is where that is knowable. Generate the proof first: see
 *       `topic-proofs`.
 *
 *       `isMember` says whether the caller is already in, so a preview can offer "open"
 *       rather than "join" and a repeat join can be skipped entirely.
 *     operationId: lookupInviteCode
 *     x-related-skills: [join-by-invite-code, generate-invite-token, topic-proofs]
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
 *     description: |
 *       Joins a topic via an 8-character invite code. **Bypasses visibility restrictions** —
 *       works on public, private, AND secret topics. Proof gates are NOT bypassed: if the topic
 *       has a `proofType` (country / kyc / workspace), the matching ZK proof is still required
 *       in the body (same shape as `POST /api/topics/{topicId}/join`). Use this for one-tap join
 *       links shared via DM.
 *     operationId: joinByInviteCode
 *     x-related-skills: [lookup-invite-code, join-topic, generate-invite-token, topic-proofs]
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

    // Check fixed inviteCode first, then single-use tokens
    let topic = await db.query.topics.findFirst({
      where: eq(topics.inviteCode, inviteCode),
    });

    if (!topic) {
      // Try single-use invite token
      const now = new Date();
      const token = await db.query.inviteTokens.findFirst({
        where: eq(inviteTokens.token, inviteCode),
      });
      if (token && !token.usedBy && token.expiresAt > now) {
        topic = await db.query.topics.findFirst({
          where: eq(topics.id, token.topicId),
        });
      }
    }

    /*
     * A personal space stores an invite code because the column is NOT NULL,
     * never because it is meant to admit anyone. Treated as NO SUCH INVITE
     * rather than as a refusal: a 403 would confirm the code maps to a real
     * topic, and someone probing codes would learn that an account exists and
     * which code belongs to it. "Invalid invite code" is both truthful — it is
     * not a valid invite — and silent.
     */
    if (topic?.personal) topic = undefined;

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
    return unhandledRouteError(ROUTE, 'GET', error);
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

    // Check fixed inviteCode first, then single-use tokens
    let topic = await db.query.topics.findFirst({
      where: eq(topics.inviteCode, inviteCode),
    });

    let singleUseTokenId: string | null = null;

    if (!topic) {
      // Try single-use invite token
      const now = new Date();
      const token = await db.query.inviteTokens.findFirst({
        where: eq(inviteTokens.token, inviteCode),
      });
      if (token && !token.usedBy && token.expiresAt > now) {
        topic = await db.query.topics.findFirst({
          where: eq(topics.id, token.topicId),
        });
        if (topic) {
          singleUseTokenId = token.id;
        }
      }
    }

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

    /*
     * A NON-public topic is joinable only by a single-use, expiring token.
     *
     * Every topic also carries a fixed `inviteCode` that never expires and can
     * be used any number of times. On a public topic that is harmless — anyone
     * may join anyway. On private, and above all on secret, it is a permanent
     * skeleton key: the tier's whole meaning is that membership is controlled,
     * and one leaked link would admit everyone who ever sees it, forever, with
     * nothing to revoke. The expiring token is the way in for those tiers.
     */
    if (topic.visibility !== 'public' && !singleUseTokenId) {
      logger.warn(ROUTE, 'Fixed invite code refused for a non-public topic', {
        userId: session.userId,
        topicId: topic.id,
        visibility: topic.visibility,
      });
      // Deliberately the same shape as an unknown code: confirming that a
      // secret topic exists behind this link is itself the leak.
      return NextResponse.json({ error: 'Invalid invite code' }, { status: 404 });
    }

    await db.insert(topicMembers).values({
      topicId: topic.id,
      userId: session.userId,
      role: 'member',
    });

    // Mark single-use token as used
    if (singleUseTokenId) {
      await db
        .update(inviteTokens)
        .set({ usedBy: session.userId, usedAt: new Date() })
        .where(eq(inviteTokens.id, singleUseTokenId));
    }

    // Real membership transition → persist + publish one `joined the
    // chat` system message. `await` so Cloud Run doesn't cut the
    // background promise; the helper swallows its own errors.
    await broadcastMembershipSystemEvent(topic.id, session.userId, 'join');

    logger.info(ROUTE, 'User joined topic via invite code', { userId: session.userId, topicId: topic.id, visibility: topic.visibility, singleUse: !!singleUseTokenId });
    return NextResponse.json({ success: true, topicId: topic.id }, { status: 201 });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
