import { NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { chatMessages, topicMembers, users } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { getRedis } from '@/lib/redis';
import Redis from 'ioredis';
import { logger } from '@/lib/logger';

const ROUTE = '/api/topics/[topicId]/chat/subscribe';

/**
 * @openapi
 * /api/topics/{topicId}/chat/subscribe:
 *   get:
 *     tags: [Chat]
 *     summary: Subscribe to real-time chat via SSE
 *     description: >-
 *       Opens a Server-Sent Events stream for real-time chat messages in a topic.
 *       Only topic members can subscribe. On connect, adds user to presence tracking,
 *       inserts a join event, and sends the current presence list as the first SSE event.
 *       Sends a heartbeat ping every 30 seconds. On disconnect, removes user from presence
 *       and publishes a leave event.
 *     operationId: subscribeChatSSE
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
 *         description: SSE stream
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
) {
  logger.info(ROUTE, 'GET request received');

  const session = await getSession(request);
  if (!session) {
    logger.warn(ROUTE, 'Unauthenticated request');
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
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
    return new Response(JSON.stringify({ error: 'Not a member of this topic' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, session.userId),
  });

  const nickname = user?.nickname ?? session.nickname;
  const profileImage = user?.profileImage ?? null;
  const presenceKey = `chat:presence:${topicId}`;
  const channelKey = `chat:topic:${topicId}`;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      function send(event: string, data: object) {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // controller may already be closed
        }
      }

      // Create a dedicated Redis subscriber connection
      const redisUrl = process.env.REDIS_URL;
      if (!redisUrl) throw new Error('REDIS_URL environment variable is required');
      const sub = new Redis(redisUrl);

      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

      async function cleanup() {
        if (closed) return;
        closed = true;

        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }

        try {
          // Remove from presence
          const redis = getRedis();
          await redis.hdel(presenceKey, session!.userId);

          // Insert leave message
          const [leaveRow] = await db.insert(chatMessages).values({
            topicId,
            userId: session!.userId,
            message: `${nickname} left the chat`,
            type: 'leave',
          }).returning();

          // Publish leave event as 'message' type so clients receive it uniformly
          const leavePayload = {
            id: leaveRow.id,
            topicId: leaveRow.topicId,
            userId: leaveRow.userId,
            nickname,
            profileImage,
            message: leaveRow.message,
            type: leaveRow.type,
            createdAt: leaveRow.createdAt,
          };
          await redis.publish(channelKey, JSON.stringify({ event: 'message', data: leavePayload }));

          logger.info(ROUTE, 'User left chat', { userId: session!.userId, topicId });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(ROUTE, 'Error during cleanup', { error: msg, userId: session!.userId, topicId });
        }

        try {
          await sub.unsubscribe(channelKey);
          sub.disconnect();
        } catch {
          // ignore
        }

        try {
          controller.close();
        } catch {
          // ignore
        }
      }

      // Handle client disconnect
      request.signal.addEventListener('abort', () => {
        cleanup().catch((err) => {
          logger.error(ROUTE, 'Cleanup error on abort', { error: String(err) });
        });
      });

      try {
        const redis = getRedis();

        // Add to presence
        await redis.hset(
          presenceKey,
          session.userId,
          JSON.stringify({ nickname, profileImage, connectedAt: new Date().toISOString() }),
        );

        // Insert join message
        const [joinRow] = await db.insert(chatMessages).values({
          topicId,
          userId: session.userId,
          message: `${nickname} joined the chat`,
          type: 'join',
        }).returning();

        // Publish join event as 'message' type so clients receive it uniformly
        const joinPayload = {
          id: joinRow.id,
          topicId: joinRow.topicId,
          userId: joinRow.userId,
          nickname,
          profileImage,
          message: joinRow.message,
          type: joinRow.type,
          createdAt: joinRow.createdAt,
        };
        await redis.publish(channelKey, JSON.stringify({ event: 'message', data: joinPayload }));

        // Send initial presence list
        const presenceRaw = await redis.hgetall(presenceKey);
        const presenceUsers = Object.entries(presenceRaw).map(([userId, val]) => {
          try {
            return { userId, ...JSON.parse(val) };
          } catch {
            return { userId };
          }
        });
        send('presence', { users: presenceUsers, count: presenceUsers.length });

        logger.info(ROUTE, 'User joined chat', { userId: session.userId, topicId });

        // Subscribe to Redis channel
        await sub.subscribe(channelKey);

        sub.on('message', (_channel: string, messageStr: string) => {
          try {
            const parsed = JSON.parse(messageStr) as { event: string; data: object };
            send(parsed.event, parsed.data);
          } catch (err) {
            logger.warn(ROUTE, 'Failed to parse Redis message', { error: String(err) });
          }
        });

        sub.on('error', (err: Error) => {
          logger.error(ROUTE, 'Redis subscriber error', { error: err.message, userId: session.userId, topicId });
          cleanup().catch(() => {});
        });

        // Heartbeat every 30 seconds
        heartbeatTimer = setInterval(() => {
          send('ping', {});
        }, 30_000);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(ROUTE, 'Error setting up SSE stream', { error: msg, userId: session.userId, topicId });
        await cleanup();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
