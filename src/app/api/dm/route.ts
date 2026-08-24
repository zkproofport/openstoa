import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers, users } from '@/lib/db/schema';
import { eq, and, ne, inArray, desc } from 'drizzle-orm';
import crypto from 'crypto';
import { logger } from '@/lib/logger';
import { readStatesForTopics, emptyReadState } from '@/lib/chatUnread';
import { unhandledRouteError } from '@/lib/apiError';
import { requireAiCapability } from '@/lib/aiPermissions';
import { canonicalDmPair } from '@/lib/dm';

const ROUTE = '/api/dm';

/**
 * @openapi
 * /api/dm:
 *   get:
 *     tags: [DM]
 *     summary: List your direct-message channels
 *     description: |
 *       Lists the 1:1 direct-message channels the authenticated caller participates in.
 *       Each DM is a hidden 2-member topic that reuses the end-to-end-encrypted chat stack —
 *       so once you have a channel's `topicId`, you read and send with the exact same endpoints
 *       as topic chat (`GET`/`POST /api/topics/{topicId}/chat` + the `mls/*` and `tak/*` routes).
 *
 *       **The server is blind (SI-1).** This list carries ONLY routing metadata — the peer's
 *       `userId`, `nickname`, `profileImage`, and a `lastActivityAt` timestamp. It NEVER returns
 *       any message content or a decrypted preview; message bodies exist only as opaque
 *       ciphertext and are decrypted client-side.
 *
 *       An AI (`isAI`) caller must hold the `/openstoa/chat/read` capability (profile grant or the
 *       scoped API key), otherwise 403 — the same gate as reading chat.
 *     operationId: listDms
 *     x-related-skills: [start-dm, get-chat-history, send-chat-message]
 *     responses:
 *       200:
 *         description: The caller's DM channels, most-recently-active first.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dms:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       topicId:
 *                         type: string
 *                         format: uuid
 *                         description: The DM channel's topic id — pass this to the chat/mls/tak endpoints.
 *                       peer:
 *                         type: object
 *                         description: The other participant (never the caller). Routing metadata only.
 *                         properties:
 *                           userId:
 *                             type: string
 *                             description: The peer's nullifier user id.
 *                           nickname:
 *                             type: string
 *                           profileImage:
 *                             type: string
 *                             nullable: true
 *                       lastActivityAt:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                         description: When the channel last saw activity. No message content is exposed.
 *                       lastReadAt:
 *                         type: string
 *                         format: date-time
 *                         nullable: true
 *                         description: >-
 *                           This account's chat read cursor for the channel, or null if never read.
 *                           Written by `PUT /api/topics/{topicId}/chat/read` using this `topicId`.
 *                       lastReadMessageId:
 *                         type: string
 *                         format: uuid
 *                         nullable: true
 *                         description: The message `lastReadAt` names, or null.
 *                       unreadCount:
 *                         type: integer
 *                         description: >-
 *                           Unread messages past the cursor, capped at 999 — see the
 *                           `ChatReadCursor` schema for the counting rule.
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *   post:
 *     tags: [DM]
 *     summary: Start (or get) a 1:1 direct-message channel
 *     description: |
 *       Start-or-get a direct-message channel with another user. **Idempotent**: calling it twice
 *       for the same pair — in either order — always returns the SAME `topicId` (a canonical-ordered
 *       participant pair is uniquely indexed). On first call it creates a hidden 2-member topic
 *       (`kind='dm'`, never listed in `GET /api/topics`, the feed, or search) and adds both users as
 *       members; on later calls it returns the existing channel.
 *
 *       DM reuses the whole end-to-end-encrypted chat stack: the server stores only ciphertext and
 *       runs no crypto (SI-1). After you get the `topicId`, do MLS genesis / join and send exactly
 *       as you would for topic chat, then read/send via `GET`/`POST /api/topics/{topicId}/chat`.
 *       (The `@masselabs/openstoa` SDK's `startDm(peerUserId)` performs the client-side MLS genesis
 *       for you.)
 *
 *       An AI (`isAI`) caller must hold the `/openstoa/chat/send` capability (profile grant or scoped
 *       API key), otherwise 403 — the same gate as sending chat.
 *     operationId: startDm
 *     x-related-skills: [list-dms, send-chat-message, get-chat-history]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *                 description: >-
 *                   The other participant's nullifier user id (as returned by `GET /api/topics/{id}/members`
 *                   or a profile). Must be an existing user and must not equal the caller's own id.
 *     responses:
 *       200:
 *         description: Existing DM channel returned (idempotent hit).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 topicId:
 *                   type: string
 *                   format: uuid
 *       201:
 *         description: New DM channel created.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 topicId:
 *                   type: string
 *                   format: uuid
 *       400:
 *         description: Missing/invalid userId, or attempting to DM yourself.
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         description: Target user not found.
 */
