import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookies } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, comments, topicMembers, users, postTags, tags, votes, topics } from '@/lib/db/schema';
import { eq, and, asc, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/posts/[postId]';

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

    logger.info(ROUTE, 'Fetching post detail', { userId: session.userId, postId });

    // Get post with author
    const postResults = await db
      .select({
        id: posts.id,
        topicId: posts.topicId,
        authorId: posts.authorId,
        title: posts.title,
        content: posts.content,
        media: posts.media,
        createdAt: posts.createdAt,
        updatedAt: posts.updatedAt,
        authorNickname: users.nickname,
        authorProfileImage: users.profileImage,
        upvoteCount: posts.upvoteCount,
        viewCount: posts.viewCount,
        commentCount: posts.commentCount,
        score: posts.score,
        userVoted: sql<number | null>`${votes.value}`,
        topicTitle: topics.title,
      })
      .from(posts)
      .leftJoin(users, eq(posts.authorId, users.id))
      .leftJoin(votes, and(eq(votes.postId, posts.id), eq(votes.userId, session.userId)))
      .leftJoin(topics, eq(posts.topicId, topics.id))
      .where(eq(posts.id, postId));

    if (postResults.length === 0) {
      logger.warn(ROUTE, 'Post not found', { postId });
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const post = postResults[0];

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

    // Atomically increment viewCount
    await db.update(posts).set({ viewCount: sql`${posts.viewCount} + 1` }).where(eq(posts.id, postId));

    // Get comments with author nicknames
    const postComments = await db
      .select({
        id: comments.id,
        postId: comments.postId,
        authorId: comments.authorId,
        content: comments.content,
        createdAt: comments.createdAt,
        authorNickname: users.nickname,
        authorProfileImage: users.profileImage,
      })
      .from(comments)
      .leftJoin(users, eq(comments.authorId, users.id))
      .where(eq(comments.postId, postId))
      .orderBy(asc(comments.createdAt));

    // Fetch tags for the post
    const postTagResults = await db
      .select({ name: tags.name, slug: tags.slug })
      .from(postTags)
      .innerJoin(tags, eq(postTags.tagId, tags.id))
      .where(eq(postTags.postId, postId));

    logger.info(ROUTE, 'Post detail fetched', { userId: session.userId, postId, commentCount: postComments.length });
    return NextResponse.json({
      post: { ...post, tags: postTagResults },
      comments: postComments,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  logger.info(ROUTE, 'DELETE request received');
  try {
    const session = await getSessionFromCookies();
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated DELETE request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { postId } = await params;

    logger.info(ROUTE, 'Deleting post', { userId: session.userId, postId });

    // Check post exists
    const postResults = await db
      .select({ id: posts.id, authorId: posts.authorId, topicId: posts.topicId })
      .from(posts)
      .where(eq(posts.id, postId));

    if (postResults.length === 0) {
      logger.warn(ROUTE, 'Post not found for deletion', { postId });
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const post = postResults[0];

    // Allow author, or topic owner/admin
    if (post.authorId !== session.userId) {
      const membership = await db.query.topicMembers.findFirst({
        where: and(
          eq(topicMembers.topicId, post.topicId),
          eq(topicMembers.userId, session.userId),
        ),
      });

      if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
        logger.warn(ROUTE, 'Unauthorized delete attempt', { userId: session.userId, authorId: post.authorId, postId });
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      logger.info(ROUTE, 'Admin/owner deleting post', { userId: session.userId, role: membership.role, postId });
    }

    // Delete comments first (no cascade)
    await db.delete(comments).where(eq(comments.postId, postId));

    // Delete post (votes, bookmarks, postTags cascade automatically)
    await db.delete(posts).where(eq(posts.id, postId));

    logger.info(ROUTE, 'Post deleted', { userId: session.userId, postId });
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in DELETE', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
