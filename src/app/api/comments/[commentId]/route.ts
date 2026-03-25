import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { comments, posts, topicMembers } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/comments/[commentId]';

/**
 * @openapi
 * /api/comments/{commentId}:
 *   delete:
 *     tags: [Comments]
 *     summary: Soft-delete a comment
 *     description: >-
 *       Marks a comment as deleted (soft delete). The comment author can delete their own comment.
 *       Topic owners and admins can delete any comment in their topic. Deleted comments remain
 *       in the database but are displayed as "Deleted comment" or "Deleted by admin".
 *     operationId: deleteComment
 *     parameters:
 *       - name: commentId
 *         in: path
 *         required: true
 *         description: Comment ID
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Comment soft-deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 deletedBy:
 *                   type: string
 *                   enum: [author, admin]
 *                   description: Who performed the deletion
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ commentId: string }> },
) {
  logger.info(ROUTE, 'DELETE request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated DELETE request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { commentId } = await params;

    logger.info(ROUTE, 'Deleting comment', { userId: session.userId, commentId });

    // Find the comment
    const commentResults = await db
      .select({
        id: comments.id,
        postId: comments.postId,
        authorId: comments.authorId,
        deletedAt: comments.deletedAt,
      })
      .from(comments)
      .where(eq(comments.id, commentId));

    if (commentResults.length === 0) {
      logger.warn(ROUTE, 'Comment not found', { commentId });
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    }

    const comment = commentResults[0];

    // Already deleted
    if (comment.deletedAt !== null) {
      logger.warn(ROUTE, 'Comment already deleted', { commentId });
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    }

    // Find the post to get the topicId
    const postResults = await db
      .select({ id: posts.id, topicId: posts.topicId })
      .from(posts)
      .where(eq(posts.id, comment.postId));

    if (postResults.length === 0) {
      logger.warn(ROUTE, 'Parent post not found', { commentId, postId: comment.postId });
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
    }

    const post = postResults[0];

    // Determine deletedBy
    let deletedBy: 'author' | 'admin';

    if (comment.authorId === session.userId) {
      deletedBy = 'author';
    } else {
      // Check if user is topic owner or admin
      const membership = await db.query.topicMembers.findFirst({
        where: and(
          eq(topicMembers.topicId, post.topicId),
          eq(topicMembers.userId, session.userId),
        ),
      });

      if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
        logger.warn(ROUTE, 'Unauthorized delete attempt', { userId: session.userId, authorId: comment.authorId, commentId });
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      deletedBy = 'admin';
      logger.info(ROUTE, 'Admin/owner deleting comment', { userId: session.userId, role: membership.role, commentId });
    }

    // Soft delete
    await db
      .update(comments)
      .set({ deletedAt: new Date(), deletedBy })
      .where(eq(comments.id, commentId));

    // Decrement commentCount on post
    await db
      .update(posts)
      .set({ commentCount: sql`GREATEST(${posts.commentCount} - 1, 0)` })
      .where(eq(posts.id, comment.postId));

    logger.info(ROUTE, 'Comment soft-deleted', { userId: session.userId, commentId, deletedBy });
    return NextResponse.json({ success: true, deletedBy });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in DELETE', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
