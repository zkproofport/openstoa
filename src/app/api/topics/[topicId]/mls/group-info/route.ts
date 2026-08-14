import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { mlsGroups, topicMembers } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { decodeBase64Strict, MLS_CIPHERSUITE, MLS_MAX_GROUP_INFO_BYTES } from '@/lib/mls/http';

const ROUTE = '/api/topics/[topicId]/mls/group-info';

async function memberSession(request: NextRequest, topicId: string) {
  const session = await getSession(request);
  if (!session) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  const membership = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
  });
  if (!membership) return { error: NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 }) };
  return { session };
}

/**
 * @openapi
 * /api/topics/{topicId}/mls/group-info:
 *   get:
 *     tags: [MLS]
 *     summary: Get the topic's public MLS GroupInfo (for External Commit)
 *     description: |
 *       Returns the latest **public** GroupInfo for the topic's MLS group, plus the current epoch
 *       and ciphersuite. A device joining via **External Commit** (e.g. a new device when the old
 *       one is offline) needs this to build its join Commit. GroupInfo is public group state — it
 *       contains no secrets and the server never decrypts anything. Returns **404** before the
 *       group exists or before any GroupInfo has been published. **Membership required.**
 *     operationId: getMlsGroupInfo
 *     x-related-skills: [submit-mls-commit, publish-mls-key-package]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Public GroupInfo
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groupInfo: { type: string, format: byte, description: base64 public GroupInfo bytes }
 *                 epoch: { type: integer }
 *                 ciphersuite: { type: string }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { description: No group or no GroupInfo published yet }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const membership = await db.query.topicMembers.findFirst({
      where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
    });
    if (!membership) {
      return NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 });
    }

    const group = await db.query.mlsGroups.findFirst({
      where: eq(mlsGroups.topicId, topicId),
    });
    if (!group || !group.groupInfo) {
      return NextResponse.json({ error: 'No GroupInfo available' }, { status: 404 });
    }

    logger.info(ROUTE, 'GroupInfo fetched', { topicId, epoch: group.currentEpoch });
    return NextResponse.json({
      groupInfo: Buffer.from(group.groupInfo).toString('base64'),
      epoch: group.currentEpoch,
      ciphersuite: group.ciphersuite,
    });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}

/**
 * @openapi
 * /api/topics/{topicId}/mls/group-info:
 *   post:
 *     tags: [MLS]
 *     summary: Register the genesis GroupInfo for a new topic group
 *     description: |
 *       The topic creator calls this once after creating the MLS group locally (epoch 0): it
 *       publishes the initial public GroupInfo so the next member can join via External Commit.
 *       Idempotent and race-safe — if the group row already exists (genesis done, or already
 *       advanced past epoch 0) the call is a no-op and never clobbers a live group. Subsequent
 *       GroupInfo refreshes happen automatically through the `groupInfo` field on
 *       `POST /mls/commit`. **Membership required.**
 *     operationId: registerMlsGroupInfo
 *     x-related-skills: [get-mls-group-info, submit-mls-commit]
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
 *             required: [groupInfo, groupId]
 *             properties:
 *               groupInfo: { type: string, format: byte, description: base64 public GroupInfo at epoch 0 }
 *               groupId: { type: string, format: byte, description: base64 MLS group_id }
 *     responses:
 *       201: { description: Genesis group registered }
 *       200: { description: Group already existed (no-op) }
 *       400: { description: Invalid base64 groupInfo / groupId, or payload too large }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await memberSession(request, topicId);
    if ('error' in auth) return auth.error!;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const groupInfoBytes = decodeBase64Strict((body as Record<string, unknown>).groupInfo);
    const groupIdBytes = decodeBase64Strict((body as Record<string, unknown>).groupId);
    if (!groupInfoBytes || !groupIdBytes) {
      return NextResponse.json({ error: 'Valid base64 groupInfo and groupId are required' }, { status: 400 });
    }
    if (groupInfoBytes.length > MLS_MAX_GROUP_INFO_BYTES) {
      return NextResponse.json({ error: 'groupInfo too large' }, { status: 400 });
    }

    // Genesis only: create the epoch-0 row if absent. ON CONFLICT DO NOTHING
    // makes this idempotent and prevents two near-simultaneous creators (or a
    // re-call after the group has advanced) from clobbering live state.
    const inserted = await db
      .insert(mlsGroups)
      .values({
        topicId,
        groupId: groupIdBytes,
        currentEpoch: 0,
        ciphersuite: MLS_CIPHERSUITE,
        groupInfo: groupInfoBytes,
      })
      .onConflictDoNothing()
      .returning({ topicId: mlsGroups.topicId });

    const created = inserted.length > 0;
    logger.info(ROUTE, 'Genesis group-info register', { topicId, created });
    return NextResponse.json({ created }, { status: created ? 201 : 200 });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
