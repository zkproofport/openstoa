import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { votes, posts, topicMembers } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/posts/[postId]/vote';

/**
 * @openapi
 * /api/posts/{postId}/vote:
 *   post:
 *     tags: [Votes]
 *     summary: Toggle vote on post
 *     description: >-
 *       Toggles a vote on a post. Sending the same value again removes the vote. Sending the
 *       opposite value switches the vote. Returns the updated upvote count.
 *     operationId: toggleVote
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
 *             required: [value]
 *             properties:
 *               value:
 *                 type: integer
 *                 enum: [1, -1]
 *                 description: Vote value (1 for upvote, -1 for downvote)
 *     responses:
 *       200:
 *         description: Vote toggled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vote:
 *                   type: object
 *                   nullable: true
 *                   description: Current vote state (null if vote was removed)
 *                   properties:
 *                     value:
 *                       type: integer
 *                       description: Vote value (1 or -1)
 *                 upvoteCount:
 *                   type: integer
 *                   description: Updated net upvote count for the post
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
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

    const body = await request.json();
    const { value } = body;

    if (value !== 1 && value !== -1) {
      logger.warn(ROUTE, 'Invalid vote value', { userId: session.userId, postId, value });
      return NextResponse.json({ error: 'Value must be 1 or -1' }, { status: 400 });
    }

    logger.info(ROUTE, 'Processing vote', { userId: session.userId, postId, value });

    // Verify post exists
    const post = await db.query.posts.findFirst({
      where: eq(posts.id, postId),
    });

    if (!post) {
      logger.warn(ROUTE, 'Post not found', { postId });
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    // Check topic membership
    const membership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, post.topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (!membership) {
      logger.warn(ROUTE, 'User is not a member of this topic', { userId: session.userId, postId, topicId: post.topicId });
      return NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 });
    }

    // Check existing vote
    const existingVote = await db.query.votes.findFirst({
      where: and(
        eq(votes.userId, session.userId),
        eq(votes.postId, postId),
      ),
    });

    let updatedPost: { upvoteCount: number } | undefined;

    if (existingVote) {
      if (existingVote.value === value) {
        // Same value → toggle off (delete)
        await db.delete(votes).where(
          and(
            eq(votes.userId, session.userId),
            eq(votes.postId, postId),
          ),
        );

        const delta = value === 1 ? -1 : 1;
        const [result] = await db
          .update(posts)
          .set({ upvoteCount: sql`${posts.upvoteCount} + ${delta}` })
          .where(eq(posts.id, postId))
          .returning({ upvoteCount: posts.upvoteCount });

        updatedPost = result;

        logger.info(ROUTE, 'Vote removed', { userId: session.userId, postId });
        return NextResponse.json({ vote: null, upvoteCount: updatedPost.upvoteCount });
      } else {
        // Different value → update vote, adjust by 2
        await db
          .update(votes)
          .set({ value })
          .where(
            and(
              eq(votes.userId, session.userId),
              eq(votes.postId, postId),
            ),
          );

        const delta = value === 1 ? 2 : -2;
        const [result] = await db
          .update(posts)
          .set({ upvoteCount: sql`${posts.upvoteCount} + ${delta}` })
          .where(eq(posts.id, postId))
          .returning({ upvoteCount: posts.upvoteCount });

        updatedPost = result;

        logger.info(ROUTE, 'Vote updated', { userId: session.userId, postId, value });
        return NextResponse.json({ vote: { value }, upvoteCount: updatedPost.upvoteCount });
      }
    } else {
      // No existing vote → insert
      await db.insert(votes).values({
        userId: session.userId,
        postId,
        value,
      });

      const delta = value === 1 ? 1 : -1;
      const [result] = await db
        .update(posts)
        .set({ upvoteCount: sql`${posts.upvoteCount} + ${delta}` })
        .where(eq(posts.id, postId))
        .returning({ upvoteCount: posts.upvoteCount });

      updatedPost = result;

      logger.info(ROUTE, 'Vote created', { userId: session.userId, postId, value });
      return NextResponse.json({ vote: { value }, upvoteCount: updatedPost.upvoteCount });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
