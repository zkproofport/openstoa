import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, records, users, topics, votes, tags, postTags } from '@/lib/db/schema';
import { eq, and, desc, sql, ilike, or, inArray } from 'drizzle-orm';
import { attachReactionsToPosts } from '@/lib/reactions';
import { attachUserFlagsToPosts } from '@/lib/userPostFlags';
import { attachPollsToPosts } from '@/lib/polls';
import { attachTagsToPosts } from '@/lib/postTags';
import { txExplorerUrl } from '@/lib/explorer';
import { normaliseSearchQuery } from '@/lib/search';
import { logger } from '@/lib/logger';

const ROUTE = '/api/my/recorded';

/**
 * @openapi
 * /api/my/recorded:
 *   get:
 *     tags: [MyActivity]
 *     summary: List posts the current user has recorded on-chain
 *     description: >-
 *       Lists posts the current user has recorded (via the on-chain record
 *       action), sorted by the recording timestamp (newest first). This is
 *       the "my activity" view — distinct from /api/recorded which returns
 *       community-wide posts with any record activity.
 *     operationId: listMyRecorded
 *     parameters:
 *       - name: limit
 *         in: query
 *         required: false
 *         description: Number of posts to return (max 100)
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 100
 *       - name: offset
 *         in: query
 *         required: false
 *         description: Number of posts to skip
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       '200':
 *         description: Posts the current user has recorded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 posts:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Post'
 *       '401':
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10);
    const qPattern = normaliseSearchQuery(searchParams.get('q'));

    // Resolve post-tag matches for keyword search
    let qTagPostIds: Set<string> | null = null;
    if (qPattern) {
      const rows = await db
        .select({ postId: postTags.postId })
        .from(postTags)
        .innerJoin(tags, eq(postTags.tagId, tags.id))
        .where(or(ilike(tags.name, qPattern), ilike(tags.slug, qPattern))!);
      qTagPostIds = new Set(rows.map((r) => r.postId));
    }

    // Build WHERE: recorder filter + optional keyword search
    const recorderClause = eq(records.recorderNullifier, session.userId);
    const whereClause = (() => {
      if (!qPattern) return recorderClause;
      const tagIdsArray = qTagPostIds ? [...qTagPostIds] : [];
      const tagMatchClause = tagIdsArray.length > 0 ? inArray(posts.id, tagIdsArray) : null;
      const titleContent = or(ilike(posts.title, qPattern), ilike(posts.content, qPattern));
      const qClause = tagMatchClause ? or(titleContent, tagMatchClause)! : titleContent!;
      return and(recorderClause, qClause);
    })();

    const recordedPosts = await db
      .select({
        id: posts.id,
        topicId: posts.topicId,
        authorId: posts.authorId,
        title: posts.title,
        content: posts.content,
        media: posts.media,
        createdAt: posts.createdAt,
        authorNickname: users.nickname,
        authorProfileImage: users.profileImage,
        upvoteCount: posts.upvoteCount,
        viewCount: posts.viewCount,
        commentCount: posts.commentCount,
        recordCount: posts.recordCount,
        isPinned: posts.isPinned,
        isAI: posts.isAI,
        userVoted: sql<number | null>`${votes.value}`,
        topicTitle: topics.title,
        recordedAt: records.createdAt,
        // Capture the specific record THIS user created on this post —
        // there's exactly one because of the (postId, recorderNullifier)
        // unique index. The mobile profile screen renders a tappable
        // BaseScan link straight from `myTxExplorerUrl`.
        myTxHash: records.txHash,
      })
      .from(records)
      .innerJoin(posts, eq(records.postId, posts.id))
      .leftJoin(users, eq(posts.authorId, users.id))
      .leftJoin(topics, eq(posts.topicId, topics.id))
      .leftJoin(
        votes,
        and(eq(votes.postId, posts.id), eq(votes.userId, session.userId)),
      )
      .where(whereClause)
      .orderBy(desc(records.createdAt))
      .limit(limit)
      .offset(offset);

    const flagged = await attachUserFlagsToPosts(recordedPosts, session.userId);
    const withReactions = await attachReactionsToPosts(flagged, session.userId);
    await attachPollsToPosts(withReactions, session.userId);
    await attachTagsToPosts(withReactions);
    const postsWithReactions = withReactions.map((p) => ({
      ...p,
      myTxExplorerUrl: txExplorerUrl(p.myTxHash),
    }));

    logger.info(ROUTE, 'Recorded posts fetched', {
      userId: session.userId,
      count: recordedPosts.length,
    });
    return NextResponse.json({ posts: postsWithReactions });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
