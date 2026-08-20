import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import Redis from 'ioredis';
import { logger } from '@/lib/logger';
import {
  markUserStreamClosed,
  markUserStreamOpen,
  userChannel,
} from '@/lib/userEvents';

const ROUTE = '/api/me/events';

/**
 * @openapi
 * /api/me/events:
 *   get:
 *     tags: [Account]
 *     summary: Subscribe to events addressed to this account (SSE)
 *     description: |
 *       Opens a long-lived **Server-Sent Events** stream for the signed-in account, across every
 *       topic. Authentication required; the stream carries only this account's events.
 *
 *       This exists because the chat stream is per topic and only lives while that room is open.
 *       Scoped-tier chat (`private`, `secret`) keeps its keys on devices, so the device that can
 *       hand a key over is usually NOT in the room — which is why a newcomer used to wait for
 *       somebody to happen to reopen the chat. A client subscribes here once while the app is
 *       open and acts on what arrives.
 *
 *       Event shape: `event: <kind>\ndata: <json>\n\n`.
 *
 *       - `key-needed` — `{ topicId, epoch }`. Someone in that topic may be missing chat keys.
 *         A client that holds keys for it should run its grant; one that holds none does
 *         nothing. Nothing secret is in this payload — the keys themselves travel sealed to a
 *         recipient device through the bundle mailbox, which the server cannot open.
 *       - `ping` — heartbeat every 30s. Treat a gap over 60s as a drop and reconnect.
 *
 *       Advisory, never authoritative: a client that misses an event is not stuck, because the
 *       chat room retries a grant on its own while it is open.
 *     operationId: subscribeAccountEvents
 *     x-related-skills: [subscribe-chat-sse]
 *     parameters:
 *       - in: query
 *         name: device
 *         required: false
 *         schema:
 *           type: string
 *         description: |
 *           The `routingHandle` this device registered for push, if it has one. Send it and the
 *           server knows this device is already listening, so a `key-needed` fan-out reaches it
 *           over this stream instead of also waking it with a notification. Omit it on any client
 *           with no push registration — a browser, a CLI, an agent — and the stream still receives
 *           everything; it simply does not suppress a push that was never going to be sent.
 *           Sending a handle that is not yours only silences your own stream, never someone else's.
 *     responses:
 *       200:
 *         description: SSE stream opened
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
export async function GET(request: NextRequest) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }
  const userId = session.userId;
  const channelKey = userChannel(userId);

  /*
   * Which DEVICE this stream belongs to.
   *
   * The mini-app sends the push routing handle it already has, because the
   * fan-out decides per device whether to push: presence recorded under a
   * different name than the push target would suppress nothing, or worse,
   * suppress the wrong device. The web has no push at all, so it sends
   * nothing and gets a per-connection id — one that can never match a push
   * target, and therefore never silences a real device.
   */
  const requested = request.nextUrl.searchParams.get('device');
  const deviceHandle =
    requested && requested.length > 0 && requested.length <= 128
      ? requested
      : `anon:${crypto.randomUUID()}`;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;

      function send(event: string, data: object) {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller may already be closed
        }
      }

      // A dedicated connection: a subscribed ioredis client cannot also serve
      // ordinary commands, so sharing the pooled one would break every caller.
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
          // Drop the reachability marker at once rather than letting it time
          // out: until it goes, the fan-out keeps choosing this stream over a
          // push, and the events go nowhere.
          await markUserStreamClosed(userId, deviceHandle);
        } catch {
          // The TTL is the backstop; a failure here costs at most one window.
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

      request.signal.addEventListener('abort', () => {
        cleanup().catch((err) => {
          logger.error(ROUTE, 'Cleanup error on abort', { error: String(err) });
        });
      });

      try {
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
          logger.error(ROUTE, 'Redis subscriber error', { error: err.message, userId });
          cleanup().catch(() => {});
        });

        // Reachable from now on: the fan-out will route this account's events
        // here instead of waking it with a push.
        await markUserStreamOpen(userId, deviceHandle);

        // Sent immediately so a client can tell "connected" from "connecting"
        // without waiting up to 30 seconds for the first heartbeat.
        send('ping', {});
        heartbeatTimer = setInterval(() => {
          send('ping', {});
          // The marker expires on its own, so the heartbeat is also what keeps
          // it alive — a stream that stops beating stops being chosen.
          void markUserStreamOpen(userId, deviceHandle).catch(() => {});
        }, 30_000);
        logger.info(ROUTE, 'Account stream opened', { userId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(ROUTE, 'Error setting up SSE stream', { error: msg, userId });
        await cleanup();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
