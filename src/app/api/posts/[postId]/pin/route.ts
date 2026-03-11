import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, topicMembers } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/posts/[postId]/pin';

export async function POST(
  _request: NextRequest,
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

    // Get the post
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, postId),
    });

    if (!post) {
      logger.warn(ROUTE, 'Post not found', { postId });
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    // Check if user is owner or admin of the topic
    const membership = await db.query.topicMembers.findFirst({
      where: and(eq(topicMembers.topicId, post.topicId), eq(topicMembers.userId, session.userId)),
    });

    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      logger.warn(ROUTE, 'User is not owner or admin', { userId: session.userId, topicId: post.topicId, role: membership?.role });
      return NextResponse.json({ error: 'Only topic owner or admin can pin posts' }, { status: 403 });
    }

    // Toggle isPinned
    const newIsPinned = !post.isPinned;
    await db
      .update(posts)
      .set({ isPinned: newIsPinned })
      .where(eq(posts.id, postId));

    logger.info(ROUTE, 'Post pin toggled', { userId: session.userId, postId, isPinned: newIsPinned });
    return NextResponse.json({ isPinned: newIsPinned });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
