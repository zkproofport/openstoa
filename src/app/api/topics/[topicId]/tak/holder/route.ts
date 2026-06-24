import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topicMembers, topics } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { claimOrRenewHolder, updateHolderCoverage, getHolder } from '@/lib/mls/archive';

const ROUTE = '/api/topics/[topicId]/tak/holder';
const LEASE_DEFAULT_SECONDS = 900; // 15 min — long enough to ride out brief offline blips
const LEASE_MAX_SECONDS = 3600; // cap so a vanished holder can't lock succession forever

// Succession order (SI-6): owner takes the chain first, then admins, then
// members. The rank is derived server-side from the caller's role so a plain
// member can't claim a privileged rank.
function rankForRole(role: string): number {
  if (role === 'owner') return 0;
  if (role === 'admin') return 1;
  return 2;
}

/**
 * Resolve the caller's membership AND require the topic be PUBLIC. archive
 * holders exist only for public topics (SI-6); private/secret/AI run custodian-
 * free (SI-6b), so holder operations on them are a 400 by design.
 */
async function requirePublicMember(request: NextRequest, topicId: string) {
  const session = await getSession(request);
  if (!session) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  const membership = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
  });
  if (!membership) return { error: NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 }) };
  const topic = await db.query.topics.findFirst({ where: eq(topics.id, topicId) });
  if (!topic) return { error: NextResponse.json({ error: 'Topic not found' }, { status: 404 }) };
  if (topic.visibility !== 'public') {
    return {
      error: NextResponse.json(
        { error: 'archive holder applies to public topics only (SI-6b: private/secret are custodian-free)' },
        { status: 400 },
      ),
    };
  }
  return { session, rank: rankForRole(membership.role) };
}

