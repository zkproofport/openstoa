import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { tags, postTags, posts } from '@/lib/db/schema';
import { desc, ilike, eq, and, sql, countDistinct } from 'drizzle-orm';
import { logger } from '@/lib/logger';

const ROUTE = '/api/tags';

/**
 * @openapi
 * /api/tags:
 *   get:
 *     tags: [Tags]
 *     summary: Search and list tags
 *     description: >-
 *       Searches and lists tags. With q parameter, performs prefix search (up to 10 results). Without
 *       q, returns most-used tags (up to 20). Optionally scoped to a specific topic.
 *     operationId: listTags
 *     parameters:
 *       - name: q
 *         in: query
 *         required: false
 *         description: Prefix search query (returns up to 10 matches)
 *         schema:
 *           type: string
 *       - name: topicId
 *         in: query
 *         required: false
 *         description: Scope tag search to a specific topic
 *         schema:
 *           type: string
 *     responses:
 *       '200':
 *         description: List of tags
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tags:
 *                   type: array
 *                   description: Matching tags
 *                   items:
 *                     $ref: '#/components/schemas/Tag'
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
    const q = searchParams.get('q');
    const topicId = searchParams.get('topicId');

    logger.info(ROUTE, 'Fetching tags', { userId: session.userId, q, topicId });

    let result;

    if (topicId) {
      // Topic-scoped tags: only tags used in posts of this topic
      const baseQuery = db
        .select({
          id: tags.id,
          name: tags.name,
          slug: tags.slug,
          postCount: countDistinct(postTags.postId),
          createdAt: tags.createdAt,
        })
        .from(tags)
        .innerJoin(postTags, eq(postTags.tagId, tags.id))
        .innerJoin(posts, eq(postTags.postId, posts.id));

      if (q) {
        const escaped = q.replace(/%/g, '\\%').replace(/_/g, '\\_');
        result = await baseQuery
          .where(and(eq(posts.topicId, topicId), ilike(tags.slug, `${escaped}%`)))
          .groupBy(tags.id, tags.name, tags.slug, tags.createdAt)
          .limit(10);
      } else {
        result = await baseQuery
          .where(eq(posts.topicId, topicId))
          .groupBy(tags.id, tags.name, tags.slug, tags.createdAt)
          .orderBy(sql`count(distinct ${postTags.postId}) desc`)
          .limit(20);
      }
    } else {
      // Global tags (fallback)
      if (q) {
        const escaped = q.replace(/%/g, '\\%').replace(/_/g, '\\_');
        result = await db
          .select()
          .from(tags)
          .where(ilike(tags.slug, `${escaped}%`))
          .limit(10);
      } else {
        result = await db
          .select()
          .from(tags)
          .orderBy(desc(tags.postCount))
          .limit(20);
      }
    }

    logger.info(ROUTE, 'Tags fetched', { userId: session.userId, count: result.length });
    return NextResponse.json({ tags: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
