import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/join/[inviteCode]';

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
