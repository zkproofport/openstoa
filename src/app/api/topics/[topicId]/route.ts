import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers, categories } from '@/lib/db/schema';
import { eq, and, count } from 'drizzle-orm';
import { logger } from '@/lib/logger';

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

      logger.info(ROUTE, 'Guest topic detail fetched', { topicId, memberCount: memberCount.count });
      return NextResponse.json({
        topic: {
          ...topic,
          category,
          memberCount: memberCount.count,
        },
        currentUserRole: null,
        isMember: false,
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

    if (!membership) {
      logger.warn(ROUTE, 'User is not a member of this topic', { userId: session.userId, topicId });
      return NextResponse.json(
        { error: 'Not a member of this topic' },
        { status: 403 },
      );
    }

    const topic = await db.query.topics.findFirst({
      where: eq(topics.id, topicId),
    });

    if (!topic) {
      logger.warn(ROUTE, 'Topic not found', { topicId });
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

    logger.info(ROUTE, 'Topic detail fetched', { topicId, memberCount: memberCount.count });
    return NextResponse.json({
      topic: {
        ...topic,
        category,
        memberCount: memberCount.count,
      },
      currentUserRole: membership.role,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
