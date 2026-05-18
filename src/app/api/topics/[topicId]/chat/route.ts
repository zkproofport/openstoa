import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { chatMessages, topicMembers, users } from '@/lib/db/schema';
import { eq, and, desc, count, gt, lt, notInArray } from 'drizzle-orm';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/[topicId]/chat';

/**
 * @openapi
 * /api/topics/{topicId}/chat:
 *   get:
 *     tags: [Chat]
 *     summary: Get chat history
 *     description: >-
 *       Returns chat messages for a topic. Only topic members can access.
 *       Supports two pagination modes:
 *         - `since=<iso>` returns messages strictly newer than the given
 *           timestamp, in chronological order. Used by clients on reconnect
 *           to fetch only the messages they missed.
 *         - `before=<messageId>` returns messages strictly older than the
 *           given message id, in reverse-chronological order. Used for
 *           infinite scroll upward (loading older history).
 *       Without either parameter, returns the latest `limit` messages
 *       (newest-first), as before.
 *     operationId: getChatHistory
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
    const notSystem = notInArray(chatMessages.type, ['join', 'leave']);
    let whereClause = and(eq(chatMessages.topicId, topicId), notSystem)!;
    let orderByCol = desc(chatMessages.createdAt);

    if (sinceParam) {
      const sinceDate = new Date(sinceParam);
      if (Number.isNaN(sinceDate.getTime())) {
        return NextResponse.json({ error: 'Invalid since timestamp' }, { status: 400 });
      }
      whereClause = and(
        eq(chatMessages.topicId, topicId),
        notSystem,
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
        notSystem,
        lt(chatMessages.createdAt, anchor.createdAt),
      )!;
      // Newest-first; client reverses for chronological display.
      orderByCol = desc(chatMessages.createdAt);
    }

    const [messages, [{ value: total }]] = await Promise.all([
      db
        .select({
          id: chatMessages.id,
          topicId: chatMessages.topicId,
          userId: chatMessages.userId,
          message: chatMessages.message,
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
        .where(and(eq(chatMessages.topicId, topicId), notSystem)),
    ]);

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
 *     summary: Send a chat message
 *     description: >-
 *       Sends a message to the topic chat. Only topic members can send messages.
 *       The message is persisted to the database and broadcast via Redis pub/sub.
 *     operationId: sendChatMessage
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
 *             required: [message]
 *             properties:
 *               message:
 *                 type: string
 *                 maxLength: 1000
 *                 description: The chat message text
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
 *         description: Invalid or missing message
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

    const body = await request.json();
    const { message } = body;

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      logger.warn(ROUTE, 'Missing or empty message', { userId: session.userId, topicId });
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    if (message.length > 1000) {
      logger.warn(ROUTE, 'Message too long', { userId: session.userId, topicId, length: message.length });
      return NextResponse.json({ error: 'Message must be 1000 characters or fewer' }, { status: 400 });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, session.userId),
    });

    const [inserted] = await db
      .insert(chatMessages)
      .values({
        topicId,
        userId: session.userId,
        message: message.trim(),
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
      message: inserted.message,
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
