import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/lib/session';
import { db } from '@/lib/db';
import { reactions } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/posts/[postId]/reactions';

const ALLOWED_EMOJIS = ['👍', '❤️', '🔥', '😂', '🎉', '😮'];

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { postId } = await params;

    // Get reaction counts grouped by emoji, and whether current user reacted
    const rows = await db
      .select({
        emoji: reactions.emoji,
        count: sql<number>`count(distinct ${reactions.userId})::int`,
        userReacted: sql<boolean>`bool_or(${reactions.userId} = ${session.userId})`,
      })
      .from(reactions)
      .where(eq(reactions.postId, postId))
      .groupBy(reactions.emoji);

    logger.info(ROUTE, 'Reactions fetched', { postId, count: rows.length });
    return NextResponse.json({ reactions: rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { postId } = await params;
    const body = await request.json();
    const { emoji } = body;

    if (!emoji || !ALLOWED_EMOJIS.includes(emoji)) {
      logger.warn(ROUTE, 'Invalid emoji', { userId: session.userId, postId, emoji });
      return NextResponse.json({ error: 'Invalid emoji' }, { status: 400 });
    }

    // Check if reaction already exists
    const existing = await db.query.reactions.findFirst({
      where: and(
        eq(reactions.userId, session.userId),
        eq(reactions.postId, postId),
        eq(reactions.emoji, emoji),
      ),
    });

    if (existing) {
      // Remove reaction
      await db
        .delete(reactions)
        .where(
          and(
            eq(reactions.userId, session.userId),
            eq(reactions.postId, postId),
            eq(reactions.emoji, emoji),
          ),
        );
      logger.info(ROUTE, 'Reaction removed', { userId: session.userId, postId, emoji });
      return NextResponse.json({ added: false });
    } else {
      // Add reaction
      await db.insert(reactions).values({
        userId: session.userId,
        postId,
        emoji,
      });
      logger.info(ROUTE, 'Reaction added', { userId: session.userId, postId, emoji });
      return NextResponse.json({ added: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
