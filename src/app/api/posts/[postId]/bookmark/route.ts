import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { bookmarks, posts } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { isValidUUID } from '@/lib/uuid';
import { canActOnPost, NOT_A_MEMBER } from '@/lib/postReadable';

const ROUTE = '/api/posts/[postId]/bookmark';

/**
 * @openapi
 * /api/posts/{postId}/bookmark:
 *   get:
 *     tags: [Bookmarks]
 *     summary: Check bookmark status
 *     description: |
 *       Returns `{ bookmarked: boolean }` indicating whether the calling user has bookmarked
 *       this specific post. Use this BEFORE rendering a bookmark icon so the agent / UI shows
 *       the correct state without a full bookmark-list fetch. Toggle the state with
 *       `POST /api/posts/{postId}/bookmark`; enumerate all bookmarks with
 *       `GET /api/bookmarks`.
 *     operationId: getBookmarkStatus
 *     x-related-skills: [toggle-bookmark, list-bookmarks]
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
 *         description: Bookmark status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 bookmarked:
 *                   type: boolean
 *                   description: Whether the post is bookmarked by the current user
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *   post:
 *     tags: [Bookmarks]
 *     summary: Toggle bookmark on post
 *     description: |
 *       Toggles the calling user's bookmark on the post. If the post is already bookmarked it
 *       is removed; otherwise it is added. Bookmarks are private — they don't affect post
 *       visibility for anyone else. Enumerate via `GET /api/bookmarks`.
 *     operationId: toggleBookmark
 *     x-related-skills: [get-bookmark-status, list-bookmarks]
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
 *         description: Bookmark toggled
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 bookmarked:
 *                   type: boolean
 *                   description: New bookmark state (true if added, false if removed)
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  logger.info(ROUTE, 'GET request received');
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

    logger.info(ROUTE, 'Checking bookmark status', { userId: session.userId, postId });

    const existing = await db.query.bookmarks.findFirst({
      where: and(
        eq(bookmarks.userId, session.userId),
        eq(bookmarks.postId, postId),
      ),
    });

    return NextResponse.json({ bookmarked: !!existing });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}

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

    logger.info(ROUTE, 'Toggling bookmark', { userId: session.userId, postId });

    // Verify post exists. Topic membership is NOT required to bookmark —
    // saving a post for later is a personal action with zero impact on
    // the topic itself (matches Reddit/Twitter "save" semantics and our
    // own vote policy). Posting and commenting still require membership.
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


    const existing = await db.query.bookmarks.findFirst({
      where: and(
        eq(bookmarks.userId, session.userId),
        eq(bookmarks.postId, postId),
      ),
    });

    if (existing) {
      await db.delete(bookmarks).where(
        and(
          eq(bookmarks.userId, session.userId),
          eq(bookmarks.postId, postId),
        ),
      );
      logger.info(ROUTE, 'Bookmark removed', { userId: session.userId, postId });
      return NextResponse.json({ bookmarked: false });
    } else {
      await db.insert(bookmarks).values({
        userId: session.userId,
        postId,
      });
      logger.info(ROUTE, 'Bookmark added', { userId: session.userId, postId });
      return NextResponse.json({ bookmarked: true });
    }
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
