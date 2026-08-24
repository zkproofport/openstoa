import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topicMembers, chatReads, chatMessages } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { isValidUUID } from '@/lib/uuid';
import { requireAiCapability } from '@/lib/aiPermissions';
import { isProvisionalId } from '@/lib/chatStatus';
import { readStatesForTopics, emptyReadState } from '@/lib/chatUnread';

const ROUTE = '/api/topics/[topicId]/chat/read';

/**
 * Cap on the submitted message id before it is parsed.
 *
 * A canonical uuid is 36 characters, so this is a small multiple of the only
 * legitimate value. It exists so a megabyte of text is refused by a length
 * check rather than by a regex walking all of it.
 */
const MAX_MESSAGE_ID_CHARS = 128;

/**
 * @openapi
 * /api/topics/{topicId}/chat/read:
 *   put:
 *     tags: [Chat]
 *     summary: Move this account's read cursor for a conversation
 *     description: |
 *       Records how far the CALLING ACCOUNT has read in this topic's chat. This is what makes an
 *       unread badge disappear, and it is per USER — reading on one device clears the badge on
 *       every other device signed in to the same account.
 *
 *       Not to be confused with `POST /api/topics/{topicId}/chat/delivered`, which is per DEVICE
 *       and answers a different question ("may the server drop its live copy of the ciphertext").
 *       A client that implements chat should call both: `delivered` after a successful
 *       fetch-and-decrypt pass, `read` when the messages were actually put in front of the user.
 *
 *       **Call it when a room is on screen**, with the newest message the user has seen, and
 *       again as new messages arrive while they stay in the room. Debounce it — a room scrolling
 *       through a burst should issue one request, not one per message. Treat it as
 *       fire-and-forget: a failure here must never break the room, and the next call recovers.
 *
 *       A message the client could not DECRYPT still advances the cursor. It was on screen as a
 *       locked placeholder, so refusing it would strand the badge on a message the user has no
 *       way to clear.
 *
 *       The cursor only ever moves FORWARD (an older `readAt` is accepted and ignored), a value
 *       in the future is clamped to the server's clock, and a locally-minted `pending-` id is
 *       rejected — it names a row the server has never stored.
 *
 *       Read the cursor back with `GET` on this same path, or for every joined room at once from
 *       `GET /api/topics`, which carries `lastReadAt` and `unreadCount` per topic.
 *     operationId: markChatRead
 *     x-related-skills: [get-chat-history, subscribe-chat-sse, ack-chat-delivery, list-topics]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID (a DM channel's topic id works here too)
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [messageId, readAt]
 *             properties:
 *               messageId:
 *                 type: string
 *                 format: uuid
 *                 maxLength: 128
 *                 description: >-
 *                   Server id of the newest message the user has seen. Must be a stored message id
 *                   IN THIS TOPIC; a provisional `pending-` id from an optimistic send, and an id
 *                   from another topic, are each rejected with 400.
 *               readAt:
 *                 type: string
 *                 format: date-time
 *                 description: >-
 *                   That message's `createdAt`, verbatim, INCLUSIVE. Use the server's value rather
 *                   than the device clock. Advisory while the message exists — the server prefers
 *                   the row's own instant, which is more precise than any JSON timestamp — and
 *                   authoritative only for a message the server no longer holds, where a future
 *                   value is clamped to now.
 *     responses:
 *       200:
 *         description: The cursor after the call, and what it implies
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatReadCursor'
 *       400:
 *         description: >-
 *           Invalid topicId, missing/invalid messageId or readAt, a provisional id, or a message id
 *           that belongs to another topic
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Not a member of this topic
 *   get:
 *     tags: [Chat]
 *     summary: Read this account's read cursor for a conversation
 *     description: >-
 *       The stored cursor for the calling account plus the unread count it implies. Use it to
 *       seed a freshly-started client for ONE room; `GET /api/topics` carries the same two fields
 *       for every joined room in a request the list already makes. A room that has never been
 *       read returns nulls and `unreadCount` counted from the beginning of its history.
 *     operationId: getChatReadCursor
 *     x-related-skills: [mark-chat-read, list-topics]
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
 *         description: The stored cursor
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChatReadCursor'
 *       400:
 *         description: Invalid topicId
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Not a member of this topic
 */

