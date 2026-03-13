import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers, joinRequests } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import {
  extractScope,
  extractIsIncluded,
  computeScopeHash,
  COMMUNITY_SCOPE,
} from '@/lib/proof';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/[topicId]/join';

/**
 * @openapi
 * /api/topics/{topicId}/join:
 *   post:
 *     tags: [Topics]
 *     summary: Join or request to join topic
 *     description: >-
 *       Requests to join a topic. For public topics, joins immediately. For private topics, creates
 *       a pending join request that must be approved by a topic owner or admin. Secret topics cannot
 *       be joined directly (use invite code). Country-gated topics require a valid ZK proof.
 *     operationId: joinTopic
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID to join
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Required only if topic requires country proof
 *             properties:
 *               proof:
 *                 type: string
 *                 description: Country attestation proof hex string
 *               publicInputs:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Proof public inputs as hex strings
 *     responses:
 *       201:
 *         description: Joined public topic immediately
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                   description: Join success indicator
 *       202:
 *         description: Join request created for private topic (pending approval)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                   description: Request creation success
 *                 status:
 *                   type: string
 *                   example: pending
 *                   description: Join request status
 *                 message:
 *                   type: string
 *                   description: Human-readable status message
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Secret topic (use invite code) or country not in allowed list
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
 *       409:
 *         description: Already a member or join request already pending
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error409'
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

    logger.info(ROUTE, 'Join attempt', { userId: session.userId, topicId });

    const topic = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
    });

    if (!topic) {
      logger.warn(ROUTE, 'Topic not found', { topicId });
      return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
    }

    // Check if already a member
    const existingMembership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (existingMembership) {
      logger.warn(ROUTE, 'User is already a member', { userId: session.userId, topicId });
      return NextResponse.json(
        { error: 'Already a member of this topic' },
        { status: 409 },
      );
    }

    // If topic requires country proof, verify it
    if (topic.requiresCountryProof) {
      logger.info(ROUTE, 'Topic requires country proof, verifying', { userId: session.userId, topicId });

      const body = await request.json();
      const { proof, publicInputs } = body;

      if (!proof || !publicInputs) {
        logger.warn(ROUTE, 'Missing country proof fields', { userId: session.userId, topicId, hasProof: !!proof, hasPublicInputs: !!publicInputs });
        return NextResponse.json(
          { error: 'Country proof required: proof, publicInputs' },
          { status: 400 },
        );
      }

      // Proof was already verified on-chain by the poll endpoint (mode=proof).
      // Only validate scope and is_included from publicInputs.

      // Verify scope matches community scope
      const scope = extractScope(publicInputs, 'coinbase_country_attestation');
      const expectedScope = computeScopeHash(COMMUNITY_SCOPE);
      if (scope !== expectedScope) {
        logger.warn(ROUTE, 'Country proof scope mismatch', { userId: session.userId, topicId, scope, expectedScope });
        return NextResponse.json(
          { error: 'Country proof scope mismatch' },
          { status: 400 },
        );
      }

      // Verify is_included flag: the prover built the country_list from
      // topic.allowedCountries, so is_included=1 means the user's country
      // is in that list.
      const isIncluded = extractIsIncluded(publicInputs, 'coinbase_country_attestation');
      if (!isIncluded) {
        logger.warn(ROUTE, 'Country not in allowed list', { userId: session.userId, topicId });
        return NextResponse.json(
          { error: 'Country not allowed for this topic' },
          { status: 403 },
        );
      }
    }

    // Handle join based on visibility
    if (topic.visibility === 'secret') {
      logger.warn(ROUTE, 'Direct join attempt on secret topic', { userId: session.userId, topicId });
      return NextResponse.json(
        { error: 'This topic requires an invite code' },
        { status: 403 },
      );
    }

    if (topic.visibility === 'private') {
      // Check for existing join request
      const existingRequest = await db.query.joinRequests.findFirst({
        where: and(eq(joinRequests.topicId, topicId), eq(joinRequests.userId, session.userId)),
      });

      if (existingRequest) {
        if (existingRequest.status === 'pending') {
          logger.warn(ROUTE, 'Duplicate join request', { userId: session.userId, topicId });
          return NextResponse.json(
            { error: 'Join request already pending' },
            { status: 409 },
          );
        }
        if (existingRequest.status === 'rejected') {
          logger.warn(ROUTE, 'Previously rejected join request', { userId: session.userId, topicId });
          return NextResponse.json(
            { error: 'Join request was rejected' },
            { status: 403 },
          );
        }
      }

      // Create pending join request
      await db.insert(joinRequests).values({
        topicId,
        userId: session.userId,
        status: 'pending',
      });

      logger.info(ROUTE, 'Join request submitted for private topic', { userId: session.userId, topicId });
      return NextResponse.json(
        { success: true, status: 'pending', message: 'Join request submitted' },
        { status: 202 },
      );
    }

    // Public topic — instant join
    await db.insert(topicMembers).values({
      topicId,
      userId: session.userId,
      role: 'member',
    });

    logger.info(ROUTE, 'User joined topic successfully', { userId: session.userId, topicId });
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