/**
 * @openapi
 * /api/topics/{topicId}/tak/holder:
 *   get:
 *     tags: [MLS]
 *     summary: Read the public topic's archive-holder state
 *     description: |
 *       Returns who currently holds the public seed chain (SI-6) — the member whose device
 *       forward-rewraps the chain on membership changes so any current member can derive every
 *       archived epoch's TAK — plus how far it has covered and when its lease expires. Clients use
 *       this to decide whether to claim the role (e.g. the lease has expired). Public topics only.
 *       **Membership required.**
 *     operationId: getArchiveHolder
 *     x-related-skills: [claim-archive-holder, get-tak-bundles]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Current holder state (holder null if none assigned yet)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 holder:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     holderUserId: { type: string }
 *                     holderDeviceId: { type: string }
 *                     epochCovered: { type: integer }
 *                     successionRank: { type: integer }
 *                     leaseExpiresAt: { type: string, format: date-time, nullable: true }
 *       400: { description: Topic is not public }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { description: Topic not found }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await requirePublicMember(request, topicId);
    if ('error' in auth) return auth.error!;

    const holder = await getHolder(db, topicId);
    return NextResponse.json({ holder });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/topics/{topicId}/tak/holder:
 *   post:
 *     tags: [MLS]
 *     summary: Claim or renew the archive-holder lease (single-winner)
 *     description: |
 *       Claims the public seed-chain holder role for the caller's device, or renews it if the caller
 *       already holds it. SINGLE-WINNER (SI-6): the server serializes competing claimers so the seed
 *       chain never forks. If another device holds a still-valid lease the call is rejected (409);
 *       once a lease expires the next claimer takes over (inheriting `epochCovered` to resume
 *       forward-rewrap). The succession `rank` is derived from the caller's topic role
 *       (owner < admin < member) — clients prefer the lowest-rank online member to claim. Public
 *       topics only. **Membership required.**
 *     operationId: claimArchiveHolder
 *     x-related-skills: [get-archive-holder, update-archive-holder-coverage]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [deviceId]
 *             properties:
 *               deviceId: { type: string, description: the caller's device that will hold the chain }
 *               leaseSeconds:
 *                 type: integer
 *                 description: requested lease duration (default 900, max 3600). The device renews before expiry.
 *     responses:
 *       200:
 *         description: Lease granted or renewed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 renewed: { type: boolean, description: true if the caller already held the lease }
 *                 holder:
 *                   type: object
 *                   properties:
 *                     holderUserId: { type: string }
 *                     holderDeviceId: { type: string }
 *                     epochCovered: { type: integer }
 *                     successionRank: { type: integer }
 *                     leaseExpiresAt: { type: string, format: date-time, nullable: true }
 *       400: { description: Missing deviceId or topic not public }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { description: Another device holds a valid lease (held-by-other) }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await requirePublicMember(request, topicId);
    if ('error' in auth) return auth.error!;
    const { session, rank } = auth;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { deviceId, leaseSeconds } = body as Record<string, unknown>;
    if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
      return NextResponse.json({ error: 'deviceId is required' }, { status: 400 });
    }
    let lease = LEASE_DEFAULT_SECONDS;
    if (leaseSeconds !== undefined) {
      if (typeof leaseSeconds !== 'number' || !Number.isSafeInteger(leaseSeconds) || leaseSeconds <= 0) {
        return NextResponse.json({ error: 'leaseSeconds must be a positive integer' }, { status: 400 });
      }
      lease = Math.min(leaseSeconds, LEASE_MAX_SECONDS);
    }

    const result = await claimOrRenewHolder(db, topicId, session.userId, deviceId, rank, lease);
    if (!result.ok) {
      logger.info(ROUTE, 'Holder claim rejected (held-by-other)', { topicId, userId: session.userId });
      return NextResponse.json(
        { error: 'Another device holds a valid lease', holder: result.state },
        { status: 409 },
      );
    }
    logger.info(ROUTE, 'Holder lease granted', {
      topicId,
      userId: session.userId,
      deviceId,
      renewed: result.renewed,
    });
    return NextResponse.json({ renewed: result.renewed, holder: result.state });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/topics/{topicId}/tak/holder:
 *   patch:
 *     tags: [MLS]
 *     summary: Record how far the holder has forward-rewrapped (epoch-fenced)
 *     description: |
 *       The holder reports the highest epoch whose seed it has forward-rewrapped. EPOCH-FENCED
 *       (SI-7): the server records it under the same lock that advances the MLS epoch, so coverage
 *       is only ever stored at a consistent epoch boundary — never straddling a concurrent Commit,
 *       and never above the current epoch. If the epoch has since advanced the holder sees the gap
 *       on its next read and rewraps forward. Only the current holder may report. Public topics
 *       only. **Membership required.**
 *     operationId: updateArchiveHolderCoverage
 *     x-related-skills: [claim-archive-holder, submit-mls-commit]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [deviceId, epochCovered]
 *             properties:
 *               deviceId: { type: string, description: the caller's holder device }
 *               epochCovered: { type: integer, description: highest epoch the holder has forward-rewrapped }
 *     responses:
 *       200:
 *         description: Coverage recorded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 epochCovered: { type: integer }
 *                 currentEpoch: { type: integer }
 *       400: { description: Missing/invalid fields, topic not public, or epochCovered above the current epoch }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { description: Caller is not the current holder }
 *       404: { description: No MLS group for this topic }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await requirePublicMember(request, topicId);
    if ('error' in auth) return auth.error!;
    const { session } = auth;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { deviceId, epochCovered } = body as Record<string, unknown>;
    if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
      return NextResponse.json({ error: 'deviceId is required' }, { status: 400 });
    }
    if (typeof epochCovered !== 'number' || !Number.isSafeInteger(epochCovered) || epochCovered < 0) {
      return NextResponse.json({ error: 'epochCovered must be a non-negative integer' }, { status: 400 });
    }

    const result = await updateHolderCoverage(db, topicId, session.userId, deviceId, epochCovered);
    if (!result.ok) {
      if (result.reason === 'no-group') {
        return NextResponse.json({ error: 'No MLS group for this topic' }, { status: 404 });
      }
      if (result.reason === 'future-epoch') {
        return NextResponse.json(
          { error: 'epochCovered exceeds the current epoch', currentEpoch: result.currentEpoch },
          { status: 400 },
        );
      }
      return NextResponse.json({ error: 'Caller is not the current holder' }, { status: 403 });
    }
    return NextResponse.json({ epochCovered: result.epochCovered, currentEpoch: result.currentEpoch });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in PATCH', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
