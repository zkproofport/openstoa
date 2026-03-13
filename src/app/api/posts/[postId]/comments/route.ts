import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, comments, topicMembers, users } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/posts/[postId]/comments';

/**
 * @openapi
 * /api/posts/{postId}/comments:
 *   post:
 *     tags: [Comments]
 *     summary: Create comment on post
 *     description: Creates a comment on a post. Increments the post's comment count.
 *     operationId: createComment
 *     parameters:
 *       - name: postId
 *         in: path
 *         required: true
 *         description: Post ID
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content:
 *                 type: string
 *                 description: Comment body (plain text)
 *     responses:
 *       201:
 *         description: Comment created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 comment:
 *                   $ref: '#/components/schemas/Comment'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
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
      columns: { nickname: true, profileImage: true },
    });

    logger.info(ROUTE, 'Comment created', { userId: session.userId, postId, commentId: comment.id });
    return NextResponse.json({
      comment: { ...comment, authorNickname: author?.nickname ?? 'anon', authorProfileImage: author?.profileImage ?? null },
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
