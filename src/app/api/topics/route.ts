import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics';

export async function GET() {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // Get topics where user is a member
    const memberships = await db.query.topicMembers.findMany({
      where: eq(topicMembers.userId, session.userId),
    });

    if (memberships.length === 0) {
      logger.info(ROUTE, 'User has no topic memberships', { userId: session.userId });
      return NextResponse.json({ topics: [] });
    }

    const topicIds = memberships.map((m) => m.topicId);
    const userTopics = await db.query.topics.findMany({
      where: (t, { inArray }) => inArray(t.id, topicIds),
    });

    logger.info(ROUTE, 'Topics fetched', { userId: session.userId, count: userTopics.length });
    return NextResponse.json({ topics: userTopics });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json();
    const { title, description, requiresCountryProof, allowedCountries } = body;

    if (!title || typeof title !== 'string') {
      logger.warn(ROUTE, 'Missing title in topic creation', { userId: session.userId });
      return NextResponse.json(
        { error: 'Title is required' },
        { status: 400 },
      );
    }

    const inviteCode = crypto.randomBytes(8).toString('hex');

    logger.info(ROUTE, 'Creating topic', { userId: session.userId, title, requiresCountryProof: requiresCountryProof ?? false, inviteCode });

    const [topic] = await db
      .insert(topics)
      .values({
        title,
        description: description ?? null,
        creatorId: session.userId,
        requiresCountryProof: requiresCountryProof ?? false,
        allowedCountries: allowedCountries ?? null,
        inviteCode,
      })
      .returning();

    // Auto-add creator as member
    await db.insert(topicMembers).values({
      topicId: topic.id,
      userId: session.userId,
    });

    logger.info(ROUTE, 'Topic created and creator added as member', { userId: session.userId, topicId: topic.id });
    return NextResponse.json({ topic }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
