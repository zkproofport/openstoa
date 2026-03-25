import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topicMembers, users } from '@/lib/db/schema';
import { eq, and, ilike, sql } from 'drizzle-orm';
import { getBatchUserBadges, filterBadgesByTopicProofType } from '@/lib/verification-cache';
import { topics } from '@/lib/db/schema';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/[topicId]/members';

/**
 * @openapi
 * /api/topics/{topicId}/members:
 *   get:
 *     tags: [Members]
 *     summary: List topic members
 *     description: >-
 *       Lists all members of a topic, sorted by role (owner then admin then member). Supports
 *       nickname prefix search for @mention autocomplete.
 *     operationId: listMembers
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID
 *         schema:
 *           type: string
 *           format: uuid
 *       - name: q
 *         in: query
 *         required: false
 *         description: Nickname prefix search (returns up to 10 matches)
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of topic members
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 members:
 *                   type: array
 *                   description: Topic members sorted by role
 *                   items:
 *                     $ref: '#/components/schemas/Member'
 *                 currentUserRole:
 *                   type: string
 *                   description: Current user's role in the topic
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *   patch:
 *     tags: [Members]
 *     summary: Change member role
 *     description: >-
 *       Changes a member's role. Only the topic owner can change roles. Transferring ownership
 *       (setting another member to 'owner') automatically demotes the current owner to 'admin'.
 *     operationId: changeMemberRole
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId, role]
 *             properties:
 *               userId:
 *                 type: string
 *                 description: User ID of the member to update
 *               role:
 *                 type: string
 *                 enum: [owner, admin, member]
 *                 description: New role to assign
 *     responses:
 *       200:
 *         description: Role changed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                   description: Update success indicator
 *                 role:
 *                   type: string
 *                   description: New role assigned
 *                 transferred:
 *                   type: boolean
 *                   description: Whether ownership was transferred (current owner demoted to admin)
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *   delete:
 *     tags: [Members]
 *     summary: Remove member from topic
 *     description: >-
 *       Removes a member from the topic. Admins can only remove regular members. Owners can
 *       remove anyone except themselves.
 *     operationId: removeMember
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *                 description: User ID of the member to remove
 *     responses:
 *       200:
 *         description: Member removed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                   description: Removal success indicator
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Insufficient permissions to remove this member
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { topicId } = await params;
  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim() ?? '';

  // Check membership
  const membership = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
  });
  if (!membership) {
    return NextResponse.json({ error: 'Not a member' }, { status: 403 });
  }

  // Get topic proofType for badge filtering
  const topicForBadge = await db.query.topics.findFirst({
    where: eq(topics.id, topicId),
    columns: { proofType: true },
  });
  const topicProofType = topicForBadge?.proofType ?? null;

  logger.info(ROUTE, 'Fetching members', { topicId, q });

  if (q) {
    // Mention autocomplete: search by nickname, limit 10
    const members = await db
      .select({
        userId: users.id,
        nickname: users.nickname,
        role: topicMembers.role,
        profileImage: users.profileImage,
      })
      .from(topicMembers)
      .innerJoin(users, eq(topicMembers.userId, users.id))
      .where(and(eq(topicMembers.topicId, topicId), ilike(users.nickname, `%${q}%`)))
      .limit(10);

    const mentionUserIds = members.map(m => m.userId);
    const badgeMap = await getBatchUserBadges(mentionUserIds);
    const membersWithBadges = members.map(m => ({
      ...m,
      badges: filterBadgesByTopicProofType(badgeMap.get(m.userId) ?? [], topicProofType),
    }));
    return NextResponse.json({ members: membersWithBadges, currentUserRole: membership.role });
  }

  // Full member list sorted by role: owner first, then admin, then member
  const members = await db
    .select({
      userId: users.id,
      nickname: users.nickname,
      role: topicMembers.role,
      profileImage: users.profileImage,
    })
    .from(topicMembers)
    .innerJoin(users, eq(topicMembers.userId, users.id))
    .where(eq(topicMembers.topicId, topicId))
    .orderBy(
      sql`CASE ${topicMembers.role} WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END`,
    );

  const memberUserIds = members.map(m => m.userId);
  const badgeMap = await getBatchUserBadges(memberUserIds);
  const membersWithBadges = members.map(m => ({
    ...m,
    badges: filterBadgesByTopicProofType(badgeMap.get(m.userId) ?? [], topicProofType),
  }));

  return NextResponse.json({ members: membersWithBadges });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'PATCH request received');
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;
    const body = await request.json();
    const { userId, role } = body;

    if (!userId || !role) {
      return NextResponse.json({ error: 'userId and role are required' }, { status: 400 });
    }

    if (role !== 'admin' && role !== 'member' && role !== 'owner') {
      return NextResponse.json({ error: 'Role must be owner, admin, or member' }, { status: 400 });
    }

    // Verify caller is the topic owner
    const callerMembership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (!callerMembership || callerMembership.role !== 'owner') {
      logger.warn(ROUTE, 'Non-owner attempted role change', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Only the topic owner can change roles' }, { status: 403 });
    }

    // Cannot change own role
    if (userId === session.userId) {
      return NextResponse.json({ error: 'Cannot change your own role' }, { status: 400 });
    }

    // Verify target is a member
    const targetMembership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, userId),
      ),
    });

    if (!targetMembership) {
      return NextResponse.json({ error: 'User is not a member of this topic' }, { status: 404 });
    }

    if (role === 'owner') {
      // Ownership transfer: target becomes owner, caller becomes admin
      await db
        .update(topicMembers)
        .set({ role: 'owner' })
        .where(and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, userId)));
      await db
        .update(topicMembers)
        .set({ role: 'admin' })
        .where(and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)));

      logger.info(ROUTE, 'Ownership transferred', { topicId, newOwner: userId, previousOwner: session.userId });
      return NextResponse.json({ success: true, role: 'owner', transferred: true });
    }

    // Update role (admin/member)
    await db
      .update(topicMembers)
      .set({ role })
      .where(and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, userId)));

    logger.info(ROUTE, 'Member role updated', { topicId, targetUserId: userId, newRole: role, byUserId: session.userId });
    return NextResponse.json({ success: true, role });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in PATCH', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'DELETE request received');
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;
    const body = await request.json();
    const { userId } = body;

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    // Cannot kick self
    if (userId === session.userId) {
      return NextResponse.json({ error: 'Cannot kick yourself' }, { status: 400 });
    }

    // Get caller's membership
    const callerMembership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (!callerMembership || (callerMembership.role !== 'owner' && callerMembership.role !== 'admin')) {
      logger.warn(ROUTE, 'Unauthorized kick attempt', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Only owner or admin can kick members' }, { status: 403 });
    }

    // Get target's membership
    const targetMembership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, userId),
      ),
    });

    if (!targetMembership) {
      return NextResponse.json({ error: 'User is not a member of this topic' }, { status: 404 });
    }

    // Admin can only kick members (not other admins or owner)
    if (callerMembership.role === 'admin' && targetMembership.role !== 'member') {
      logger.warn(ROUTE, 'Admin attempted to kick non-member role', { userId: session.userId, targetRole: targetMembership.role, topicId });
      return NextResponse.json({ error: 'Admins can only kick members' }, { status: 403 });
    }

    // Delete membership
    await db
      .delete(topicMembers)
      .where(and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, userId)));

    logger.info(ROUTE, 'Member kicked', { topicId, kickedUserId: userId, byUserId: session.userId });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in DELETE', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
