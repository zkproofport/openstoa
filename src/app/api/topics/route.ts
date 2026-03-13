import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { logger } from '@/lib/logger';
import {
  extractScope,
  extractIsIncluded,
  computeScopeHash,
  COMMUNITY_SCOPE,
} from '@/lib/proof';

const ROUTE = '/api/topics';

/**
 * @openapi
 * /api/topics:
 *   get:
 *     tags: [Topics]
 *     summary: List topics
 *     description: >-
 *       Authentication optional. Without auth, returns public and private topics (excludes secret).
 *       With auth, includes membership status and secret topics the user belongs to.
 *       Without view=all, authenticated users see only their joined topics; unauthenticated users
 *       receive an empty list. With view=all, all visible topics are returned with sorting support.
 *     operationId: listTopics
 *     security: []
 *     parameters:
 *       - name: view
 *         in: query
 *         required: false
 *         description: Set to "all" to see all visible topics instead of only joined topics
 *         schema:
 *           type: string
 *           enum: [all]
 *       - name: sort
 *         in: query
 *         required: false
 *         description: Sort order (only applies when view=all)
 *         schema:
 *           type: string
 *           enum: [hot, new, active, top]
 *     responses:
 *       200:
 *         description: Topics list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 topics:
 *                   type: array
 *                   description: List of topics with membership info
 *                   items:
 *                     $ref: '#/components/schemas/TopicListItem'
 *       401:
 *         description: Unauthorized (only applies to authenticated requests with invalid credentials)
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *   post:
 *     tags: [Topics]
 *     summary: Create topic
 *     description: >-
 *       Creates a new topic. The creator is automatically added as the owner. For country-gated
 *       topics (requiresCountryProof=true), the creator must also provide a valid
 *       coinbase_country_attestation proof proving they are in one of the allowed countries.
 *     operationId: createTopic
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title:
 *                 type: string
 *                 description: Topic title
 *               description:
 *                 type: string
 *                 description: Topic description (optional)
 *               requiresCountryProof:
 *                 type: boolean
 *                 description: Whether joining requires a country attestation proof
 *               allowedCountries:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: ISO 3166-1 alpha-2 country codes allowed
 *               proof:
 *                 type: string
 *                 description: Country attestation proof hex (required if requiresCountryProof=true)
 *               publicInputs:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Proof public inputs (required if requiresCountryProof=true)
 *               image:
 *                 type: string
 *                 description: Topic thumbnail image URL (from /api/upload)
 *               visibility:
 *                 type: string
 *                 enum: [public, private, secret]
 *                 description: Topic visibility (defaults to public)
 *     responses:
 *       201:
 *         description: Topic created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 topic:
 *                   $ref: '#/components/schemas/Topic'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);

    const { searchParams } = new URL(request.url);
    const view = searchParams.get('view');
    const sort = searchParams.get('sort') ?? 'hot';

    // --- Guest (unauthenticated) access ---
    if (!session) {
      // Guests can only browse all visible topics (view=all)
      if (view !== 'all') {
        logger.info(ROUTE, 'Guest request without view=all, returning empty');
        return NextResponse.json({ topics: [] });
      }

      logger.info(ROUTE, 'Guest fetching all topics', { sort });

      const allTopics = await db.query.topics.findMany({
        orderBy: (t, { desc: d }) =>
          sort === 'new'
            ? [d(t.createdAt)]
            : sort === 'active'
            ? [d(t.lastActivityAt)]
            : [d(t.score)],
      });

      const memberCounts = await db
        .select({ topicId: topicMembers.topicId, count: sql<number>`count(*)::int` })
        .from(topicMembers)
        .groupBy(topicMembers.topicId);

      const memberCountMap = Object.fromEntries(memberCounts.map((m) => [m.topicId, m.count]));

      // Guests see public + private, never secret
      const visibleTopics = allTopics.filter((t) => t.visibility !== 'secret');

      const result = visibleTopics.map((t) => ({
        ...t,
        memberCount: memberCountMap[t.id] ?? 0,
        isMember: false,
      }));

      if (sort === 'top') {
        result.sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));
      }

      logger.info(ROUTE, 'Guest topics fetched', { count: result.length, sort });
      return NextResponse.json({ topics: result });
    }

    // --- Authenticated access (existing behavior) ---

    if (view === 'all') {
      logger.info(ROUTE, 'Fetching all topics with member counts', { userId: session.userId, sort });

      const allTopics = await db.query.topics.findMany({
        orderBy: (t, { desc: d }) =>
          sort === 'new'
            ? [d(t.createdAt)]
            : sort === 'active'
            ? [d(t.lastActivityAt)]
            : [d(t.score)], // hot (default)
      });

      const memberCounts = await db
        .select({ topicId: topicMembers.topicId, count: sql<number>`count(*)::int` })
        .from(topicMembers)
        .groupBy(topicMembers.topicId);

      const userMemberships = await db.query.topicMembers.findMany({
        where: eq(topicMembers.userId, session.userId),
      });

      const memberCountMap = Object.fromEntries(memberCounts.map((m) => [m.topicId, m.count]));
      const userTopicIds = new Set(userMemberships.map((m) => m.topicId));

      // Filter out secret topics unless the user is a member
      const visibleTopics = allTopics.filter((t) =>
        t.visibility !== 'secret' || userTopicIds.has(t.id),
      );

      const result = visibleTopics.map((t) => ({
        ...t,
        memberCount: memberCountMap[t.id] ?? 0,
        isMember: userTopicIds.has(t.id),
      }));

      if (sort === 'top') {
        result.sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));
      }

      logger.info(ROUTE, 'All topics fetched', { userId: session.userId, count: result.length, sort });
      return NextResponse.json({ topics: result });
    }

    // Default: only user's topics
    const memberships = await db.query.topicMembers.findMany({
      where: eq(topicMembers.userId, session.userId),
    });

    if (memberships.length === 0) {
      logger.info(ROUTE, 'User has no topic memberships', { userId: session.userId });
      return NextResponse.json({ topics: [] });
    }

    const topicIds = memberships.map((m) => m.topicId);
    const userTopics = await db.query.topics.findMany({
      where: (t, { inArray }) => inArray(t.id, topicIds),
    });

    logger.info(ROUTE, 'Topics fetched', { userId: session.userId, count: userTopics.length });
    return NextResponse.json({ topics: userTopics });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const body = await request.json();
    const { title, description, requiresCountryProof, allowedCountries, proof, publicInputs, image, visibility } = body;

    if (!title || typeof title !== 'string') {
      logger.warn(ROUTE, 'Missing title in topic creation', { userId: session.userId });
      return NextResponse.json(
        { error: 'Title is required' },
        { status: 400 },
      );
    }

    // If topic requires country proof, verify it before creating
    if (requiresCountryProof) {
      logger.info(ROUTE, 'Topic requires country proof, verifying creator proof', { userId: session.userId });

      if (!proof || !publicInputs) {
        logger.warn(ROUTE, 'Missing country proof fields for topic creation', { userId: session.userId, hasProof: !!proof, hasPublicInputs: !!publicInputs });
        return NextResponse.json(
          { error: 'Country proof required: proof, publicInputs' },
          { status: 400 },
        );
      }

      // Proof was already verified on-chain by the poll endpoint (mode=proof).
      // Only validate scope and is_included from publicInputs.

      // Verify scope matches community scope
      const scope = extractScope(publicInputs, 'coinbase_country_attestation');
      const expectedScope = computeScopeHash(COMMUNITY_SCOPE);
      if (scope !== expectedScope) {
        logger.warn(ROUTE, 'Creator country proof scope mismatch', { userId: session.userId, scope, expectedScope });
        return NextResponse.json(
          { error: 'Country proof scope mismatch' },
          { status: 400 },
        );
      }

      // Verify is_included flag: confirms creator's country is in the allowed list
      const isIncluded = extractIsIncluded(publicInputs, 'coinbase_country_attestation');
      if (!isIncluded) {
        logger.warn(ROUTE, 'Creator country not in allowed list', { userId: session.userId });
        return NextResponse.json(
          { error: 'Your country is not allowed to create this topic' },
          { status: 403 },
        );
      }
    }

    const inviteCode = crypto.randomBytes(8).toString('hex');

    logger.info(ROUTE, 'Creating topic', { userId: session.userId, title, requiresCountryProof: requiresCountryProof ?? false, inviteCode });

    const validVisibility = ['public', 'private', 'secret'].includes(visibility) ? visibility : 'public';

    const [topic] = await db
      .insert(topics)
      .values({
        title,
        description: description ?? null,
        image: image ?? null,
        creatorId: session.userId,
        requiresCountryProof: requiresCountryProof ?? false,
        allowedCountries: allowedCountries ?? null,
        inviteCode,
        visibility: validVisibility,
      })
      .returning();

    // Auto-add creator as owner
    await db.insert(topicMembers).values({
      topicId: topic.id,
      userId: session.userId,
      role: 'owner',
    });

    logger.info(ROUTE, 'Topic created and creator added as member', { userId: session.userId, topicId: topic.id });
    return NextResponse.json({ topic }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
