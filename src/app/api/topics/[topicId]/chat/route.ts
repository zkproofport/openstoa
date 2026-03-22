import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { chatMessages, topicMembers, users } from '@/lib/db/schema';
import { eq, and, desc, count } from 'drizzle-orm';
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
 *       Returns paginated chat messages for a topic. Only topic members can access.
 *       Messages are returned in descending order (newest first).
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
 *         description: Number of messages to return (default 50, max 100)
 *         schema:
 *           type: integer
 *           default: 50
 *       - name: offset
 *         in: query
 *         required: false
 *         description: Number of messages to skip
 *         schema:
 *           type: integer
 *           default: 0
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
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 100);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10);

    const [messages, [{ value: total }]] = await Promise.all([
      db
        .select({
          id: chatMessages.id,
          topicId: chatMessages.topicId,
          userId: chatMessages.userId,
          message: chatMessages.message,
          type: chatMessages.type,
          createdAt: chatMessages.createdAt,
          nickname: users.nickname,
          profileImage: users.profileImage,
        })
        .from(chatMessages)
        .innerJoin(users, eq(chatMessages.userId, users.id))
        .where(eq(chatMessages.topicId, topicId))
        .orderBy(desc(chatMessages.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ value: count() })
        .from(chatMessages)
        .where(eq(chatMessages.topicId, topicId)),
    ]);

    logger.info(ROUTE, 'Chat history fetched', { userId: session.userId, topicId, count: messages.length });
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
      createdAt: inserted.createdAt,
    };

    const redis = getRedis();
    await redis.publish(`chat:topic:${topicId}`, JSON.stringify({ event: 'message', data: payload }));

    // Handle @ask command
    if (message.trim().startsWith('@ask ')) {
      const question = message.trim().slice(5).trim();
      if (question) {
        try {
          const askRes = await fetch(`${request.nextUrl.origin}/api/ask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question }),
          });
          if (askRes.ok) {
            const { answer } = await askRes.json();
            const [aiMsg] = await db.insert(chatMessages).values({
              topicId,
              userId: session.userId,
              message: `🤖 ${answer}`,
              type: 'message',
            }).returning();
            await redis.publish(`chat:topic:${topicId}`, JSON.stringify({
              event: 'message',
              data: {
                id: aiMsg.id,
                topicId: aiMsg.topicId,
                userId: aiMsg.userId,
                nickname: 'OpenStoa AI',
                profileImage: null,
                message: aiMsg.message,
                type: aiMsg.type,
                createdAt: aiMsg.createdAt,
              },
            }));
            logger.info(ROUTE, '@ask AI response published', { topicId, messageId: aiMsg.id });
          }
        } catch (e) {
          logger.warn(ROUTE, '@ask handler failed', { error: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    logger.info(ROUTE, 'Message sent and published', { userId: session.userId, topicId, messageId: inserted.id });
    return NextResponse.json({ message: payload }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
