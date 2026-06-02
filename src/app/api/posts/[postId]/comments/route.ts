import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, comments, topicMembers, users } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { getUserBadges, filterBadgesByTopicProofType } from '@/lib/verification-cache';
import { topics } from '@/lib/db/schema';
import { logger } from '@/lib/logger';
import { updateTopicScore } from '@/lib/topicScore';

const ROUTE = '/api/posts/[postId]/comments';

/**
 * @openapi
 * /api/posts/{postId}/comments:
 *   post:
 *     tags: [Comments]
 *     summary: Create comment on post
 *     description: |
 *       Creates a comment on a post. **Membership required** for posts in private/secret topics;
 *       public-topic comments need only a non-`anon_` nickname. The post's `commentCount` is
 *       bumped atomically and the new comment is returned in the response. Use
 *       `DELETE /api/comments/{commentId}` to soft-delete.
 *     operationId: createComment
 *     x-related-skills: [get-post, delete-comment, set-nickname]
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
    // Comments are much smaller than posts; cap at 10k chars to keep them
    // legible and bound DB storage / payload size.
    const MAX_COMMENT_LENGTH = 10_000;
    if (content.length > MAX_COMMENT_LENGTH) {
      return NextResponse.json(
        { error: `Comment must be ${MAX_COMMENT_LENGTH} characters or less` },
        { status: 400 },
      );
    }

    const [comment] = await db
      .insert(comments)
      .values({
        postId,
        authorId: session.userId,
        content,
        isAI: session.isAI ?? false,
      })
      .returning();

    // Increment commentCount and bump lastActivityAt for sort=active feed.
    await db
      .update(posts)
      .set({ commentCount: sql`${posts.commentCount} + 1`, lastActivityAt: new Date() })
      .where(eq(posts.id, postId));

    updateTopicScore(post.topicId).catch((err) =>
      logger.warn(ROUTE, 'Failed to update topic score', { topicId: post.topicId, error: String(err) }),
    );

    // Fetch author info and badges for the response
    const author = await db.query.users.findFirst({
      where: eq(users.id, session.userId),
      columns: { nickname: true, profileImage: true },
    });

    // Get topic proofType for badge filtering
    const topicForBadge = await db.query.topics.findFirst({
      where: eq(topics.id, post.topicId),
      columns: { proofType: true },
    });

    const allBadges = await getUserBadges(session.userId);
    const badges = filterBadgesByTopicProofType(allBadges, topicForBadge?.proofType ?? null);

    logger.info(ROUTE, 'Comment created', { userId: session.userId, postId, commentId: comment.id });
    return NextResponse.json({
      comment: { ...comment, authorNickname: author?.nickname ?? 'anon', authorProfileImage: author?.profileImage ?? null, badges },
    }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
