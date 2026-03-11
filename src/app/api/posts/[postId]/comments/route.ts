import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, comments, topicMembers, users } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/posts/[postId]/comments';

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

    logger.info(ROUTE, 'Creating comment', { userId: session.userId, postId });

    // Get the post to find its topic
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, postId),
    });

    if (!post) {
      logger.warn(ROUTE, 'Post not found', { postId });
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    // Check membership in the post's topic
    const membership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, post.topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (!membership) {
      logger.warn(ROUTE, 'User is not a member of the post topic', { userId: session.userId, postId, topicId: post.topicId });
      return NextResponse.json(
        { error: 'Not a member of this topic' },
        { status: 403 },
      );
    }

    const body = await request.json();
    const { content } = body;

    if (!content || typeof content !== 'string') {
      logger.warn(ROUTE, 'Missing content', { userId: session.userId, postId });
      return NextResponse.json(
        { error: 'Content is required' },
        { status: 400 },
      );
    }

    const [comment] = await db
      .insert(comments)
      .values({
        postId,
        authorId: session.userId,
        content,
      })
      .returning();

    // Increment commentCount on post
    await db.update(posts).set({ commentCount: sql`${posts.commentCount} + 1` }).where(eq(posts.id, postId));

    // Fetch author nickname for the response
    const author = await db.query.users.findFirst({
      where: eq(users.id, session.userId),
      columns: { nickname: true },
    });

    logger.info(ROUTE, 'Comment created', { userId: session.userId, postId, commentId: comment.id });
    return NextResponse.json({
      comment: { ...comment, authorNickname: author?.nickname ?? 'anon' },
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