export async function GET(request: NextRequest) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    // isAI callers need the same capability as reading chat.
    const readGate = await requireAiCapability(db, session, '/openstoa/chat/read');
    if (readGate) {
      logger.warn(ROUTE, 'AI caller lacks chat/read capability', { userId: session.userId });
      return readGate;
    }

    // Caller's DM memberships (kind='dm' only — normal topics are unaffected).
    const myDms = await db
      .select({ topicId: topicMembers.topicId, lastActivityAt: topics.lastActivityAt })
      .from(topicMembers)
      .innerJoin(topics, eq(topics.id, topicMembers.topicId))
      .where(and(eq(topicMembers.userId, session.userId), eq(topics.kind, 'dm')));

    if (myDms.length === 0) {
      return NextResponse.json({ dms: [] });
    }

    const topicIds = myDms.map((d) => d.topicId);
    const lastActivityByTopic = Object.fromEntries(myDms.map((d) => [d.topicId, d.lastActivityAt]));

    // The peer is the other member of each DM topic. SI-1: this join reads
    // ONLY public routing metadata (nickname / profile image) — never any
    // message row, so no plaintext or ciphertext ever leaves through here.
    const peers = await db
      .select({
        topicId: topicMembers.topicId,
        peerId: users.id,
        nickname: users.nickname,
        profileImage: users.profileImage,
      })
      .from(topicMembers)
      .innerJoin(users, eq(users.id, topicMembers.userId))
      .where(and(inArray(topicMembers.topicId, topicIds), ne(topicMembers.userId, session.userId)));

    // Same account-level read cursor the topic list carries — a DM is a hidden
    // 2-member topic, so `chat_reads` needs no DM-specific anything. Without it
    // the Direct tab would be the one list still unable to badge.
    const readStates = await readStatesForTopics(db, session.userId, topicIds);

    const dms = peers
      .map((p) => ({
        topicId: p.topicId,
        peer: { userId: p.peerId, nickname: p.nickname, profileImage: p.profileImage },
        lastActivityAt: lastActivityByTopic[p.topicId] ?? null,
        ...(readStates[p.topicId] ?? emptyReadState()),
      }))
      .sort((a, b) => {
        const ta = a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0;
        const tb = b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0;
        return tb - ta;
      });

    logger.info(ROUTE, 'DM list fetched', { userId: session.userId, count: dms.length });
    return NextResponse.json({ dms });
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

    // Starting a DM is a chat action — gate isAI callers like sending chat.
    const sendGate = await requireAiCapability(db, session, '/openstoa/chat/send');
    if (sendGate) {
      logger.warn(ROUTE, 'AI caller lacks chat/send capability', { userId: session.userId });
      return sendGate;
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { userId: peerId } = body as Record<string, unknown>;

    if (typeof peerId !== 'string' || peerId.length === 0) {
      logger.warn(ROUTE, 'Missing/invalid userId', { userId: session.userId });
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    if (peerId === session.userId) {
      logger.warn(ROUTE, 'Attempt to DM self', { userId: session.userId });
      return NextResponse.json({ error: 'Cannot start a DM with yourself' }, { status: 400 });
    }

    const peer = await db.query.users.findFirst({ where: eq(users.id, peerId) });
    if (!peer) {
      logger.warn(ROUTE, 'Target user not found', { userId: session.userId, peerId });
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const pair = canonicalDmPair(session.userId, peerId);

    // Idempotent hit — return the existing channel.
    const existing = await db.query.topics.findFirst({
      where: and(eq(topics.kind, 'dm'), eq(topics.dmPair, pair)),
      columns: { id: true },
    });
    if (existing) {
      logger.info(ROUTE, 'Existing DM returned', { userId: session.userId, peerId, topicId: existing.id });
      return NextResponse.json({ topicId: existing.id }, { status: 200 });
    }

    // Create the hidden 2-member DM topic. `onConflictDoNothing` on the unique
    // dm_pair index makes a concurrent double-start collapse to one row: the
    // loser gets an empty `returning()` and re-reads the winner's channel below.
    const inviteCode = crypto.randomBytes(8).toString('hex');
    const [created] = await db
      .insert(topics)
      .values({
        title: 'dm',
        creatorId: session.userId,
        proofType: 'none',
        inviteCode,
        visibility: 'secret',
        kind: 'dm',
        dmPair: pair,
      })
      .onConflictDoNothing({ target: topics.dmPair })
      .returning({ id: topics.id });

    if (!created) {
      // Lost the race — the winner created the row; return it.
      const winner = await db.query.topics.findFirst({
        where: and(eq(topics.kind, 'dm'), eq(topics.dmPair, pair)),
        columns: { id: true },
      });
      if (!winner) {
        throw new Error('DM channel vanished after conflict');
      }
      logger.info(ROUTE, 'DM race lost, returning winner', { userId: session.userId, peerId, topicId: winner.id });
      return NextResponse.json({ topicId: winner.id }, { status: 200 });
    }

    // Both participants are equal members of the DM channel.
    await db.insert(topicMembers).values([
      { topicId: created.id, userId: session.userId, role: 'member' },
      { topicId: created.id, userId: peerId, role: 'member' },
    ]);

    logger.info(ROUTE, 'DM created', { userId: session.userId, peerId, topicId: created.id });
    return NextResponse.json({ topicId: created.id }, { status: 201 });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
