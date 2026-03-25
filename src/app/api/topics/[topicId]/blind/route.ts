import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/[topicId]/blind';

/**
 * @openapi-admin
 * Admin-only: blind/unblind topic. Not exposed in public API docs.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;

    const topic = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
    });

    if (!topic) {
      return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
    }

    // Only site admin can blind topics
    const user = await db.query.users.findFirst({
      where: eq(users.id, session.userId),
    });
    if (user?.role !== 'admin') {
      logger.warn(ROUTE, 'Non-admin blind attempt', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Only site admin can blind a topic' }, { status: 403 });
    }

    // Toggle: if already blinded, unblind
    if (topic.blindedAt) {
      await db
        .update(topics)
        .set({ blindedAt: null, blindedBy: null })
        .where(eq(topics.id, topicId));

      logger.info(ROUTE, 'Topic unblinded', { userId: session.userId, topicId });
      return NextResponse.json({ success: true, blinded: false, blindedBy: null });
    }

    // Blind the topic
    const blindedBy = 'admin';
    await db
      .update(topics)
      .set({ blindedAt: new Date(), blindedBy })
      .where(eq(topics.id, topicId));

    logger.info(ROUTE, 'Topic blinded', { userId: session.userId, topicId, blindedBy });
    return NextResponse.json({ success: true, blinded: true, blindedBy });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
