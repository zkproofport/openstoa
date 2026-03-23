import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, comments, topicMembers, users, postTags, tags, votes, topics } from '@/lib/db/schema';
import { eq, and, asc, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';

import { getBatchUserBadges } from '@/lib/verification-cache';
type Badge = { type: string; label: string };

const ROUTE = '/api/posts/[postId]';

/**
 * @openapi
 * /api/posts/{postId}:
 *   get:
 *     tags: [Posts]
 *     summary: Get post with comments
 *     description: >-
 *       Authentication optional for posts in public topics. Guests can read posts and comments
 *       in public topics. Private and secret topic posts require authentication.
 *       Increments the view counter.
 *     operationId: getPost
 *     security: []
 *     parameters:
 *       - name: postId
 *         in: path
 *         required: true
 *         description: Post ID
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Post detail with comments and tags
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 post:
 *                   allOf:
 *                     - $ref: '#/components/schemas/Post'
 *                     - type: object
 *                       properties:
 *                         topicTitle:
 *                           type: string
 *                           description: Title of the parent topic
 *                 comments:
 *                   type: array
 *                   description: Comments on the post
 *                   items:
 *                     $ref: '#/components/schemas/Comment'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *   delete:
 *     tags: [Posts]
 *     summary: Delete post
 *     description: >-
 *       Deletes a post and all its comments. Only the author, topic owner, or topic admin can delete.
 *     operationId: deletePost
 *     parameters:
 *       - name: postId
 *         in: path
 *         required: true
 *         description: Post ID
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Post deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                   description: Deletion success indicator
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    const { postId } = await params;

    // --- Guest (unauthenticated) access ---
    if (!session) {
      logger.info(ROUTE, 'Guest fetching post detail', { postId });

      // Get post with author (no votes join for guests)
      const postResults = await db
        .select({
          id: posts.id,
          topicId: posts.topicId,
          authorId: posts.authorId,
          title: posts.title,
          content: posts.content,
          createdAt: posts.createdAt,
          updatedAt: posts.updatedAt,
          authorNickname: users.nickname,
          authorProfileImage: users.profileImage,
          upvoteCount: posts.upvoteCount,
          viewCount: posts.viewCount,
          commentCount: posts.commentCount,
          score: posts.score,
          userVoted: sql<number | null>`null`,
          topicTitle: topics.title,
          topicVisibility: topics.visibility,
        })
        .from(posts)
        .leftJoin(users, eq(posts.authorId, users.id))
        .leftJoin(topics, eq(posts.topicId, topics.id))
        .where(eq(posts.id, postId));

      if (postResults.length === 0) {
        logger.warn(ROUTE, 'Post not found', { postId });
        return NextResponse.json({ error: 'Post not found' }, { status: 404 });
      }

      const post = postResults[0];

      // Guests can only read posts in public topics
      if (post.topicVisibility !== 'public') {
        logger.warn(ROUTE, 'Guest attempted to read non-public topic post', { postId, topicId: post.topicId, visibility: post.topicVisibility });
        return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
      }

      // Increment viewCount
      await db.update(posts).set({ viewCount: sql`${posts.viewCount} + 1` }).where(eq(posts.id, postId));

      // Get comments
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

      // Fetch tags
      const postTagResults = await db
        .select({ name: tags.name, slug: tags.slug })
        .from(postTags)
        .innerJoin(tags, eq(postTags.tagId, tags.id))
        .where(eq(postTags.postId, postId));

      // Strip topicVisibility from response
      const { topicVisibility: _, ...postWithoutVisibility } = post;

      // Collect all user IDs for badge lookup
      const guestUserIds = [...new Set([
        post.authorId,
        ...postComments.map((c) => c.authorId),
      ].filter(Boolean))] as string[];
      const guestBadgeMap = await getBatchUserBadges(guestUserIds);

      const guestCommentsWithBadges = postComments.map((c) => ({
        ...c,
        badges: guestBadgeMap.get(c.authorId) ?? [],
      }));

      logger.info(ROUTE, 'Guest post detail fetched', { postId, commentCount: postComments.length });
      return NextResponse.json({
        post: { ...postWithoutVisibility, tags: postTagResults, badges: guestBadgeMap.get(post.authorId) ?? [] },
        comments: guestCommentsWithBadges,
      });
    }

    // --- Authenticated access (existing behavior) ---

    logger.info(ROUTE, 'Fetching post detail', { userId: session.userId, postId });

    // Get post with author
    const postResults = await db
      .select({
        id: posts.id,
        topicId: posts.topicId,
        authorId: posts.authorId,
        title: posts.title,
        content: posts.content,
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

    // Collect all user IDs for badge lookup
    const allUserIds = [...new Set([
      post.authorId,
      ...postComments.map((c) => c.authorId),
    ].filter(Boolean))] as string[];
    const badgeMap = await getBatchUserBadges(allUserIds);

    const commentsWithBadges = postComments.map((c) => ({
      ...c,
      badges: badgeMap.get(c.authorId) ?? [],
    }));

    logger.info(ROUTE, 'Post detail fetched', { userId: session.userId, postId, commentCount: postComments.length });
    return NextResponse.json({
      post: { ...post, tags: postTagResults, badges: badgeMap.get(post.authorId) ?? [] },
      comments: commentsWithBadges,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  logger.info(ROUTE, 'DELETE request received');
  try {
    const session = await getSession(request);
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
