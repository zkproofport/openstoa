import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { broadcastMembershipSystemEvent } from '@/lib/chat';
import { requireAiCapability } from '@/lib/aiPermissions';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';

const ROUTE = '/api/topics/[topicId]/leave';

/**
 * @openapi
 * /api/topics/{topicId}/leave:
 *   post:
 *     tags: [Members]
 *     summary: Leave a topic
 *     description: >-
 *       Removes the caller's own membership. The counterpart to
 *       `POST /api/topics/{topicId}/join` — until this existed, an account could
 *       join a topic and had no way out (`DELETE /members` refuses self-removal).
 *
 *
 *       Idempotent: leaving a topic you are not a member of succeeds and reports
 *       `left: false`, so a double-tap or a retry is never an error.
 *
 *
 *       The topic OWNER cannot leave while owning it — transfer ownership first
 *       (`PATCH /api/topics/{topicId}/members` with `role: owner`). This is the
 *       same rule account deletion enforces.
 *
 *
 *       Chat: leaving deletes the membership row, which is what gates access.
 *       The MLS leaf is evicted separately by the next member to open the chat
 *       (the server holds no keys and cannot commit — SI-1). A client that
 *       leaves should also drop its own local group state and archive keys for
 *       the topic.
 *     operationId: leaveTopic
 *     x-related-skills: [join-topic, remove-member, list-members]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: The topic to leave.
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Membership removed, or the caller was already not a member.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: Always true — the caller is not a member of the topic.
 *                 left:
 *                   type: boolean
 *                   description: >-
 *                     True if this call removed a membership; false if there was
 *                     nothing to remove. Use it to decide whether to show a
 *                     confirmation, not to decide success.
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         description: Topic not found.
 *       409:
 *         description: The caller owns this topic — transfer ownership first.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;

    // Profile-level AI capability (design §7), same gate the kick path uses:
    // leaving is a membership change whoever performs it. Humans unaffected.
    const leaveGate = await requireAiCapability(db, session, '/openstoa/topic/leave');
    if (leaveGate) {
      logger.warn(ROUTE, 'AI caller lacks topic/leave capability', { userId: session.userId, topicId });
      return leaveGate;
    }

    const topic = await db.query.topics.findFirst({ where: eq(topics.id, topicId) });
    if (!topic) {
      return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
    }

    /*
     * An owner who walks out leaves a topic nobody can administer — no kicks,
     * no role changes, no deletion. Account deletion already refuses for this
     * reason; refusing here too keeps one rule rather than two that disagree.
     */
    if (topic.creatorId === session.userId) {
      logger.warn(ROUTE, 'Owner attempted to leave own topic', { topicId, userId: session.userId });
      return NextResponse.json(
        { error: 'Transfer topic ownership before leaving' },
        { status: 409 },
      );
    }

    const deleted = await db
      .delete(topicMembers)
      .where(and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)))
      .returning({ userId: topicMembers.userId });

    // Nothing removed means the caller was already out. That is the state they
    // asked for, so it is a success — a retry after a dropped response, or a
    // double tap, must not read as a failure.
    if (deleted.length === 0) {
      return NextResponse.json({ success: true, left: false });
    }

    /*
     * Real membership transition → one `left the chat` system message. Awaited
     * so Cloud Run cannot cut the background promise.
     *
     * Guarded separately from the outer catch on purpose: the row is ALREADY
     * deleted by this point, so the caller has left whatever happens next.
     * Letting a chat failure reach the outer handler would answer 500 to a
     * request that succeeded, and the client would show an error over a topic
     * the user is no longer in. The helper swallows its own errors today; this
     * makes that a property of the route rather than a property of the helper.
     */
    try {
      await broadcastMembershipSystemEvent(topicId, session.userId, 'leave');
    } catch (error) {
      logger.warn(ROUTE, 'Leave system message failed; membership already removed', {
        topicId,
        userId: session.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.info(ROUTE, 'Member left topic', { topicId, userId: session.userId });
    return NextResponse.json({ success: true, left: true });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
