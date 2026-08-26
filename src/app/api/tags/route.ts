import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { tags, postTags, posts } from '@/lib/db/schema';
import { desc, ilike, eq, and, sql, countDistinct, inArray } from 'drizzle-orm';
import { resolveVisibleTopicIds, canSeeTopic } from '@/lib/visibleTopics';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';

const ROUTE = '/api/tags';

/**
 * @openapi
 * /api/tags:
 *   get:
 *     tags: [Tags]
 *     summary: Search and list tags
 *     description: >-
 *       Searches and lists tags. With `q`, performs a prefix search (up to 10 results); without it,
 *       returns the most-used tags (up to 20). Optionally scoped to one topic with `topicId`.
 *
 *
 *       **The result depends on who is asking.** A tag is free text somebody typed on a post, so it
 *       is only listed when the caller can reach at least one post carrying it — public topics plus,
 *       for an authenticated caller, the topics they belong to. A tag used only inside a private or
 *       personal topic is invisible to everyone else, including a caller with no session. Sending a
 *       Bearer token therefore returns MORE tags, not the same tags.
 *     operationId: listTags
 *     security: []
 *     x-auth-optional: true
 *     x-related-skills: [list-posts, create-post]
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
 *         description: >-
 *           Scope the search to one topic (UUID). A topic the caller cannot see answers exactly like
 *           a topic with no tags — `200` with an empty array, never `403` — so this endpoint cannot
 *           be used to test whether a given topic id exists.
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
 *                   description: >-
 *                     Matching tags, most-used first and newest breaking ties. Each `postCount` is
 *                     the number of posts THE CALLER CAN SEE carrying that tag — not a global total
 *                     — so the same tag can report a different count to a different caller, and
 *                     deleted posts are never counted.
 *                   items:
 *                     $ref: '#/components/schemas/Tag'
 */
export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);

    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q');
    const topicId = searchParams.get('topicId');

    logger.info(ROUTE, 'Fetching tags', { userId: session?.userId ?? 'guest', q, topicId });

    let result;

    /*
     * A tag is content. It is free text a person typed on a post, so listing
     * tags without asking which posts the caller may read hands out words
     * written inside private rooms. This branch used to read the `tags` table
     * on its own — no join to posts, no topic check — and returned a tag whose
     * only post lived in someone's personal space to any caller, guest
     * included. `?topicId=` was worse: it listed a topic's whole vocabulary
     * with no membership check.
     *
     * Both branches now count through posts the caller can actually reach.
     * That also retires the denormalised `tags.postCount`, which was wrong for
     * everyone: it is bumped only in the ON CONFLICT path, so the post that
     * CREATES a tag never counts and every tag read one short of the truth.
     */
    const visibleTopicIds = await resolveVisibleTopicIds(session?.userId ?? null, null);

    if (visibleTopicIds.length === 0) {
      logger.info(ROUTE, 'No visible topics for caller', { userId: session?.userId ?? 'guest' });
      return NextResponse.json({ tags: [] });
    }

    // A topic the caller cannot see answers the same as one with no tags:
    // an empty list, never a 403. Whether that topic exists is not this
    // route's news to break.
    if (topicId && !(await canSeeTopic(session?.userId ?? null, topicId))) {
      logger.info(ROUTE, 'Topic not visible to caller', { userId: session?.userId ?? 'guest', topicId });
      return NextResponse.json({ tags: [] });
    }

    const scope = topicId
      ? and(eq(posts.topicId, topicId), eq(posts.isDeleted, false))
      : and(inArray(posts.topicId, visibleTopicIds), eq(posts.isDeleted, false));

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
      // Deterministic ordering: most-used wins, newest breaks the tie. Without
      // it Postgres returns whatever the planner picks, and staging's dozens of
      // `e2e-tag-*` rows pushed new tags outside the LIMIT window.
      result = await baseQuery
        .where(and(scope, ilike(tags.slug, `${escaped}%`)))
        .groupBy(tags.id, tags.name, tags.slug, tags.createdAt)
        .orderBy(sql`count(distinct ${postTags.postId}) desc`, desc(tags.createdAt))
        .limit(10);
    } else {
      result = await baseQuery
        .where(scope)
        .groupBy(tags.id, tags.name, tags.slug, tags.createdAt)
        .orderBy(sql`count(distinct ${postTags.postId}) desc`, desc(tags.createdAt))
        .limit(20);
    }

    logger.info(ROUTE, 'Tags fetched', { userId: session?.userId ?? 'guest', count: result.length });
    return NextResponse.json({ tags: result });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}