/**
 * Session + membership + AI-capability, in the order the other chat routes use
 * them, returning either the caller's id or the response to send instead.
 *
 * Extracted because GET and PUT need the SAME gate and an authorization check
 * duplicated across two handlers is one someone tightens on one side only. In
 * particular, the account is taken from the SESSION here and the body is never
 * consulted for it — that is what makes one member's cursor unreachable to
 * another rather than merely unnamed by the current clients.
 */
async function gate(
  request: NextRequest,
  topicId: string,
): Promise<{ userId: string } | { response: NextResponse }> {
  const session = await getSession(request);
  if (!session) {
    logger.warn(ROUTE, 'Unauthenticated request');
    return { response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  }

  if (!isValidUUID(topicId)) {
    return { response: NextResponse.json({ error: 'Invalid topicId' }, { status: 400 }) };
  }

  const membership = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
  });
  if (!membership) {
    logger.warn(ROUTE, 'User is not a member', { userId: session.userId, topicId });
    return { response: NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 }) };
  }

  // Having read something is a claim about reading: an agent that may not read
  // this topic's chat cannot have read any of it. Same gate as GET /chat and
  // /chat/delivered, so the three cannot disagree about who may read.
  const readGate = await requireAiCapability(db, session, '/openstoa/chat/read');
  if (readGate) {
    logger.warn(ROUTE, 'AI caller lacks chat/read capability', { userId: session.userId, topicId });
    return { response: readGate };
  }

  return { userId: session.userId };
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'PUT request received');
  try {
    const { topicId } = await params;
    const gated = await gate(request, topicId);
    if ('response' in gated) return gated.response;
    const { userId } = gated;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { messageId, readAt } = body as Record<string, unknown>;

    if (typeof messageId !== 'string' || messageId.trim().length === 0) {
      return NextResponse.json({ error: 'messageId is required' }, { status: 400 });
    }
    const id = messageId.trim();
    if (id.length > MAX_MESSAGE_ID_CHARS) {
      return NextResponse.json(
        { error: `messageId must be ${MAX_MESSAGE_ID_CHARS} characters or fewer` },
        { status: 400 },
      );
    }
    /*
     * Refuse a provisional id EXPLICITLY, ahead of the uuid check that would
     * also refuse it.
     *
     * The uuid check makes this redundant today and would stop making it
     * redundant the moment message ids stopped being uuids — and the reason is
     * worth naming in the error rather than reporting as "not a uuid": a
     * `pending-` row is on screen before the server has stored it, and its
     * `createdAt` is the DEVICE's clock. A phone running an hour fast would
     * otherwise park the cursor an hour ahead and silently mark an hour of real
     * messages read.
     */
    if (isProvisionalId(id)) {
      logger.warn(ROUTE, 'Provisional message id refused', { userId, topicId });
      return NextResponse.json(
        { error: 'messageId is provisional; the server has no such message' },
        { status: 400 },
      );
    }
    if (!isValidUUID(id)) {
      return NextResponse.json({ error: 'messageId must be a message id' }, { status: 400 });
    }

    if (typeof readAt !== 'string' || readAt.length === 0) {
      return NextResponse.json({ error: 'readAt is required' }, { status: 400 });
    }
    const asked = new Date(readAt);
    if (Number.isNaN(asked.getTime())) {
      return NextResponse.json({ error: 'readAt must be an ISO timestamp' }, { status: 400 });
    }

    /*
     * Clamp a future mark to now — same rule and same reason as
     * `/chat/delivered`. A skewed clock (or a caller simply sending
     * `9999-01-01`) must not be able to declare messages read that do not exist
     * yet; clamping rather than rejecting keeps a mildly-fast clock working,
     * since it then marks read exactly what is there.
     *
     * Only reachable on the FALLBACK path below — a real message's own instant
     * cannot be in the future.
     */
    const now = new Date();
    const clamped = asked.getTime() > now.getTime() ? now : asked;

    /*
     * A message in ANOTHER topic is refused rather than quietly ignored: naming
     * a room you may not be in must not move a cursor in a room you are.
     */
    const stored = await db.query.chatMessages.findFirst({
      where: eq(chatMessages.id, id),
      columns: { topicId: true },
    });
    if (stored && stored.topicId !== topicId) {
      logger.warn(ROUTE, 'messageId belongs to another topic', { userId, topicId });
      return NextResponse.json(
        { error: 'messageId is not a message in this topic' },
        { status: 400 },
      );
    }

    /*
     * TAKE THE INSTANT FROM THE ROW, IN SQL — never from the request, and never
     * through a JavaScript `Date`.
     *
     * Postgres stores `created_at` to the MICROSECOND (`12:24:30.879647`); both
     * JSON serialisation and `Date` itself hold only MILLISECONDS
     * (`12:24:30.879`). So a client echoing back the timestamp it was handed
     * echoes back a strictly SMALLER value than the row holds — and the count is
     * `created_at > last_read_at`, which stayed true for the very message just
     * marked read. The newest message in every room was permanently unreadable
     * and no badge ever reached zero, while every validation above passed and
     * every unit test stayed green. Round-tripping through `new Date(row)` on
     * the server does not fix it: that truncates too. The value has to go
     * straight from column to column.
     *
     * Caught by `chat-read.test.ts` case 14 against a real Postgres, and by
     * nothing else.
     *
     * MONOTONIC, decided by the database rather than by a read-then-write here.
     * Two clients of the same account can be in the same room — that is the
     * point of an account-level cursor — and their writes can commit in either
     * order. `GREATEST` makes them converge on the further mark instead of on
     * whichever landed last; a rewind would resurrect a badge the user had
     * already cleared, which is the bug this table exists to end.
     *
     * `last_read_message_id` follows the timestamp, so the id and the instant
     * always name the same message rather than drifting into a pair that never
     * coexisted.
     */
    const upserted = (await db.execute(sql`
      INSERT INTO chat_reads (topic_id, user_id, last_read_message_id, last_read_at, updated_at)
      SELECT ${topicId}::uuid, ${userId}, m.id, m.created_at, now()
      FROM chat_messages m
      WHERE m.id = ${id}::uuid AND m.topic_id = ${topicId}::uuid AND m.created_at IS NOT NULL
      ON CONFLICT (topic_id, user_id) DO UPDATE SET
        last_read_message_id = CASE
          WHEN EXCLUDED.last_read_at > chat_reads.last_read_at THEN EXCLUDED.last_read_message_id
          ELSE chat_reads.last_read_message_id END,
        last_read_at = GREATEST(chat_reads.last_read_at, EXCLUDED.last_read_at),
        updated_at = now()
      RETURNING last_read_at
    `)) as unknown as { rows: unknown[] };

    /*
     * FALLBACK: the message is gone (deleted, or purged) but the client saw it.
     *
     * Without this, deleting one row would freeze that account's cursor in that
     * room forever. The clamped client value is at worst one millisecond
     * conservative — it can leave a message unread, never mark one read — which
     * is the safe direction for a value nothing else can reconstruct.
     */
    if ((upserted.rows ?? []).length === 0) {
      await db
        .insert(chatReads)
        .values({
          topicId,
          userId,
          lastReadMessageId: id,
          lastReadAt: clamped,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [chatReads.topicId, chatReads.userId],
          set: {
            lastReadMessageId: sql`CASE WHEN ${clamped.toISOString()}::timestamptz > ${chatReads.lastReadAt} THEN ${id}::uuid ELSE ${chatReads.lastReadMessageId} END`,
            lastReadAt: sql`GREATEST(${chatReads.lastReadAt}, ${clamped.toISOString()}::timestamptz)`,
            updatedAt: now,
          },
        });
    }

    const states = await readStatesForTopics(db, userId, [topicId]);
    const state = states[topicId] ?? emptyReadState();

    logger.info(ROUTE, 'Read cursor updated', {
      userId,
      topicId,
      lastReadAt: state.lastReadAt,
      unreadCount: state.unreadCount,
    });
    return NextResponse.json(state);
  } catch (error) {
    return unhandledRouteError(ROUTE, 'PUT', error);
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'GET request received');
  try {
    const { topicId } = await params;
    const gated = await gate(request, topicId);
    if ('response' in gated) return gated.response;

    const states = await readStatesForTopics(db, gated.userId, [topicId]);
    return NextResponse.json(states[topicId] ?? emptyReadState());
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}
