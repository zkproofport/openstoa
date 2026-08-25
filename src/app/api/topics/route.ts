import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers, categories, chatMessages } from '@/lib/db/schema';
import { and, eq, sql, inArray } from 'drizzle-orm';
import crypto from 'crypto';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { normaliseSearchQuery } from '@/lib/search';
import {
  extractScope,
  extractIsIncluded,
  extractDomain,
  extractCountryList,
  computeScopeHash,
  normalizePublicInputs,
  COMMUNITY_SCOPE,
} from '@/lib/proof';
import { hasValidVerificationCache, saveVerificationCache, circuitToCacheType } from '@/lib/verification-cache';
import { ARCHIVE_RETENTION_CHOICES, parseArchiveRetentionDays } from '@/lib/archiveRetention';
import { hasNulByte } from '@/lib/textGuard';
import { readStatesForTopics, emptyReadState } from '@/lib/chatUnread';

const ROUTE = '/api/topics';

const VALID_TOPIC_SORTS = ['hot', 'new', 'top', 'active'] as const;
type TopicSort = typeof VALID_TOPIC_SORTS[number];

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
 *       - name: category
 *         in: query
 *         required: false
 *         description: Filter by category slug
 *         schema:
 *           type: string
 *       - name: q
 *         in: query
 *         required: false
 *         description: Search query — matches topic title and description (case-insensitive substring). Only applies when view=all.
 *         schema:
 *           type: string
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
 *                   description: >-
 *                     The topics this request asked for. Every row in it matched
 *                     the `q` search and the `category` filter — that is the
 *                     promise this array makes, and it is why the caller's own
 *                     space is NOT in here (see `pinned`).
 *                   items:
 *                     $ref: '#/components/schemas/TopicListItem'
 *                 pinned:
 *                   nullable: true
 *                   description: >-
 *                     The caller's OWN space, sent alongside the list rather
 *                     than inside it. Every account is created with one secret
 *                     topic that only it is in — posts, comments and E2EE chat
 *                     all work there exactly as in any other topic, and no
 *                     invite, code, join or request can ever admit a second
 *                     member (all four answer 403, except joining by code which
 *                     answers 404 so the code cannot be used to confirm the
 *                     topic exists). It is also the only topic that cannot be
 *                     left or deleted; deleting the ACCOUNT removes it.
 *                     It is kept out of `topics` because it matches no search
 *                     and has no category, so including it would break that
 *                     array's promise. A client rendering a topic list should
 *                     draw this above the rows. `null` for a guest, and for any
 *                     account whose space has not been created yet. Only ever
 *                     the CALLER's own — never another account's.
 *                   allOf:
 *                     - $ref: '#/components/schemas/TopicListItem'
 *       401:
 *         description: Unauthorized (only applies to authenticated requests with invalid credentials)
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *   post:
 *     tags: [Topics]
 *     summary: Create topic
 *     description: |
 *       Creates a new topic. The caller is automatically added as the owner.
 *
 *       Topic `visibility` controls who can find / join the topic:
 *         - `public`: listed everywhere, anyone can join immediately.
 *         - `private`: listed but join requests need owner / admin approval.
 *         - `secret`: hidden from listings; joinable only via invite code.
 *
 *       Topics can optionally gate membership on a ZK proof. The creator picks the gate by
 *       sending `proofType` (preferred) or the legacy `requiresCountryProof` boolean. Supported
 *       gates and the circuit each needs (same matrix as `POST /api/topics/{topicId}/join`):
 *         - `none` (default) — no proof, anyone can join.
 *         - `country` (legacy: `requiresCountryProof=true`) — `coinbase_country_attestation` over
 *           `allowedCountries` (ISO 3166-1 alpha-2 codes).
 *         - `kyc` — `coinbase_attestation`.
 *         - `workspace` / `google_workspace` / `microsoft_365` — `oidc_domain_attestation` with the
 *           allowed domain configured separately on the topic.
 *
 *       The creator must themselves satisfy the gate at creation time, so pass
 *       `{ proof, publicInputs }` produced by `proofport-cli` for the matching circuit when
 *       `proofType` is anything other than `none`. Topic thumbnail `image` should be uploaded
 *       through `POST /api/upload` first; pass the returned `publicUrl` here.
 *     operationId: createTopic
 *     x-related-skills: [topic-proofs, auth-details, upload-image]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, categoryId]
 *             properties:
 *               title:
 *                 type: string
 *                 description: Topic title
 *               categoryId:
 *                 type: string
 *                 format: uuid
 *                 description: Category ID for the topic
 *               description:
 *                 type: string
 *                 description: Topic description (optional)
 *               requiresCountryProof:
 *                 type: boolean
 *                 description: >-
 *                   Legacy flag for country gating. Prefer `proofType=country`.
 *                   When `true`, also send `allowedCountries`, `proof`, and `publicInputs`.
 *               allowedCountries:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: ISO 3166-1 alpha-2 country codes allowed (used when `proofType=country`).
 *               proof:
 *                 type: string
 *                 description: >-
 *                   0x-prefixed UltraHonk proof hex emitted by `proofport-cli prove <circuit>`.
 *                   Required when `proofType` is anything other than `none`. The circuit must match
 *                   the gate: `coinbase_country_attestation` for country, `coinbase_attestation`
 *                   for kyc, `oidc_domain_attestation` for workspace.
 *               publicInputs:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: >-
 *                   Public inputs of the proof as 0x-prefixed hex strings (one element per field).
 *                   Layout depends on the circuit — see `proofport-cli`.
 *               image:
 *                 type: string
 *                 description: >-
 *                   Topic thumbnail image URL. Upload the file first via `POST /api/upload`
 *                   (returns `{ publicUrl }`) and pass that URL here.
 *               visibility:
 *                 type: string
 *                 enum: [public, private, secret]
 *                 description: >-
 *                   Topic visibility. `public` lists everywhere and anyone may join. `private` is
 *                   listed and its POSTS are readable by any signed-in account, but joining is
 *                   invite-only. `secret` is hidden and invite-only, posts included. Chat is
 *                   members-only in every tier — invite via `POST /api/topics/{topicId}/invite`.
 *                   Defaults to `public`.
 *               chatArchiveRetentionDays:
 *                 type: integer
 *                 enum: [0, 365, 90, 30]
 *                 description: >-
 *                   How long this topic keeps its encrypted chat ARCHIVE, in days. `0` (the default)
 *                   keeps it indefinitely; `365`, `90` and `30` purge archived messages older than
 *                   that window. Any other value is rejected with 400 — send the number, not a string.
 *                   The cost of a short window is that a member who joins later sees less history:
 *                   anything already purged is gone for everyone, including the agent reading it back
 *                   through `GET /api/topics/{topicId}/archive`. **Set once, at creation** — the field
 *                   is deliberately NOT accepted by `PATCH /api/topics/{topicId}`, because shortening a
 *                   window destroys other members' history. It does not affect live message delivery
 *                   (`GET /api/topics/{topicId}/chat`), only the archive back-fill.
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
    const sortParam = searchParams.get('sort') ?? 'hot';

    if (!VALID_TOPIC_SORTS.includes(sortParam as TopicSort)) {
      logger.warn(ROUTE, 'Invalid sort value', { sort: sortParam });
      return NextResponse.json(
        { error: `Invalid sort. Must be one of: ${VALID_TOPIC_SORTS.join(', ')}` },
        { status: 400 },
      );
    }
    const sort: TopicSort = sortParam as TopicSort;

    const categorySlug = searchParams.get('category');
    const qPattern = normaliseSearchQuery(searchParams.get('q'));

    // Build category lookup map for enriching topic responses
    const allCategories = await db.select().from(categories);
    const categoryMap = Object.fromEntries(allCategories.map((c) => [c.id, { id: c.id, name: c.name, slug: c.slug, icon: c.icon }]));

    // Resolve category filter if provided
    let filterCategoryId: string | null = null;
    if (categorySlug) {
      const matched = allCategories.find((c) => c.slug === categorySlug);
      if (!matched) {
        logger.warn(ROUTE, 'Category not found', { categorySlug });
        return NextResponse.json({ error: 'Category not found' }, { status: 400 });
      }
      filterCategoryId = matched.id;
    }

    // --- Guest (unauthenticated) access ---
    if (!session) {
      // Guests can only browse all visible topics (view=all)
      if (view !== 'all') {
        logger.info(ROUTE, 'Guest request without view=all, returning empty');
        return NextResponse.json({ topics: [] });
      }

      logger.info(ROUTE, 'Guest fetching all topics', { sort, categorySlug });

      // kind='dm' topics are private 1:1 channels — never surfaced in any
      // public/topic listing (they live behind GET /api/dm). Exclude here.
      const allTopics = await db.query.topics.findMany({
        where: qPattern
          ? (t, { or: o, ilike: il, and: a, eq: e }) => a(e(t.kind, 'topic'), o(il(t.title, qPattern), il(t.description, qPattern)))
          : (t, { eq: e }) => e(t.kind, 'topic'),
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

      // Guests see public + private, never secret, never blinded; optionally filter by category
      const visibleTopics = allTopics.filter((t) =>
        t.visibility !== 'secret' &&
        !t.blindedAt &&
        (!filterCategoryId || t.categoryId === filterCategoryId),
      );

      const result = visibleTopics.map((t) => ({
        ...t,
        category: t.categoryId ? categoryMap[t.categoryId] ?? null : null,
        memberCount: memberCountMap[t.id] ?? 0,
        isMember: false,
      }));

      if (sort === 'top') {
        result.sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));
      }

      logger.info(ROUTE, 'Guest topics fetched', { count: result.length, sort, categorySlug });
      return NextResponse.json({ topics: result });
    }

    // --- Authenticated access (existing behavior) ---

    if (view === 'all') {
      logger.info(ROUTE, 'Fetching all topics with member counts', { userId: session.userId, sort, categorySlug });

      // Exclude DM channels (kind='dm') from every topic listing (see guest branch).
      const allTopics = await db.query.topics.findMany({
        where: qPattern
          ? (t, { or: o, ilike: il, and: a, eq: e }) => a(e(t.kind, 'topic'), o(il(t.title, qPattern), il(t.description, qPattern)))
          : (t, { eq: e }) => e(t.kind, 'topic'),
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

      // Filter out secret topics unless the user is a member; exclude blinded; optionally filter by category
      const visibleTopics = allTopics.filter((t) =>
        (t.visibility !== 'secret' || userTopicIds.has(t.id)) &&
        !t.blindedAt &&
        /*
         * No exemption for a personal space here, deliberately.
         *
         * This is the BROWSE list — things to discover and join — and a space
         * nobody can join has nothing to offer it. An earlier version exempted
         * it from the category filter so it would "always show", which broke
         * the one promise this list makes: every row it returns is in the
         * category that was asked for.
         *
         * It always shows anyway, in the list that matters: the joined-topics
         * branch below applies no category filter at all, and that is what
         * both the Topics tab and the chat list read.
         */
        (!filterCategoryId || t.categoryId === filterCategoryId),
      );

      const result = visibleTopics.map((t) => ({
        ...t,
        category: t.categoryId ? categoryMap[t.categoryId] ?? null : null,
        memberCount: memberCountMap[t.id] ?? 0,
        isMember: userTopicIds.has(t.id),
      }));

      if (sort === 'top') {
        result.sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));
      }

      /*
       * The caller's own space rides ALONGSIDE the list, never inside it.
       *
       * It has to be there whatever is being searched or filtered — it is the
       * one topic a person should always be able to reach — but putting it in
       * `topics` would break the only promise that array makes: every row in it
       * matched the query. A search for "recipes" would return a row that is
       * not a search result, and a category filter would return a row with no
       * category, which is exactly the leak this replaced.
       *
       * So it goes in `pinned`, and the client draws it above the list. The
       * array keeps its meaning; the space keeps its guarantee.
       */
      /*
       * Read on its own, NOT plucked out of `allTopics`.
       *
       * `allTopics` is whatever the query asked for — a search runs its `ilike`
       * in the database, so under a search the space is simply not in that set
       * and a `find` over it returns nothing. Depending on the result set is
       * how "always there" quietly became "there unless you were searching".
       */
      const [pinned] = await db
        .select()
        .from(topics)
        .where(and(eq(topics.creatorId, session.userId), eq(topics.personal, true)))
        .limit(1);

      logger.info(ROUTE, 'All topics fetched', { userId: session.userId, count: result.length, sort, categorySlug });
      return NextResponse.json({
        topics: result,
        pinned: pinned
          ? {
              ...pinned,
              category: pinned.categoryId ? categoryMap[pinned.categoryId] ?? null : null,
              memberCount: memberCountMap[pinned.id] ?? 0,
              isMember: true,
            }
          : null,
      });
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
    // DM channels the user belongs to are surfaced via GET /api/dm, never in the
    // topic list — exclude kind='dm' here too.
    const userTopics = await db.query.topics.findMany({
      where: (t, { inArray, and: a, eq: e }) => a(inArray(t.id, topicIds), e(t.kind, 'topic')),
    });

    // When each room last had CHAT activity — the key both clients order the
    // conversation list by. Deliberately not `lastActivityAt`: the server bumps
    // that on posts, so a room you were just talking in sorted wherever its last
    // post happened to fall. A timestamp only; no ciphertext, no sender, no
    // count, so the list page still fetches zero message content (SI-1).
    const chatActivity = await db
      .select({ topicId: chatMessages.topicId, lastChatAt: sql<string | null>`max(${chatMessages.createdAt})` })
      .from(chatMessages)
      .where(inArray(chatMessages.topicId, topicIds))
      .groupBy(chatMessages.topicId);
    const lastChatAtMap = Object.fromEntries(chatActivity.map((r) => [r.topicId, r.lastChatAt]));

    /*
     * The account's read cursor per room, and the unread count it implies.
     *
     * Carried HERE rather than from a route of its own because this is the
     * request both conversation lists already make, and a badge that needs a
     * second round trip is a badge that renders wrong first and corrects itself.
     *
     * Read state is an ACCOUNT fact: before this, the mini-app kept it in an
     * in-process Map, so it died on restart and never crossed devices, and the
     * web had no source for a count at all. See `lib/chatUnread` for why both a
     * cursor and a count go out, and which of the two is authoritative.
     */
    const readStates = await readStatesForTopics(db, session.userId, userTopics.map((t) => t.id));

    const userTopicsWithCategory = userTopics.map((t) => {
      const read = readStates[t.id] ?? emptyReadState();
      return {
        ...t,
        category: t.categoryId ? categoryMap[t.categoryId] ?? null : null,
        isBlinded: !!t.blindedAt,
        lastChatAt: lastChatAtMap[t.id] ?? null,
        lastReadAt: read.lastReadAt,
        lastReadMessageId: read.lastReadMessageId,
        unreadCount: read.unreadCount,
      };
    });

    /*
     * The space sorts FIRST here.
     *
     * This branch has no category filter and no search, so it was already
     * always present — but "present" is not the same as findable once someone
     * belongs to thirty topics. It is the one row that is never about anyone
     * else, so it sits where it can be reached without looking.
     */
    userTopicsWithCategory.sort((a, b) => Number(b.personal) - Number(a.personal));

    logger.info(ROUTE, 'Topics fetched', { userId: session.userId, count: userTopicsWithCategory.length });
    return NextResponse.json({ topics: userTopicsWithCategory });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
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
    const { title, description, requiresCountryProof, allowedCountries, proof, publicInputs, image, visibility, categoryId, proofType, requiredDomain, chatArchiveRetentionDays } = body;

    if (!title || typeof title !== 'string') {
      logger.warn(ROUTE, 'Missing title in topic creation', { userId: session.userId });
      return NextResponse.json(
        { error: 'Title is required' },
        { status: 400 },
      );
    }

    if (title.length > 100) {
      return NextResponse.json(
        { error: 'Title must be 100 characters or less' },
        { status: 400 },
      );
    }

    // Postgres text storage cannot hold a NUL byte (see src/lib/textGuard.ts)
    // — reject before it ever reaches the insert, same rule as apiKeys.name.
    if (hasNulByte(title)) {
      return NextResponse.json({ error: 'Title must not contain a NUL byte' }, { status: 400 });
    }
    if (description !== undefined && description !== null && typeof description === 'string' && hasNulByte(description)) {
      return NextResponse.json({ error: 'Description must not contain a NUL byte' }, { status: 400 });
    }

    // Visibility tiers (design §5.2): public (listed, join immediately),
    // private (listed, join needs owner/admin approval), secret (hidden,
    // invite-only). The join route + listing filters already honor all three.
    const VALID_VISIBILITIES = ['public', 'private', 'secret'];
    if (visibility !== undefined && (typeof visibility !== 'string' || !VALID_VISIBILITIES.includes(visibility))) {
      logger.warn(ROUTE, 'Invalid visibility', { userId: session.userId, visibility });
      return NextResponse.json(
        { error: `visibility must be one of: ${VALID_VISIBILITIES.join(', ')}` },
        { status: 400 },
      );
    }

    // How long this topic keeps its chat archive. Chosen ONCE, here, by the
    // creator (who is its first owner): shortening a window deletes other
    // members' history, so it is not an editable preference and PATCH does not
    // accept it. Omitting the field is the one absence that is not an error —
    // it means "unlimited", which is what every topic created before this
    // setting existed already has.
    const retentionDays = parseArchiveRetentionDays(chatArchiveRetentionDays);
    if (retentionDays === null) {
      logger.warn(ROUTE, 'Invalid chatArchiveRetentionDays', { userId: session.userId, chatArchiveRetentionDays });
      return NextResponse.json(
        { error: `chatArchiveRetentionDays must be one of: ${ARCHIVE_RETENTION_CHOICES.join(', ')}` },
        { status: 400 },
      );
    }

    // categoryId is required for new topics
    if (!categoryId || typeof categoryId !== 'string') {
      logger.warn(ROUTE, 'Missing categoryId in topic creation', { userId: session.userId });
      return NextResponse.json(
        { error: 'categoryId is required' },
        { status: 400 },
      );
    }

    // Validate category exists
    const category = await db.query.categories.findFirst({
      where: eq(categories.id, categoryId),
    });
    if (!category) {
      logger.warn(ROUTE, 'Invalid categoryId', { userId: session.userId, categoryId });
      return NextResponse.json(
        { error: 'Category not found' },
        { status: 400 },
      );
    }

    // Validate proofType
    const validProofTypes = ['none', 'kyc', 'country', 'google_workspace', 'microsoft_365', 'workspace'];
    if (proofType && !validProofTypes.includes(proofType)) {
      return NextResponse.json(
        { error: `Invalid proofType. Must be one of: ${validProofTypes.join(', ')}` },
        { status: 400 },
      );
    }
    const effectiveProofType = proofType || (requiresCountryProof ? 'country' : 'none');

    // Creator must satisfy the proof condition they're setting
    if (effectiveProofType !== 'none') {
      logger.info(ROUTE, 'Topic requires proof, verifying creator', { userId: session.userId, proofType: effectiveProofType });

      // Check Redis cache first
      const creatorVerified = await hasValidVerificationCache(
        session.userId,
        effectiveProofType,
        (effectiveProofType === 'google_workspace' || effectiveProofType === 'microsoft_365' || effectiveProofType === 'workspace')
          ? (requiredDomain?.trim() || undefined) : undefined,
      );

      // If proof is provided, always verify and refresh cache (ensures domain field is stored)
      if (proof && publicInputs) {
        // Determine circuit from proofType
        const circuitId = effectiveProofType === 'country' ? 'coinbase_country_attestation'
          : effectiveProofType === 'kyc' ? 'coinbase_attestation'
          : 'oidc_domain_attestation';

        // Normalize publicInputs (SDK may return single hex string instead of array)
        const normalizedInputs = normalizePublicInputs(publicInputs);

        // Verify scope matches community scope
        const scope = extractScope(normalizedInputs, circuitId);
        const expectedScope = computeScopeHash(COMMUNITY_SCOPE);
        if (scope !== expectedScope) {
          logger.warn(ROUTE, 'Creator proof scope mismatch', { userId: session.userId, scope, expectedScope });
          return NextResponse.json(
            { error: 'Proof scope mismatch' },
            { status: 400 },
          );
        }

        // Type-specific verification
        if (effectiveProofType === 'country') {
          const isIncluded = extractIsIncluded(normalizedInputs, 'coinbase_country_attestation');
          if (!isIncluded) {
            logger.warn(ROUTE, 'Creator country not in allowed list', { userId: session.userId });
            return NextResponse.json(
              { error: 'Your country is not allowed to create this topic' },
              { status: 403 },
            );
          }

          // Verify creator's country_list matches topic's allowedCountries
          const proofCountryList = extractCountryList(normalizedInputs, 'coinbase_country_attestation');
          const topicCountries = allowedCountries || [];
          if (topicCountries.length > 0) {
            const proofSet = new Set(proofCountryList.map((c: string) => c.toUpperCase()));
            const topicSet = new Set(topicCountries.map((c: string) => c.toUpperCase()));
            if (proofSet.size !== topicSet.size || ![...proofSet].every((c: string) => topicSet.has(c))) {
              logger.warn(ROUTE, 'Creator country list mismatch', {
                userId: session.userId,
                proofCountries: proofCountryList,
                topicCountries,
              });
              return NextResponse.json(
                { error: 'Country list mismatch: your proof does not match the topic countries' },
                { status: 403 },
              );
            }
          }
        }

        if (effectiveProofType === 'google_workspace' || effectiveProofType === 'microsoft_365' || effectiveProofType === 'workspace') {
          const domain = extractDomain(normalizedInputs, 'oidc_domain_attestation');
          const trimmedRequired = requiredDomain?.trim();
          if (trimmedRequired && domain !== trimmedRequired) {
            logger.warn(ROUTE, 'Creator domain mismatch', { userId: session.userId, domain, requiredDomain: trimmedRequired });
            return NextResponse.json(
              { error: `Domain mismatch: expected ${trimmedRequired}, got ${domain}` },
              { status: 403 },
            );
          }
          // Cache with extracted domain (always refresh to ensure domain field exists)
          await saveVerificationCache(session.userId, circuitToCacheType(circuitId), { domain: domain ?? undefined });
        } else {
          // Cache KYC/country verification
          await saveVerificationCache(session.userId, circuitToCacheType(circuitId));
        }
      } else if (!creatorVerified) {
        logger.warn(ROUTE, 'Missing proof fields for topic creation', { userId: session.userId, proofType: effectiveProofType });
        return NextResponse.json(
          { error: `Proof required to create a ${effectiveProofType}-gated topic` },
          { status: 400 },
        );
      }
    }

    const inviteCode = crypto.randomBytes(8).toString('hex');

    logger.info(ROUTE, 'Creating topic', { userId: session.userId, title, proofType: effectiveProofType, inviteCode });

    // For workspace types, domain is optional (no domain = any workspace user can join)
    const effectiveDomain = (effectiveProofType === 'google_workspace' || effectiveProofType === 'microsoft_365' || effectiveProofType === 'workspace')
      ? (requiredDomain?.trim() || null)
      : null;

    const validVisibility = (visibility as string) || 'public'; // validated above; defaults to public

    const [topic] = await db
      .insert(topics)
      .values({
        title,
        description: description ?? null,
        image: image ?? null,
        creatorId: session.userId,
        categoryId,
        requiresCountryProof: requiresCountryProof ?? false,
        allowedCountries: allowedCountries ?? null,
        proofType: effectiveProofType,
        requiredDomain: effectiveDomain,
        inviteCode,
        visibility: validVisibility,
        chatArchiveRetentionDays: retentionDays,
      })
      .returning();

    // Auto-add creator as owner
    await db.insert(topicMembers).values({
      topicId: topic.id,
      userId: session.userId,
      role: 'owner',
    });

    logger.info(ROUTE, 'Topic created and creator added as member', { userId: session.userId, topicId: topic.id, categoryId });
    return NextResponse.json({
      topic: {
        ...topic,
        category: { id: category.id, name: category.name, slug: category.slug, icon: category.icon },
      },
    }, { status: 201 });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
