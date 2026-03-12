import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { joinRequests, topicMembers, users } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/[topicId]/requests';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;

    // Check caller is owner or admin
    const membership = await db.query.topicMembers.findFirst({
      where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
    });

    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      logger.warn(ROUTE, 'Unauthorized request list attempt', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Only owner or admin can view requests' }, { status: 403 });
    }

    const url = new URL(request.url);
    const statusFilter = url.searchParams.get('status');

    let whereClause;
    if (statusFilter === 'all') {
      whereClause = eq(joinRequests.topicId, topicId);
    } else {
      whereClause = and(eq(joinRequests.topicId, topicId), eq(joinRequests.status, 'pending'));
    }

    const requests = await db
      .select({
        id: joinRequests.id,
        userId: joinRequests.userId,
        nickname: users.nickname,
        profileImage: users.profileImage,
        status: joinRequests.status,
        createdAt: joinRequests.createdAt,
      })
      .from(joinRequests)
      .innerJoin(users, eq(joinRequests.userId, users.id))
      .where(whereClause);

    logger.info(ROUTE, 'Join requests fetched', { topicId, count: requests.length });
    return NextResponse.json({ requests });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
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
    const { requestId, action } = body;

    if (!requestId || !action) {
      return NextResponse.json({ error: 'requestId and action are required' }, { status: 400 });
    }

    if (action !== 'approve' && action !== 'reject') {
      return NextResponse.json({ error: 'Action must be approve or reject' }, { status: 400 });
    }

    // Check caller is owner or admin
    const membership = await db.query.topicMembers.findFirst({
      where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
    });

    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      logger.warn(ROUTE, 'Unauthorized request action attempt', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Only owner or admin can manage requests' }, { status: 403 });
    }

    // Find the request
    const joinRequest = await db.query.joinRequests.findFirst({
      where: and(eq(joinRequests.id, requestId), eq(joinRequests.topicId, topicId)),
    });

    if (!joinRequest) {
      return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    }

    if (joinRequest.status !== 'pending') {
      return NextResponse.json({ error: 'Request already processed' }, { status: 409 });
    }

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    // Update request status
    await db
      .update(joinRequests)
      .set({
        status: newStatus,
        reviewedBy: session.userId,
        reviewedAt: new Date(),
      })
      .where(eq(joinRequests.id, requestId));

    // If approved, add as member
    if (action === 'approve') {
      await db.insert(topicMembers).values({
        topicId,
        userId: joinRequest.userId,
        role: 'member',
      });
      logger.info(ROUTE, 'Join request approved, member added', { topicId, userId: joinRequest.userId, byUserId: session.userId });
    } else {
      logger.info(ROUTE, 'Join request rejected', { topicId, userId: joinRequest.userId, byUserId: session.userId });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in PATCH', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
