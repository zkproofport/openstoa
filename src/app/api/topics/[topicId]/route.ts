import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import {
  topics,
  topicMembers,
  categories,
  posts,
  comments,
  records,
  chatMedia,
  chatMessages,
  joinRequests,
  mlsGroups,
  mlsCommits,
  takBundles,
  chatArchive,
  archiveHolders,
  keyRequests,
} from '@/lib/db/schema';
import { eq, and, count, inArray } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { isValidUUID } from '@/lib/uuid';
import { buildProofRequirement } from '@/lib/proof-guides';
import { extractAndUploadBase64Images } from '@/lib/base64-upload';
import { deleteR2Prefix, topicObjectPrefix } from '@/lib/r2';
import { hasNulByte } from '@/lib/textGuard';
import { PERSONAL_TOPIC_CLOSED } from '@/lib/personalTopic';

const ROUTE = '/api/topics/[topicId]';

/**
 * @openapi
 * /api/topics/{topicId}:
 *   get:
 *     tags: [Topics]
 *     summary: Get topic detail
 *     description: >-
 *       Authentication optional. Guests can view public and private topic details.
 *       Secret topics return 404 for unauthenticated users. Authenticated users must be
 *       members to view a topic; non-members receive 403.
 *     operationId: getTopic
 *     security: []
 *     x-related-skills: [list-topics, join-topic]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Topic detail with current user role
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 topic:
 *                   allOf:
 *                     - $ref: '#/components/schemas/Topic'
 *                     - type: object
 *                       properties:
 *                         memberCount:
 *                           type: integer
 *                           description: Number of members in the topic
 *                 currentUserRole:
 *                   type: string
 *                   enum: [owner, admin, member]
 *                   nullable: true
 *                   description: Current user's role in the topic (null for guests)
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Not a member of this topic (authenticated users only)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    const { topicId } = await params;
    if (!isValidUUID(topicId)) {
      return NextResponse.json({ error: 'Invalid topicId' }, { status: 400 });
    }

    // --- Guest (unauthenticated) access ---
    if (!session) {
      logger.info(ROUTE, 'Guest fetching topic detail', { topicId });

      const topic = await db.query.topics.findFirst({
        where: eq(topics.id, topicId),
      });

      if (!topic) {
        logger.warn(ROUTE, 'Topic not found', { topicId });
        return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
      }

      // Secret topics are invisible to guests
      if (topic.visibility === 'secret') {
        logger.warn(ROUTE, 'Guest attempted to access secret topic', { topicId });
        return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
      }

      const [memberCount] = await db
        .select({ count: count() })
        .from(topicMembers)
        .where(eq(topicMembers.topicId, topicId));

      // Fetch category info if topic has one
      let category = null;
      if (topic.categoryId) {
        const cat = await db.query.categories.findFirst({
          where: eq(categories.id, topic.categoryId),
        });
        if (cat) {
          category = { id: cat.id, name: cat.name, slug: cat.slug, icon: cat.icon };
        }
      }

      // Build proof requirement for non-members
      const effectiveProofType = topic.proofType || (topic.requiresCountryProof ? 'country' : 'none');
      const proofRequirement = effectiveProofType !== 'none'
        ? buildProofRequirement(effectiveProofType, {
            domain: topic.requiredDomain,
            allowedCountries: topic.allowedCountries,
          })
        : null;

      logger.info(ROUTE, 'Guest topic detail fetched', { topicId, memberCount: memberCount.count });
      return NextResponse.json({
        topic: {
          ...topic,
          category,
          memberCount: memberCount.count,
          isMember: false,
        },
        currentUserRole: null,
        proofRequirement,
      });
    }

    // --- Authenticated access (existing behavior) ---

    logger.info(ROUTE, 'Fetching topic detail', { userId: session.userId, topicId });

    // Check membership
    const membership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    const topic = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
    });

    if (!topic) {
      logger.warn(ROUTE, 'Topic not found', { topicId });
      return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
    }

    // Secret topics require membership
    if (!membership && topic.visibility === 'secret') {
      logger.warn(ROUTE, 'Non-member accessing secret topic', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
    }

    // Get member count
    const [memberCount] = await db
      .select({ count: count() })
      .from(topicMembers)
      .where(eq(topicMembers.topicId, topicId));

    // Fetch category info if topic has one
    let category = null;
    if (topic.categoryId) {
      const cat = await db.query.categories.findFirst({
        where: eq(categories.id, topic.categoryId),
      });
      if (cat) {
        category = { id: cat.id, name: cat.name, slug: cat.slug, icon: cat.icon };
      }
    }

    const isMember = !!membership;

    // Build proof requirement for non-members
    let proofRequirement = null;
    if (!isMember) {
      const effectiveProofType = topic.proofType || (topic.requiresCountryProof ? 'country' : 'none');
      if (effectiveProofType !== 'none') {
        proofRequirement = buildProofRequirement(effectiveProofType, {
          domain: topic.requiredDomain,
          allowedCountries: topic.allowedCountries,
        });
      }
    }

    logger.info(ROUTE, 'Topic detail fetched', { topicId, memberCount: memberCount.count, isMember });
    return NextResponse.json({
      topic: {
        ...topic,
        category,
        memberCount: memberCount.count,
        isMember,
      },
      currentUserRole: membership?.role ?? null,
      proofRequirement,
    });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}

/**
 * @openapi
 * /api/topics/{topicId}:
 *   patch:
 *     tags: [Topics]
 *     summary: Edit topic
 *     description: >-
 *       Only the topic owner can edit. Editable fields: title, description, image.
 *       At least one field must be provided.
 *     operationId: editTopic
 *     x-related-skills: [create-topic, upload-image]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID
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
 *                 description: New topic title
 *               description:
 *                 type: string
 *                 nullable: true
 *                 description: New topic description
 *               image:
 *                 type: string
 *                 nullable: true
 *                 description: New topic image URL (or base64 data URI)
 *     responses:
 *       200:
 *         description: Topic updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 topic:
 *                   $ref: '#/components/schemas/Topic'
 *       400:
 *         description: No fields to update
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Not the topic owner
 *       404:
 *         description: Topic not found
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'PATCH request received');
  try {
    const session = await getSession(request);
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;
    if (!isValidUUID(topicId)) {
      return NextResponse.json({ error: 'Invalid topicId' }, { status: 400 });
    }

    const topic = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
    });

    if (!topic) {
      return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
    }

    if (topic.creatorId !== session.userId) {
      logger.warn(ROUTE, 'Non-owner attempted to edit topic', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Only the topic owner can edit' }, { status: 403 });
    }

    const body = await request.json();
    const { title, description, image } = body;

    // At least one field must be provided
    const hasTitle = title !== undefined && title !== null;
    const hasDescription = description !== undefined;
    const hasImage = image !== undefined;

    if (!hasTitle && !hasDescription && !hasImage) {
      return NextResponse.json({ error: 'At least one field (title, description, image) is required' }, { status: 400 });
    }

    const updateData: Record<string, unknown> = {};
    updateData.updatedAt = new Date();

    if (hasTitle) {
      if (typeof title !== 'string' || !title.trim()) {
        return NextResponse.json({ error: 'Title cannot be empty' }, { status: 400 });
      }
      // Postgres text storage cannot hold a NUL byte (see src/lib/textGuard.ts).
      if (hasNulByte(title)) {
        return NextResponse.json({ error: 'Title must not contain a NUL byte' }, { status: 400 });
      }
      updateData.title = title.trim();
    }

    if (hasDescription) {
      const normalizedDescription = description ? String(description).trim() : null;
      if (normalizedDescription && hasNulByte(normalizedDescription)) {
        return NextResponse.json({ error: 'Description must not contain a NUL byte' }, { status: 400 });
      }
      updateData.description = normalizedDescription;
    }

    if (hasImage) {
      let imageValue = image;
      // If image contains base64 data, extract and upload to R2
      if (imageValue && typeof imageValue === 'string' && imageValue.includes('base64,')) {
        imageValue = await extractAndUploadBase64Images(
          `<img src="${imageValue}">`,
          session.userId,
          topicId,
        );
        // Extract the URL from the processed HTML
        const urlMatch = imageValue.match(/src="([^"]+)"/);
        imageValue = urlMatch ? urlMatch[1] : image;
      }
      updateData.image = imageValue || null;
    }

    const [updated] = await db
      .update(topics)
      .set(updateData)
      .where(eq(topics.id, topicId))
      .returning();

    logger.info(ROUTE, 'Topic updated', { userId: session.userId, topicId, fields: Object.keys(updateData) });
    return NextResponse.json({ topic: updated });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'PATCH', error);
  }
}

/**
 * @openapi
 * /api/topics/{topicId}:
 *   delete:
 *     tags: [Topics]
 *     summary: Delete topic
 *     description: >-
 *       Hard-deletes a topic and all related data (posts, comments, records, chat,
 *       members, join requests). Only the topic owner or a global admin may invoke
 *       this. The deletion is performed inside a single transaction.
 *     operationId: deleteTopic
 *     x-related-skills: [create-topic]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Topic deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted:
 *                   type: boolean
 *                 topicId:
 *                   type: string
 *                   format: uuid
 *                 deletedPostCount:
 *                   type: integer
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Not the topic owner or global admin
 *       404:
 *         description: Topic not found
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'DELETE request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated DELETE request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;
    if (!isValidUUID(topicId)) {
      return NextResponse.json({ error: 'Invalid topicId' }, { status: 400 });
    }

    const topic = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
    });

    if (!topic) {
      logger.warn(ROUTE, 'Topic not found for deletion', { topicId });
      return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
    }

    /*
     * A personal space cannot be deleted, because it would not come back.
     *
     * It is made once, when the account is — not on every sign-in — so a
     * successful DELETE here is permanent, and the person is left with a
     * product that used to have a private space and now does not, with nothing
     * to press to get it back. Emptying it is what they actually want in that
     * moment, and deleting the posts and messages inside still works.
     *
     * Deleting the ACCOUNT still removes it; that path takes the space with the
     * account rather than stranding either one.
     */
    if (topic.personal) {
      return NextResponse.json({ error: PERSONAL_TOPIC_CLOSED }, { status: 403 });
    }

    // Authorization: global admin OR topic owner (topicMembers.role = 'owner').
    // We also accept topic.creatorId === session.userId as owner — creator is
    // always inserted as 'owner' on POST, but checking both keeps us safe if
    // the ownership row was ever rewritten manually.
    const isGlobalAdmin = session.role === 'admin';
    let isOwner = topic.creatorId === session.userId;
    if (!isOwner && !isGlobalAdmin) {
      const membership = await db.query.topicMembers.findFirst({
        where: and(
          eq(topicMembers.topicId, topicId),
          eq(topicMembers.userId, session.userId),
        ),
      });
      isOwner = membership?.role === 'owner';
    }

    if (!isOwner && !isGlobalAdmin) {
      logger.warn(ROUTE, 'Unauthorized topic delete attempt', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Only the topic owner or admin can delete this topic' }, { status: 403 });
    }

    logger.info(ROUTE, 'Deleting topic', { userId: session.userId, topicId, isGlobalAdmin });

    // Resolve all post IDs once so we can clear post-level rows that don't
    // cascade (comments, records) before deleting the posts themselves.
    const topicPosts = await db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.topicId, topicId));
    const postIds = topicPosts.map((p) => p.id);

    await db.transaction(async (tx) => {
      if (postIds.length > 0) {
        // comments and records have no FK cascade, clear them first.
        await tx.delete(comments).where(inArray(comments.postId, postIds));
        await tx.delete(records).where(inArray(records.postId, postIds));
        // Deleting posts cascades to polls, postTags, bookmarks, reactions, votes
        // (and poll_options, poll_votes via polls cascade).
        await tx.delete(posts).where(eq(posts.topicId, topicId));
      }
      await tx.delete(chatMessages).where(eq(chatMessages.topicId, topicId));
      // The attachment INDEX (M-1) goes with the topic; the objects it points
      // at are removed by the prefix sweep below, which needs no index at all.
      await tx.delete(chatMedia).where(eq(chatMedia.topicId, topicId));
      /*
       * THE E2EE TABLES, which this transaction did not touch and which made
       * deleting any topic that had ever been chatted in FAIL WITH A 500.
       *
       * `mls_groups`, `mls_commits`, `tak_bundles`, `chat_archive` and
       * `archive_holders` all reference `topics` with `ON DELETE NO ACTION`, so
       * the final `delete(topics)` hit a foreign-key violation, the transaction
       * rolled back, and the caller got an unhandled error. Confirmed against
       * staging: a room with 13 commits, 13 bundles and 2 archived rows refused
       * to delete, and the constraint named in the error was real.
       *
       * They were added after this handler was written and nothing linked the
       * two — a schema-level `CASCADE` would have made the omission impossible,
       * and is the better long-term shape; deleting them explicitly here is the
       * change that does not need a migration to take effect. `chatDeliveryCursors`,
       * `chatReads`, `pushTopicMutes`, `mlsDeviceJoins`, `topicArchiveRoots` and
       * `inviteTokens` DO cascade and are deliberately absent.
       */
      await tx.delete(chatArchive).where(eq(chatArchive.topicId, topicId));
      await tx.delete(archiveHolders).where(eq(archiveHolders.topicId, topicId));
      await tx.delete(takBundles).where(eq(takBundles.topicId, topicId));
      // Commits before the group: a commit belongs to the group it advanced.
      // Asks for keys in a room that no longer exists have nothing to answer.
      await tx.delete(keyRequests).where(eq(keyRequests.topicId, topicId));
      await tx.delete(mlsCommits).where(eq(mlsCommits.topicId, topicId));
      await tx.delete(mlsGroups).where(eq(mlsGroups.topicId, topicId));
      await tx.delete(joinRequests).where(eq(joinRequests.topicId, topicId));
      await tx.delete(topicMembers).where(eq(topicMembers.topicId, topicId));
      // inviteTokens cascade-delete with the topic.
      await tx.delete(topics).where(eq(topics.id, topicId));
    });

    /*
     * The topic's OBJECTS. Rows are gone above; storage is a separate world and
     * the transaction cannot reach into it.
     *
     * ONE prefix now covers all of them — chat attachments, post images and the
     * topic's own picture — because the key layout is partitioned by topic
     * (`src/lib/r2.ts`). It used to sweep only `chat/{topicId}/`, so every post
     * image in the topic survived its own topic's deletion, scattered under the
     * uploader folders no prefix reached: not a leak of a few bytes, a permanent
     * one of every picture anyone ever posted here.
     *
     * Two classes are still NOT reached, and both are visible in the key:
     * objects uploaded before this layout (`posts/{userId}/...`), and objects
     * uploaded with no topic to name (`users/{userId}/uploads/...`, e.g. the
     * image chosen while the topic was still being created). Documented in
     * AGENTS.md rather than papered over.
     *
     * Best-effort by design: the topic IS deleted, and failing the response now
     * would tell the owner otherwise.
     */
    const deletedObjects = await deleteR2Prefix(topicObjectPrefix(topicId));

    logger.info(ROUTE, 'Topic deleted', {
      userId: session.userId,
      topicId,
      deletedPostCount: postIds.length,
      deletedChatObjects: deletedObjects,
    });
    return NextResponse.json({ deleted: true, topicId, deletedPostCount: postIds.length });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'DELETE', error);
  }
}
