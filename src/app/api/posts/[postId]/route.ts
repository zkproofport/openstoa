import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { posts, comments, topicMembers, users, postTags, tags, votes, topics, records, bookmarks, polls, pollOptions, pollVotes } from '@/lib/db/schema';
import { eq, and, asc, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { extractAndUploadBase64Images } from '@/lib/base64-upload';
import { deleteOrphanedR2Urls } from '@/lib/r2';
import { requireAiCapability } from '@/lib/aiPermissions';

import { getBatchUserBadges, filterBadgesByTopicProofType } from '@/lib/verification-cache';
import { attachPollsToPosts } from '@/lib/polls';
import { isSupportedVideoUrl } from '@/lib/videoUrls';
import { hasNulByte } from '@/lib/textGuard';
type Badge = { type: string; label: string };

const ROUTE = '/api/posts/[postId]';

/**
 * @openapi
 * /api/posts/{postId}:
 *   get:
 *     tags: [Posts]
 *     summary: Get post with comments
 *     description: |
 *       Returns a post with its comment thread and tag list. **Auth is optional** for public
 *       topics — guests can read public-topic posts. Private and secret topic posts require
 *       the caller to be a topic member (401 / 403 otherwise). Each successful GET increments
 *       the post's view counter.
 *     operationId: getPost
 *     security: []
 *     x-related-skills: [list-posts, create-comment]
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
 *   patch:
 *     tags: [Posts]
 *     summary: Edit post
 *     description: |
 *       Updates a post's title, content, media, tags, and/or poll. Only the original author
 *       (or global admin) can edit. Edits are **locked once the post is recorded on-chain**
 *       (`recordCount > 0`) — the API returns 409. Poll options are frozen once any vote
 *       exists (server-side guard); poll question and `closesAt` remain editable.
 *
 *       `content` is HTML with the same image-embed rules as `POST /api/topics/{topicId}/posts`:
 *       upload images via `POST /api/upload` and embed `<img src="$publicUrl">`. Base64 data-URIs
 *       are accepted as a fallback (server uploads them on receive) but URL-embed is preferred.
 *     operationId: editPost
 *     x-related-skills: [create-post, upload-image, record-post]
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
 *             properties:
 *               title:
 *                 type: string
 *                 description: Updated post title (optional)
 *               content:
 *                 type: string
 *                 description: Updated post content (optional)
 *               tags:
 *                 type: array
 *                 description: Replacement tag list (max 5)
 *                 items:
 *                   type: string
 *               media:
 *                 type: object
 *                 description: Replacement media payload
 *                 properties:
 *                   images:
 *                     type: array
 *                     items:
 *                       type: string
 *                   videos:
 *                     type: array
 *                     items:
 *                       type: string
 *               poll:
 *                 type: object
 *                 nullable: true
 *                 description: Replacement poll spec (null drops the poll)
 *     responses:
 *       200:
 *         description: Post updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 post:
 *                   $ref: '#/components/schemas/Post'
 *       400:
 *         description: Bad request (no fields to update)
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       409:
 *         description: Edit locked (post recorded on-chain or poll options frozen)
 *   delete:
 *     tags: [Posts]
 *     summary: Soft-delete post
 *     description: |
 *       Soft-deletes a post — clears `title` / `content` / `media` and sets `isDeleted: true`
 *       with `deletedAt`, but keeps the row so comments and on-chain records still resolve.
 *       Allowed for: author, topic owner, topic admin, or global admin.
 *     operationId: deletePost
 *     x-related-skills: [create-post]
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
 *         description: Post soft-deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   format: uuid
 *                 isDeleted:
 *                   type: boolean
 *                   example: true
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

      // Get post with author (no votes join for guests). `recordCount`
      // is included so the read-only view still shows the on-chain
      // tally; guests can't toggle it but the number is part of the
      // public post shape.
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
          recordCount: posts.recordCount,
          score: posts.score,
          lastActivityAt: posts.lastActivityAt,
          isAI: posts.isAI,
          isDeleted: posts.isDeleted,
          isPinned: posts.isPinned,
          userVoted: sql<number | null>`null`,
          topicTitle: topics.title,
          topicVisibility: topics.visibility,
          topicProofType: topics.proofType,
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

      // Get comments (including soft-deleted)
      const postComments = await db
        .select({
          id: comments.id,
          postId: comments.postId,
          authorId: comments.authorId,
          content: comments.content,
          createdAt: comments.createdAt,
          authorNickname: users.nickname,
          authorProfileImage: users.profileImage,
          deletedAt: comments.deletedAt,
          deletedBy: comments.deletedBy,
          isAI: comments.isAI,
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

      // Strip internal fields from response
      const { topicVisibility: _, topicProofType: topicPT, ...postWithoutVisibility } = post;

      // Collect all user IDs for badge lookup (only non-deleted comments)
      const guestUserIds = [...new Set([
        post.authorId,
        ...postComments.filter((c) => !c.deletedAt).map((c) => c.authorId),
      ].filter(Boolean))] as string[];
      const guestBadgeMap = await getBatchUserBadges(guestUserIds);

      const guestCommentsWithBadges = postComments.map((c) => {
        if (c.deletedAt) {
          return {
            id: c.id,
            postId: c.postId,
            authorId: null,
            content: '',
            createdAt: c.createdAt,
            authorNickname: null,
            authorProfileImage: null,
            isDeleted: true,
            deletedBy: c.deletedBy,
            badges: [],
          };
        }
        return {
          ...c,
          isDeleted: false,
          deletedBy: null,
          badges: filterBadgesByTopicProofType(guestBadgeMap.get(c.authorId) ?? [], topicPT),
        };
      });

      logger.info(ROUTE, 'Guest post detail fetched', { postId, commentCount: postComments.length });
      const guestPost = {
        ...postWithoutVisibility,
        tags: postTagResults,
        badges: filterBadgesByTopicProofType(guestBadgeMap.get(post.authorId) ?? [], topicPT),
      };
      await attachPollsToPosts([guestPost], null);
      return NextResponse.json({ post: guestPost, comments: guestCommentsWithBadges });
    }

    // --- Authenticated access (existing behavior) ---

    logger.info(ROUTE, 'Fetching post detail', { userId: session.userId, postId });

    // Get post with author. `userBookmarked` / `userRecorded` are joined
    // here so the mobile post-detail screen renders the correct filled
    // icons without an extra round-trip per state — the dedicated
    // /bookmark GET is still around for the first paint but the cache
    // patch from a toggle flows through this query on the next refetch.
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
        recordCount: posts.recordCount,
        score: posts.score,
        lastActivityAt: posts.lastActivityAt,
        isAI: posts.isAI,
        isDeleted: posts.isDeleted,
        isPinned: posts.isPinned,
        userVoted: sql<number | null>`${votes.value}`,
        userBookmarked: sql<boolean>`${bookmarks.postId} IS NOT NULL`,
        userRecorded: sql<boolean>`${records.id} IS NOT NULL`,
        topicTitle: topics.title,
        topicProofType: topics.proofType,
      })
      .from(posts)
      .leftJoin(users, eq(posts.authorId, users.id))
      .leftJoin(votes, and(eq(votes.postId, posts.id), eq(votes.userId, session.userId)))
      .leftJoin(
        bookmarks,
        and(eq(bookmarks.postId, posts.id), eq(bookmarks.userId, session.userId)),
      )
      .leftJoin(
        records,
        and(eq(records.postId, posts.id), eq(records.recorderNullifier, session.userId)),
      )
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
      /*
       * Same rule as the topic's post LIST: public and private are readable by
       * any signed-in user, `secret` is members-only. A detail page that 403s
       * on a post whose list row was just shown is the drift this mirrors away.
       */
      const topicCheck = await db.query.topics.findFirst({
        where: eq(topics.id, post.topicId),
        columns: { visibility: true },
      });
      const readableToSignedIn =
        topicCheck?.visibility === 'public' || topicCheck?.visibility === 'private';
      if (!topicCheck || !readableToSignedIn) {
        logger.warn(ROUTE, 'User is not a member of the post topic', { userId: session.userId, postId, topicId: post.topicId });
        return NextResponse.json(
          { error: 'Not a member of this topic' },
          { status: 403 },
        );
      }
    }

    // Atomically increment viewCount
    await db.update(posts).set({ viewCount: sql`${posts.viewCount} + 1` }).where(eq(posts.id, postId));

    // Get comments with author nicknames (including soft-deleted)
    const postComments = await db
      .select({
        id: comments.id,
        postId: comments.postId,
        authorId: comments.authorId,
        content: comments.content,
        createdAt: comments.createdAt,
        authorNickname: users.nickname,
        authorProfileImage: users.profileImage,
        deletedAt: comments.deletedAt,
        deletedBy: comments.deletedBy,
        isAI: comments.isAI,
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

    // Collect all user IDs for badge lookup (only non-deleted comments)
    const allUserIds = [...new Set([
      post.authorId,
      ...postComments.filter((c) => !c.deletedAt).map((c) => c.authorId),
    ].filter(Boolean))] as string[];
    const badgeMap = await getBatchUserBadges(allUserIds);

    const { topicProofType: authTopicPT, ...postWithoutProofType } = post;

    const commentsWithBadges = postComments.map((c) => {
      if (c.deletedAt) {
        return {
          id: c.id,
          postId: c.postId,
          authorId: null,
          content: '',
          createdAt: c.createdAt,
          authorNickname: null,
          authorProfileImage: null,
          isDeleted: true,
          deletedBy: c.deletedBy,
          badges: [],
        };
      }
      return {
        ...c,
        isDeleted: false,
        deletedBy: null,
        badges: filterBadgesByTopicProofType(badgeMap.get(c.authorId) ?? [], authTopicPT),
      };
    });

    logger.info(ROUTE, 'Post detail fetched', { userId: session.userId, postId, commentCount: postComments.length });
    const authPost = {
      ...postWithoutProofType,
      tags: postTagResults,
      badges: filterBadgesByTopicProofType(badgeMap.get(post.authorId) ?? [], authTopicPT),
      // Used by the mobile post detail to render a "Joined" badge next
      // to the topic title (parity with the topic list card).
      isJoinedTopic: !!membership,
    };
    await attachPollsToPosts([authPost], session.userId);
    return NextResponse.json({ post: authPost, comments: commentsWithBadges });
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

    // Profile-level AI capability (design §7): an isAI caller must hold the
    // post/delete capability in its owner's profile. Humans unaffected.
    const deleteGate = await requireAiCapability(db, session, '/openstoa/post/delete');
    if (deleteGate) {
      logger.warn(ROUTE, 'AI caller lacks post/delete capability', { userId: session.userId, postId });
      return deleteGate;
    }

    logger.info(ROUTE, 'Deleting post', { userId: session.userId, postId });

    // Check post exists. We also fetch `media` so we can purge any
    // R2-backed images from storage after the soft-delete settles.
    const postResults = await db
      .select({
        id: posts.id,
        authorId: posts.authorId,
        topicId: posts.topicId,
        isDeleted: posts.isDeleted,
        media: posts.media,
      })
      .from(posts)
      .where(eq(posts.id, postId));

    if (postResults.length === 0) {
      logger.warn(ROUTE, 'Post not found for deletion', { postId });
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const post = postResults[0];

    if (post.isDeleted) {
      logger.warn(ROUTE, 'Post already deleted', { postId });
      return NextResponse.json({ id: post.id, isDeleted: true });
    }

    // Allow author, topic owner/admin, or global admin
    const isAdmin = session.role === 'admin';
    if (post.authorId !== session.userId && !isAdmin) {
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

    // Soft delete — clear title/content/media but keep the row so comments
    // and on-chain records still resolve. Mirrors comments' soft-delete pattern.
    await db
      .update(posts)
      .set({
        isDeleted: true,
        deletedAt: new Date(),
        title: '',
        content: '',
        media: null,
        updatedAt: new Date(),
      })
      .where(eq(posts.id, postId));

    // R2 orphan purge — every image attached to this post is now unreachable
    // through the post, so delete the objects from the bucket. Failures are
    // logged inside `deleteOrphanedR2Urls`; we don't want a flaky R2 to
    // block the user-facing soft-delete response.
    try {
      const prevImages = (post.media as { images?: string[] } | null)?.images ?? [];
      if (prevImages.length > 0) {
        await deleteOrphanedR2Urls(prevImages, []);
      }
    } catch (cleanupErr) {
      logger.error(ROUTE, 'R2 cleanup on DELETE failed', {
        postId,
        error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
      });
    }

    logger.info(ROUTE, 'Post soft-deleted', { userId: session.userId, postId });
    return NextResponse.json({ id: postId, isDeleted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in DELETE', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ postId: string }> },
) {
  logger.info(ROUTE, 'PATCH request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated PATCH request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { postId } = await params;

    // Profile-level AI capability (design §7): an isAI editor must hold the
    // post/write capability in its owner's profile. Humans unaffected.
    const writeGate = await requireAiCapability(db, session, '/openstoa/post/write');
    if (writeGate) {
      logger.warn(ROUTE, 'AI caller lacks post/write capability', { userId: session.userId, postId });
      return writeGate;
    }

    const body = await request.json();
    const { title, content, tags: tagNames, media: mediaIn, poll: pollIn } = body;

    // At least one editable field must be provided
    if (title === undefined && content === undefined && tagNames === undefined && mediaIn === undefined && pollIn === undefined) {
      logger.warn(ROUTE, 'No fields to update', { userId: session.userId, postId });
      return NextResponse.json({ error: 'At least one editable field is required' }, { status: 400 });
    }

    logger.info(ROUTE, 'Editing post', { userId: session.userId, postId });

    // Check post exists. We pull `media` so we can diff the old image set
    // against the incoming one and purge anything the user removed.
    const postResults = await db
      .select({
        id: posts.id,
        authorId: posts.authorId,
        topicId: posts.topicId,
        recordCount: posts.recordCount,
        isDeleted: posts.isDeleted,
        media: posts.media,
      })
      .from(posts)
      .where(eq(posts.id, postId));

    if (postResults.length === 0) {
      logger.warn(ROUTE, 'Post not found for edit', { postId });
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const post = postResults[0];

    if (post.isDeleted) {
      logger.warn(ROUTE, 'Edit attempt on soft-deleted post', { postId });
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    // Edits are locked once the post is recorded on-chain. 409 lets the
    // client distinguish "locked" from generic Forbidden and show a friendly
    // message ("온체인 기록 이후엔 수정할 수 없어요").
    if ((post.recordCount ?? 0) > 0) {
      logger.warn(ROUTE, 'Edit attempt on on-chain recorded post', { postId, recordCount: post.recordCount });
      return NextResponse.json({ error: 'Post is locked after on-chain record' }, { status: 409 });
    }

    // Allow author or global admin
    const isAdmin = session.role === 'admin';
    if (post.authorId !== session.userId && !isAdmin) {
      logger.warn(ROUTE, 'Non-author edit attempt', { userId: session.userId, authorId: post.authorId, postId });
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Author must still be a member of the topic (admin bypass).
    if (!isAdmin) {
      const membership = await db.query.topicMembers.findFirst({
        where: and(
          eq(topicMembers.topicId, post.topicId),
          eq(topicMembers.userId, session.userId),
        ),
      });

      if (!membership) {
        logger.warn(ROUTE, 'User is not a member of the post topic', { userId: session.userId, postId, topicId: post.topicId });
        return NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 });
      }
    }

    // Build update payload
    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };

    if (title !== undefined && typeof title === 'string') {
      if (title.length > 200) {
        return NextResponse.json({ error: 'Title must be 200 characters or less' }, { status: 400 });
      }
      // Postgres text storage cannot hold a NUL byte (see src/lib/textGuard.ts).
      if (hasNulByte(title)) {
        return NextResponse.json({ error: 'Title must not contain a NUL byte' }, { status: 400 });
      }
      updateData.title = title;
    }

    if (content !== undefined && typeof content === 'string') {
      // Server-side parity with the POST cap. Bigger payloads are cheap to
      // reject up front and keep `?q=` search predictable.
      const MAX_CONTENT_LENGTH = 50_000;
      if (content.length > MAX_CONTENT_LENGTH) {
        return NextResponse.json(
          { error: `Content must be ${MAX_CONTENT_LENGTH} characters or less` },
          { status: 400 },
        );
      }
      if (hasNulByte(content)) {
        return NextResponse.json({ error: 'Content must not contain a NUL byte' }, { status: 400 });
      }
      // Extract base64 images from content and upload to R2
      // Filed under the post's OWN topic, so a topic deletion sweeps it (M-3).
      updateData.content = await extractAndUploadBase64Images(content, session.userId, post.topicId);
    }

    const MAX_IMAGES = 10;
    const MAX_VIDEOS = 3;
    const MAX_TAGS = 5;

    if (mediaIn !== undefined) {
      // Normalise the same way the POST route does — null when both arrays
      // empty. Server-side caps mirror the mobile composer so an AI / CLI
      // client can't bypass them.
      let mediaErr: string | null = null;
      const normalisedMedia = (() => {
        if (!mediaIn || typeof mediaIn !== 'object') return null;
        const images = Array.isArray(mediaIn.images)
          ? (mediaIn.images as unknown[]).filter((u): u is string => typeof u === 'string' && u.length > 0)
          : [];
        const videos = Array.isArray(mediaIn.videos)
          ? (mediaIn.videos as unknown[]).filter((u): u is string => typeof u === 'string' && u.length > 0)
          : [];
        if (images.length > MAX_IMAGES) {
          mediaErr = `Too many images (max ${MAX_IMAGES})`;
          return null;
        }
        if (videos.length > MAX_VIDEOS) {
          mediaErr = `Too many videos (max ${MAX_VIDEOS})`;
          return null;
        }
        const badImage = images.find((u) => !/^https?:\/\//i.test(u));
        if (badImage) {
          mediaErr = `Invalid image URL: ${badImage}`;
          return null;
        }
        const badVideo = videos.find((u) => !isSupportedVideoUrl(u));
        if (badVideo) {
          mediaErr = `Unsupported video URL (YouTube or Vimeo only): ${badVideo}`;
          return null;
        }
        if (images.length === 0 && videos.length === 0) return null;
        return {
          ...(images.length > 0 ? { images } : {}),
          ...(videos.length > 0 ? { videos } : {}),
        };
      })();
      if (mediaErr) {
        return NextResponse.json({ error: mediaErr }, { status: 400 });
      }
      updateData.media = normalisedMedia;
    }
    if (Array.isArray(tagNames) && tagNames.length > MAX_TAGS) {
      return NextResponse.json(
        { error: `Too many tags (max ${MAX_TAGS})` },
        { status: 400 },
      );
    }

    // Update the post
    const [updatedPost] = await db
      .update(posts)
      .set(updateData)
      .where(eq(posts.id, postId))
      .returning();

    // R2 orphan purge — when the caller passed a new media object, diff the
    // old image list against the new one and delete anything that was
    // dropped. Skipped when the caller didn't touch `media` (so editing only
    // tags/title doesn't risk nuking attachments).
    if (mediaIn !== undefined) {
      try {
        const prevImages = (post.media as { images?: string[] } | null)?.images ?? [];
        const nextImages = (updateData.media as { images?: string[] } | null)?.images ?? [];
        if (prevImages.length > 0) {
          await deleteOrphanedR2Urls(prevImages, nextImages);
        }
      } catch (cleanupErr) {
        logger.error(ROUTE, 'R2 cleanup on PATCH failed', {
          postId,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
    }

    // Replace tags if provided. Wipe existing postTags rows then re-link.
    if (Array.isArray(tagNames)) {
      await db.delete(postTags).where(eq(postTags.postId, postId));

      const validTagNames = (tagNames as unknown[])
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
        .slice(0, 5);

      for (const tagName of validTagNames) {
        const slug = tagName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9가-힣]+/g, '-')
          .replace(/^-|-$/g, '');
        if (!slug) continue;

        const [tag] = await db
          .insert(tags)
          .values({ name: tagName.trim(), slug })
          .onConflictDoUpdate({
            target: tags.slug,
            set: { postCount: sql`${tags.postCount} + 1` },
          })
          .returning();

        await db.insert(postTags).values({ postId, tagId: tag.id }).onConflictDoNothing();
      }
    }

    // Poll updates. If `pollIn` is `null`, drop the poll. If an object is
    // provided, update the question/closesAt; options stay FROZEN when
    // any vote already exists on the poll.
    if (pollIn !== undefined) {
      const existingPoll = await db.query.polls.findFirst({ where: eq(polls.postId, postId) });

      if (pollIn === null) {
        // Allow drop only if no votes exist — otherwise the historical record matters.
        if (existingPoll) {
          const [{ count: voteCount } = { count: 0 }] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(pollVotes)
            .where(eq(pollVotes.pollId, existingPoll.id));
          if ((voteCount ?? 0) > 0) {
            return NextResponse.json({ error: 'Cannot remove poll after votes exist' }, { status: 409 });
          }
          await db.delete(polls).where(eq(polls.id, existingPoll.id));
        }
      } else if (typeof pollIn === 'object') {
        if (!existingPoll) {
          // No existing poll → treat the payload like a creation.
          if (Array.isArray(pollIn.options)) {
            const { createPollForPost } = await import('@/lib/polls');
            try {
              await createPollForPost(postId, {
                question: typeof pollIn.question === 'string' ? pollIn.question : undefined,
                options: pollIn.options as string[],
                multipleChoice: !!pollIn.multipleChoice,
                closesAt: typeof pollIn.closesAt === 'string' ? pollIn.closesAt : undefined,
              });
            } catch (pollErr) {
              return NextResponse.json({ error: pollErr instanceof Error ? pollErr.message : String(pollErr) }, { status: 400 });
            }
          }
        } else {
          // Edit existing poll. question + closesAt always allowed. Options
          // FROZEN when any vote exists (server-side guard for the
          // mobile spec).
          const [{ count: voteCount } = { count: 0 }] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(pollVotes)
            .where(eq(pollVotes.pollId, existingPoll.id));

          const pollUpdate: Record<string, unknown> = {};
          if (typeof pollIn.question === 'string') {
            pollUpdate.question = pollIn.question.trim() || null;
          }
          if (pollIn.closesAt === null) {
            pollUpdate.closesAt = null;
          } else if (typeof pollIn.closesAt === 'string') {
            const closesAt = new Date(pollIn.closesAt);
            if (Number.isNaN(closesAt.getTime())) {
              return NextResponse.json({ error: 'Invalid closesAt timestamp' }, { status: 400 });
            }
            pollUpdate.closesAt = closesAt;
          }
          if (Object.keys(pollUpdate).length > 0) {
            await db.update(polls).set(pollUpdate).where(eq(polls.id, existingPoll.id));
          }

          // Option edits: only allowed when no votes yet.
          if (Array.isArray(pollIn.options)) {
            if ((voteCount ?? 0) > 0) {
              return NextResponse.json({ error: 'Poll options are frozen after votes exist' }, { status: 409 });
            }
            const opts = (pollIn.options as unknown[])
              .map((o) => (typeof o === 'string' ? o.trim() : ''))
              .filter((o) => o.length > 0 && o.length <= 80);
            if (opts.length < 2 || opts.length > 4) {
              return NextResponse.json({ error: 'Poll must have 2 to 4 options' }, { status: 400 });
            }
            await db.delete(pollOptions).where(eq(pollOptions.pollId, existingPoll.id));
            await db.insert(pollOptions).values(opts.map((text, i) => ({ pollId: existingPoll.id, text, position: i })));
          }
        }
      }
    }

    logger.info(ROUTE, 'Post edited', { userId: session.userId, postId });
    return NextResponse.json({ post: updatedPost });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in PATCH', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
