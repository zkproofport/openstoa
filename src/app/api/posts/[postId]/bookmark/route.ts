import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { bookmarks } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/posts/[postId]/bookmark';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { postId } = await params;

    logger.info(ROUTE, 'Checking bookmark status', { userId: session.userId, postId });

    const existing = await db.query.bookmarks.findFirst({
      where: and(
        eq(bookmarks.userId, session.userId),
        eq(bookmarks.postId, postId),
      ),
    });

    return NextResponse.json({ bookmarked: !!existing });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { postId } = await params;

    logger.info(ROUTE, 'Toggling bookmark', { userId: session.userId, postId });

    const existing = await db.query.bookmarks.findFirst({
      where: and(
        eq(bookmarks.userId, session.userId),
        eq(bookmarks.postId, postId),
      ),
    });

    if (existing) {
      await db.delete(bookmarks).where(
        and(
          eq(bookmarks.userId, session.userId),
          eq(bookmarks.postId, postId),
        ),
      );
      logger.info(ROUTE, 'Bookmark removed', { userId: session.userId, postId });
      return NextResponse.json({ bookmarked: false });
    } else {
      await db.insert(bookmarks).values({
        userId: session.userId,
        postId,
      });
      logger.info(ROUTE, 'Bookmark added', { userId: session.userId, postId });
      return NextResponse.json({ bookmarked: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
