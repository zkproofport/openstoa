import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { votes, posts } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { isValidUUID } from '@/lib/uuid';
import { updatePostScore } from '@/lib/postScore';
import { updateTopicScore } from '@/lib/topicScore';
import { canActOnPost, NOT_A_MEMBER } from '@/lib/postReadable';

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
 *     x-related-skills: [get-post]
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
    if (!isValidUUID(postId)) {
      return NextResponse.json({ error: 'Invalid postId' }, { status: 400 });
    }

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
    /*
     * Acting on a post requires being able to READ it — see `canActOnPost`.
     * Without this a signed-in stranger holding a post id could leave a mark
     * inside somebody's private topic, where its owner sees it.
     */
    if (!(await canActOnPost(post.topicId, session.userId))) {
      logger.warn(ROUTE, 'Caller may not act on this post', { userId: session.userId, postId, topicId: post.topicId });
      return NextResponse.json({ error: NOT_A_MEMBER }, { status: 403 });
    }


    // Topic membership is NOT required to vote — any authenticated user
    // can upvote/downvote a post they can see in the feed (Reddit-style).
    // Posting/commenting still requires membership; that remains enforced
    // by the post/comment endpoints.

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
          .set({ upvoteCount: sql`${posts.upvoteCount} + ${delta}`, lastActivityAt: new Date() })
          .where(eq(posts.id, postId))
          .returning({ upvoteCount: posts.upvoteCount });

        updatedPost = result;

        updatePostScore(postId).catch((err) =>
          logger.warn(ROUTE, 'Failed to update post score', { postId, error: String(err) }),
        );
        updateTopicScore(post.topicId).catch((err) =>
          logger.warn(ROUTE, 'Failed to update topic score', { topicId: post.topicId, error: String(err) }),
        );

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
          .set({ upvoteCount: sql`${posts.upvoteCount} + ${delta}`, lastActivityAt: new Date() })
          .where(eq(posts.id, postId))
          .returning({ upvoteCount: posts.upvoteCount });

        updatedPost = result;

        updatePostScore(postId).catch((err) =>
          logger.warn(ROUTE, 'Failed to update post score', { postId, error: String(err) }),
        );
        updateTopicScore(post.topicId).catch((err) =>
          logger.warn(ROUTE, 'Failed to update topic score', { topicId: post.topicId, error: String(err) }),
        );

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
        .set({ upvoteCount: sql`${posts.upvoteCount} + ${delta}`, lastActivityAt: new Date() })
        .where(eq(posts.id, postId))
        .returning({ upvoteCount: posts.upvoteCount });

      updatedPost = result;

      updatePostScore(postId).catch((err) =>
        logger.warn(ROUTE, 'Failed to update post score', { postId, error: String(err) }),
      );
      updateTopicScore(post.topicId).catch((err) =>
        logger.warn(ROUTE, 'Failed to update topic score', { topicId: post.topicId, error: String(err) }),
      );

      logger.info(ROUTE, 'Vote created', { userId: session.userId, postId, value });
      return NextResponse.json({ vote: { value }, upvoteCount: updatedPost.upvoteCount });
    }
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
