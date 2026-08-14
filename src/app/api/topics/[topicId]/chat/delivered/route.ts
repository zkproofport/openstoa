import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topicMembers, chatDeliveryCursors } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { isValidUUID } from '@/lib/uuid';
import { requireAiCapability } from '@/lib/aiPermissions';
import { scheduleDeliverySweep } from '@/lib/chatDeliveryPurge';

const ROUTE = '/api/topics/[topicId]/chat/delivered';

/**
 * Cap on a device id.
 *
 * A real one is the base64 of a hash — 44 characters — so this is three times
 * the largest legitimate value and exists only to stop an unbounded string
 * being written to the column.
 */
const MAX_DEVICE_ID_CHARS = 128;

/**
 * @openapi
 * /api/topics/{topicId}/chat/delivered:
 *   post:
 *     tags: [Chat]
 *     summary: Acknowledge chat messages as delivered to this device
 *     description: |
 *       Moves this DEVICE's delivery high-water mark for the topic. The server keeps a message's
 *       live `ciphertext` only until every device that was in the group when it was sent has
 *       fetched it — the live copy is a delivery queue, not storage — so a client that never calls
 *       this endpoint causes the server to hold its ciphertext until the 30-day grace cap.
 *
 *       **Call it after a successful fetch-and-decrypt pass**, with the `createdAt` of the newest
 *       message you have. Never call it for messages you have not actually processed: the mark is
 *       what releases the server's copy, and history then comes only from
 *       `GET /api/topics/{topicId}/archive`.
 *
 *       Per DEVICE, not per user — `deviceId` is your MLS leaf id, the same one used by
 *       `GET /api/topics/{topicId}/tak/bundles`. A user's web browser and phone are separate
 *       devices with separate key stores, and acking on one must not release a message the other
 *       has never seen.
 *
 *       The mark only ever moves FORWARD (an older `through` is accepted and ignored), a value in
 *       the future is clamped to now, and a device id already claimed by another account is
 *       rejected with 403.
 *
 *       **Agents that do not implement MLS may skip this endpoint entirely** — chat is unaffected,
 *       and the server falls back to the grace cap.
 *     operationId: ackChatDelivery
 *     x-related-skills: [get-chat-history, subscribe-chat-sse, get-archive]
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
 *             required: [deviceId, through]
 *             properties:
 *               deviceId:
 *                 type: string
 *                 maxLength: 128
 *                 description: >-
 *                   This device's MLS leaf id — the same value sent to
 *                   `GET /api/topics/{topicId}/tak/bundles?deviceId=`. Bound to your account on
 *                   first use; another account acking it afterwards gets 403.
 *               through:
 *                 type: string
 *                 format: date-time
 *                 description: >-
 *                   ISO timestamp of the newest message this device has fetched and processed,
 *                   INCLUSIVE. Use the `createdAt` of that message verbatim. A future value is
 *                   clamped to the server's clock.
 *     responses:
 *       200:
 *         description: The device's delivery mark after the call
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deliveredThrough:
 *                   type: string
 *                   format: date-time
 *                   description: >-
 *                     The mark now stored. Equal to the request's `through` unless it was clamped,
 *                     or unless a later mark was already recorded.
 *       400:
 *         description: Missing or invalid deviceId / through
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         description: Not a member; or the device id belongs to another account
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
    if (!isValidUUID(topicId)) {
      return NextResponse.json({ error: 'Invalid topicId' }, { status: 400 });
    }

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

    // Acking delivery is part of reading: an agent that may not read chat has
    // nothing it could have taken delivery of.
    const readGate = await requireAiCapability(db, session, '/openstoa/chat/read');
    if (readGate) {
      logger.warn(ROUTE, 'AI caller lacks chat/read capability', { userId: session.userId, topicId });
      return readGate;
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { deviceId, through } = body as Record<string, unknown>;

    if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
      return NextResponse.json({ error: 'deviceId is required' }, { status: 400 });
    }
    const device = deviceId.trim();
    if (device.length > MAX_DEVICE_ID_CHARS) {
      return NextResponse.json(
        { error: `deviceId must be ${MAX_DEVICE_ID_CHARS} characters or fewer` },
        { status: 400 },
      );
    }

    if (typeof through !== 'string' || through.length === 0) {
      return NextResponse.json({ error: 'through is required' }, { status: 400 });
    }
    const asked = new Date(through);
    if (Number.isNaN(asked.getTime())) {
      return NextResponse.json({ error: 'through must be an ISO timestamp' }, { status: 400 });
    }

    /*
     * Clamp a future mark to now.
     *
     * The mark is what releases the server's only live copy, so a device with a
     * skewed clock — or one that simply sends `9999-01-01` — must not be able to
     * declare every message it has never seen delivered. Clamping rather than
     * rejecting keeps a mildly-fast clock working: it acks what exists.
     */
    const now = new Date();
    const mark = asked.getTime() > now.getTime() ? now : asked;

    /*
     * A device id is client-supplied (it is the MLS leaf id), so bind it to the
     * first account that claims it. Without this, one member could ack on behalf
     * of another member's device and hurry along the deletion of messages that
     * device has never fetched.
     */
    const existing = await db.query.chatDeliveryCursors.findFirst({
      where: and(
        eq(chatDeliveryCursors.topicId, topicId),
        eq(chatDeliveryCursors.deviceId, device),
      ),
    });
    if (existing && existing.userId !== session.userId) {
      logger.warn(ROUTE, 'Device id belongs to another account', {
        userId: session.userId,
        topicId,
      });
      return NextResponse.json({ error: 'This device belongs to another account' }, { status: 403 });
    }

    /*
     * Monotonic. Two acks racing from the same device (an SSE settle and a
     * catch-up pass finishing together) must converge on the HIGHER mark, not on
     * whichever statement committed last — the lower one would re-block messages
     * the device has already taken delivery of, and a rewind is the one direction
     * that can make a purge decision wrong in the other direction later.
     */
    await db
      .insert(chatDeliveryCursors)
      .values({
        topicId,
        deviceId: device,
        userId: session.userId,
        deliveredThrough: mark,
        firstSeenAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [chatDeliveryCursors.topicId, chatDeliveryCursors.deviceId],
        set: {
          deliveredThrough: sql`GREATEST(${chatDeliveryCursors.deliveredThrough}, ${mark.toISOString()}::timestamptz)`,
          lastSeenAt: now,
        },
      });

    const stored = existing && existing.deliveredThrough > mark ? existing.deliveredThrough : mark;

    /*
     * A cursor just moved, so a purge may now be possible — this is one of
     * exactly two moments when the answer can change (the other is an archive
     * row landing). Fire-and-forget: reclaiming storage is the service's
     * obligation, not this caller's errand.
     */
    scheduleDeliverySweep(db, topicId, now);

    logger.info(ROUTE, 'Delivery cursor updated', {
      userId: session.userId,
      topicId,
      deliveredThrough: stored.toISOString(),
    });
    return NextResponse.json({ deliveredThrough: stored });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
