import { NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topicMembers, users } from '@/lib/db/schema';
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
 *     description: |
 *       Opens a long-lived **Server-Sent Events** stream pushing real-time chat events for the
 *       topic. **Membership required**.
 *
 *       Event shape: each event is `event: <kind>\ndata: <json>\n\n` with `kind` ∈
 *       `{ presence, message, join, leave, ping }`. The first event is always `presence` with the
 *       current member-list snapshot. New `message` events arrive whenever any member calls
 *       `POST /api/topics/{topicId}/chat`. A `ping` heartbeat is sent every 30s — agents should
 *       treat missing pings for >60s as a connection drop and reconnect.
 *
 *       Agent usage from a CLI / runtime that supports streaming responses:
 *       `fetch(url, { headers: { Authorization: 'Bearer …' } })` and then iterate over the
 *       response body's reader. If your runtime can't hold a long-lived connection, poll
 *       `GET /api/topics/{topicId}/chat?since=<iso>` instead.
 *     operationId: subscribeChatSSE
 *     x-related-skills: [get-chat-history, send-chat-message, get-chat-presence]
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
          // Remove from presence. Do NOT publish a "left the chat" system
          // message: an SSE disconnect is a *transport* event (app went to
          // background, network blip, hot reload, screen unmount) and NOT
          // a topic-level membership change. Posting a `leave` row on
          // every disconnect produced a noisy stream of "${nickname} left"
          // bubbles every time the user backgrounded the app. The real
          // "left the chat" semantics belong to membership removal (kick
          // from `DELETE /api/topics/[topicId]/members`), which publishes
          // its own broadcast at that point.
          const redis = getRedis();
          await redis.hdel(presenceKey, session!.userId);
          logger.info(ROUTE, 'SSE disconnect (presence cleared)', { userId: session!.userId, topicId });
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

        await sub.subscribe(channelKey);

        sub.on('message', (_channel: string, messageStr: string) => {
          try {
            const parsed = JSON.parse(messageStr) as { event: string; data: object };
            send(parsed.event, parsed.data);
          } catch (err) {
            logger.warn(ROUTE, 'Failed to parse Redis message', { error: String(err) });
          }
        });

        // Add to presence. Do NOT publish a "joined the chat" system
        // message here: SSE connect is a *transport* event, not a
        // topic-level membership change. The real "joined the chat"
        // broadcast lives in `/api/topics/[topicId]/join` and
        // `/api/topics/join/[inviteCode]` (first-time membership), so
        // re-entering the chat screen does not re-announce the user.
        await redis.hset(
          presenceKey,
          session.userId,
          JSON.stringify({ nickname, profileImage, connectedAt: new Date().toISOString() }),
        );

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
