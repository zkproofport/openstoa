import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { chatMessages, topicMembers, users } from '@/lib/db/schema';
import { eq, and, desc, count, gt, lt } from 'drizzle-orm';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/[topicId]/chat';

// Max sealed ciphertext size (decoded bytes). Placeholder symmetric cipher in
// Phase 1; MLS framing in Phase 2. Bounds payload size (anti-DoS, SI-4 precursor).
const MAX_CIPHERTEXT_BYTES = 4096;

/** Strictly decode a canonical base64 string, or return null if malformed. */
function decodeBase64Strict(s: unknown): Buffer | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  // Reject anything outside the base64 alphabet (incl. whitespace/newlines).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  if (s.length % 4 !== 0) return null;
  const buf = Buffer.from(s, 'base64');
  // Buffer.from is lenient; require a canonical round-trip to reject sloppy input.
  if (buf.toString('base64') !== s) return null;
  return buf;
}

/**
 * @openapi
 * /api/topics/{topicId}/chat:
 *   get:
 *     tags: [Chat]
 *     summary: Get chat history
 *     description: |
 *       Returns chat messages for a topic. **Membership required** — non-members get 403.
 *
 *       Two pagination modes:
 *         - `since=<iso>` — messages strictly newer than the timestamp, chronological order.
 *           Use this for **polling-based real-time chat** when SSE isn't practical: remember the
 *           latest `createdAt` and re-poll every few seconds.
 *         - `before=<messageId>` — messages strictly older than the given id, reverse-chronological.
 *           Used for infinite scroll upward (loading older history).
 *
 *       Without either parameter, returns the latest `limit` messages newest-first. For agents
 *       that can handle streaming responses, `GET /api/topics/{topicId}/chat/subscribe` is the
 *       lower-latency alternative.
 *     operationId: getChatHistory
 *     x-related-skills: [subscribe-chat-sse, send-chat-message]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID
 *         schema:
 *           type: string
 *           format: uuid
 *       - name: limit
 *         in: query
 *         required: false
 *         description: Number of messages to return (default 50, max 500)
 *         schema:
 *           type: integer
 *           default: 50
 *       - name: since
 *         in: query
 *         required: false
 *         description: ISO timestamp; return messages with createdAt > since
 *         schema:
 *           type: string
 *           format: date-time
 *       - name: before
 *         in: query
 *         required: false
 *         description: Message id; return messages older than this one
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Chat messages
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 messages:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ChatMessage'
 *                 total:
 *                   type: integer
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         description: Topic not found or user is not a member
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'GET request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;

    const membership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (!membership) {
      logger.warn(ROUTE, 'User is not a member', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 500);
    const sinceParam = searchParams.get('since');
    const beforeParam = searchParams.get('before');

    // Build where clause based on pagination mode.
    // Skip 'join' / 'leave' rows from history — those used to be
    // persisted on every SSE connect / disconnect and accumulated
    // forever; new code keeps them ephemeral but old rows still live
    // in chat_messages and would replay as noise without this filter.
    // System messages (join / leave) are now included in history. The
    // previous code filtered them out because SSE connect / disconnect
    // used to persist a row on every transport blip, polluting history.
    // We removed those broadcasts upstream — only real membership
    // transitions persist now, so the history stays clean AND late
    // joiners can see who joined when.
    let whereClause = eq(chatMessages.topicId, topicId);
    let orderByCol = desc(chatMessages.createdAt);

    if (sinceParam) {
      const sinceDate = new Date(sinceParam);
      if (Number.isNaN(sinceDate.getTime())) {
        return NextResponse.json({ error: 'Invalid since timestamp' }, { status: 400 });
      }
      whereClause = and(
        eq(chatMessages.topicId, topicId),
        gt(chatMessages.createdAt, sinceDate),
      )!;
      // Chronological for delta sync — client appends as-is.
      orderByCol = chatMessages.createdAt as never;
    } else if (beforeParam) {
      // Look up the anchor message's createdAt to page strictly older items.
      const anchor = await db.query.chatMessages.findFirst({
        where: eq(chatMessages.id, beforeParam),
        columns: { createdAt: true },
      });
      if (!anchor || !anchor.createdAt) {
        return NextResponse.json({ error: 'before message not found' }, { status: 400 });
      }
      whereClause = and(
        eq(chatMessages.topicId, topicId),
        lt(chatMessages.createdAt, anchor.createdAt),
      )!;
      // Newest-first; client reverses for chronological display.
      orderByCol = desc(chatMessages.createdAt);
    }

    const [rows, [{ value: total }]] = await Promise.all([
      db
        .select({
          id: chatMessages.id,
          topicId: chatMessages.topicId,
          userId: chatMessages.userId,
          systemText: chatMessages.systemText,
          ciphertext: chatMessages.ciphertext,
          epoch: chatMessages.epoch,
          takVersion: chatMessages.takVersion,
          type: chatMessages.type,
          isAI: chatMessages.isAI,
          createdAt: chatMessages.createdAt,
          nickname: users.nickname,
          profileImage: users.profileImage,
        })
        .from(chatMessages)
        .innerJoin(users, eq(chatMessages.userId, users.id))
        .where(whereClause)
        .orderBy(orderByCol)
        .limit(limit),
      db
        .select({ value: count() })
        .from(chatMessages)
        .where(eq(chatMessages.topicId, topicId)),
    ]);

    // Shape rows for the wire: user messages expose only the sealed body
    // (base64) — never plaintext. System rows ('join' | 'leave') expose
    // their plaintext system text (public nicknames only).
    const messages = rows.map((r) => ({
      id: r.id,
      topicId: r.topicId,
      userId: r.userId,
      nickname: r.nickname,
      profileImage: r.profileImage,
      type: r.type,
      isAI: r.isAI,
      createdAt: r.createdAt,
      // Wire field stays `message` (system text) for client compatibility;
      // it is sourced from the renamed `system_text` column and is always null
      // for user rows (their body lives only in `sealed.ciphertext`).
      message: r.type === 'message' ? null : r.systemText,
      sealed:
        r.type === 'message' && r.ciphertext
          ? {
              ciphertext: Buffer.from(r.ciphertext).toString('base64'),
              epoch: r.epoch ?? 0,
              takVersion: r.takVersion ?? null,
            }
          : null,
    }));

    logger.info(ROUTE, 'Chat history fetched', {
      userId: session.userId,
      topicId,
      count: messages.length,
      mode: sinceParam ? 'since' : beforeParam ? 'before' : 'latest',
    });
    return NextResponse.json({ messages, total });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/topics/{topicId}/chat:
 *   post:
 *     tags: [Chat]
 *     summary: Send a chat message (end-to-end encrypted)
 *     description: |
 *       Sends a chat message to the topic. **Membership required**. Chat bodies are
 *       **end-to-end encrypted** — the server never sees plaintext. Seal the body with the
 *       topic GroupCipher first, then send the resulting base64 `ciphertext` (+ `epoch`).
 *       A plaintext `message` field is **rejected with 400**. The sealed row is persisted and
 *       immediately broadcast via Redis pub/sub to every SSE subscriber on
 *       `GET /api/topics/{topicId}/chat/subscribe`. Polling clients pick it up on their next
 *       `GET /api/topics/{topicId}/chat?since=<iso>` call and decrypt locally.
 *     operationId: sendChatMessage
 *     x-related-skills: [get-chat-history, subscribe-chat-sse]
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
 *             required: [ciphertext, epoch]
 *             properties:
 *               ciphertext:
 *                 type: string
 *                 format: byte
 *                 description: base64-encoded sealed message body (max 4096 decoded bytes). Produced by the topic GroupCipher.
 *               epoch:
 *                 type: integer
 *                 description: Group epoch the body was sealed under (placeholder 0 in the Phase 1 rollout).
 *               takVersion:
 *                 type: integer
 *                 nullable: true
 *                 description: Topic Archive Key version, once archiving exists. Omit before archiving.
 *     responses:
 *       201:
 *         description: Message sent
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   $ref: '#/components/schemas/ChatMessage'
 *       400:
 *         description: Missing/invalid ciphertext, or a plaintext message field was supplied
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'POST request received');
  try {
    const session = await getSession(request);
    if (!session) {
      logger.warn(ROUTE, 'Unauthenticated request');
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { topicId } = await params;

    const membership = await db.query.topicMembers.findFirst({
      where: and(
        eq(topicMembers.topicId, topicId),
        eq(topicMembers.userId, session.userId),
      ),
    });

    if (!membership) {
      logger.warn(ROUTE, 'User is not a member', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { ciphertext, epoch, takVersion } = body as Record<string, unknown>;

    // SI-1: the server must never accept a plaintext chat body. User messages
    // are end-to-end encrypted and arrive only as sealed `ciphertext`.
    if ('message' in body) {
      logger.warn(ROUTE, 'Plaintext message field rejected', { userId: session.userId, topicId });
      return NextResponse.json(
        { error: 'Plaintext message not accepted — send sealed ciphertext' },
        { status: 400 },
      );
    }

    const sealedBytes = decodeBase64Strict(ciphertext);
    if (!sealedBytes || sealedBytes.length === 0) {
      logger.warn(ROUTE, 'Missing or invalid ciphertext', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Valid base64 ciphertext is required' }, { status: 400 });
    }
    if (sealedBytes.length > MAX_CIPHERTEXT_BYTES) {
      logger.warn(ROUTE, 'Ciphertext too large', { userId: session.userId, topicId, bytes: sealedBytes.length });
      return NextResponse.json(
        { error: `Ciphertext must be ${MAX_CIPHERTEXT_BYTES} bytes or fewer` },
        { status: 400 },
      );
    }

    // epoch: required non-negative safe integer (placeholder 0 in Phase 1).
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) {
      logger.warn(ROUTE, 'Invalid epoch', { userId: session.userId, topicId, epoch });
      return NextResponse.json({ error: 'epoch must be a non-negative integer' }, { status: 400 });
    }

    // takVersion: optional non-negative integer (Phase 3 archive key version).
    if (
      takVersion !== undefined &&
      takVersion !== null &&
      (typeof takVersion !== 'number' || !Number.isSafeInteger(takVersion) || takVersion < 0)
    ) {
      return NextResponse.json({ error: 'takVersion must be a non-negative integer' }, { status: 400 });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, session.userId),
    });

    const [inserted] = await db
      .insert(chatMessages)
      .values({
        topicId,
        userId: session.userId,
        ciphertext: sealedBytes,
        epoch,
        takVersion: (takVersion as number | undefined) ?? null,
        type: 'message',
        isAI: session.isAI ?? false,
      })
      .returning();

    const payload = {
      id: inserted.id,
      topicId: inserted.topicId,
      userId: inserted.userId,
      nickname: user?.nickname ?? session.nickname,
      profileImage: user?.profileImage ?? null,
      message: null,
      sealed: {
        ciphertext: Buffer.from(inserted.ciphertext!).toString('base64'),
        epoch: inserted.epoch ?? 0,
        takVersion: inserted.takVersion ?? null,
      },
      type: inserted.type,
      isAI: inserted.isAI,
      createdAt: inserted.createdAt,
    };

    const redis = getRedis();
    await redis.publish(`chat:topic:${topicId}`, JSON.stringify({ event: 'message', data: payload }));

    // NOTE: The inline @ask AI command was intentionally removed. AI inside
    // topic chat will return later as a first-class participant (a real
    // user account with isAI=true joining the topic via the normal
    // members flow), not as a magic string parser on the send endpoint.
    // The standalone /ask page is unaffected.

    logger.info(ROUTE, 'Message sent and published', { userId: session.userId, topicId, messageId: inserted.id });
    return NextResponse.json({ message: payload }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
