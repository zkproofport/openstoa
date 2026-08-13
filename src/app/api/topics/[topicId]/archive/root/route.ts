import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topics, topicMembers, topicArchiveRoots, chatArchive } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { chatTierOf, serverMayHoldKey } from '@/lib/chatTierPolicy';

const ROUTE = '/api/topics/[topicId]/archive/root';

/**
 * The archive root a PUBLIC topic keeps here so that a member who joins later
 * reads history at once.
 *
 * This endpoint exists for exactly one tier, and refusing every other tier is
 * the point rather than a detail: a `private` topic's root travels in its
 * invite link and a `secret` topic's never leaves its members' devices, so a
 * root arriving here for either of them would be a client bug quietly turning
 * off end-to-end encryption. It is refused loudly instead.
 *
 * Anyone may join a public topic, so its history is not secret from the public
 * — only from the operator, and that is the trade this tier makes deliberately.
 * See `docs/design/openstoa-chat-history-decision.md`.
 */
async function loadPublicTopic(topicId: string) {
  const topic = await db.query.topics.findFirst({ where: eq(topics.id, topicId) });
  if (!topic) return { error: 'Topic not found', status: 404 as const };
  // Asked, not restated. The tier table is the one place that decides which
  // tiers may put a key here; a copy of that rule in this file is a copy that
  // will eventually disagree with it.
  if (!serverMayHoldKey(chatTierOf(topic.visibility, false))) {
    return { error: 'This topic does not keep its archive key on the server', status: 403 as const };
  }
  return { topic };
}

/**
 * @openapi
 * /api/topics/{topicId}/archive/root:
 *   get:
 *     summary: Fetch the server-held archive root (public topics only)
 *     description: |
 *       Returns the archive root for a **public** topic, so a member who joined after
 *       the conversation started can decrypt its history immediately. Members only.
 *
 *       Refused with 403 for `private` and `secret` topics: their archive keys never
 *       reach the server. A private topic's root travels inside its invite link; a
 *       secret topic shares no history at all.
 *     tags: [Chat]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: The topic whose archive root is wanted.
 *     responses:
 *       200:
 *         description: The archive root, base64.
 *       204:
 *         description: No root deposited yet — nothing has been archived.
 *       403:
 *         description: Not a member, or the topic is not public.
 *       404:
 *         description: Topic not found.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { topicId } = await params;
    const loaded = await loadPublicTopic(topicId);
    if ('error' in loaded) {
      logger.warn(ROUTE, 'Root read refused', { topicId, userId: session.userId, reason: loaded.error });
      return NextResponse.json({ error: loaded.error }, { status: loaded.status });
    }

    // A public topic is joinable by anyone, but the key still goes to members
    // only: joining is the act that puts someone in the room, and it is free.
    const membership = await db.query.topicMembers.findFirst({
      where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
    });
    if (!membership) {
      return NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 });
    }

    const row = await db.query.topicArchiveRoots.findFirst({
      where: eq(topicArchiveRoots.topicId, topicId),
    });
    // Nothing archived yet is not an error — a brand-new topic has no history
    // to hand over, and saying "not found" would read as a fault.
    if (!row) return new NextResponse(null, { status: 204 });

    return NextResponse.json({ rootKey: row.rootKey });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/topics/{topicId}/archive/root:
 *   put:
 *     summary: Deposit the archive root (public topics only)
 *     description: |
 *       Stores the archive root for a **public** topic, so later joiners can read
 *       history without waiting for another member to be online. Members only.
 *
 *       Write-once: a second deposit with a DIFFERENT key is refused, because the
 *       archive is sealed under the first one and replacing it would strand every
 *       row already written. Re-depositing the same key is a no-op, which is what
 *       makes the client's retry safe.
 *
 *       Refused with 403 for `private` and `secret` topics — their keys must never
 *       reach the server.
 *     tags: [Chat]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rootKey]
 *             properties:
 *               rootKey:
 *                 type: string
 *                 description: The archive root, base64. Same value the client seals archive rows with.
 *     responses:
 *       200: { description: Stored, or already stored with this same key. }
 *       400: { description: Missing or malformed rootKey. }
 *       403: { description: Not a member, or the topic is not public. }
 *       409: { description: A DIFFERENT root is already stored for this topic. }
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const session = await getSession(request);
    if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { topicId } = await params;
    const loaded = await loadPublicTopic(topicId);
    if ('error' in loaded) {
      logger.warn(ROUTE, 'Root deposit refused', { topicId, userId: session.userId, reason: loaded.error });
      return NextResponse.json({ error: loaded.error }, { status: loaded.status });
    }

    const membership = await db.query.topicMembers.findFirst({
      where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
    });
    if (!membership) {
      return NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const rootKey = (body as { rootKey?: unknown } | null)?.rootKey;
    // Length-checked, not just typed: an empty string is a plausible bug in a
    // caller and would store a key that decrypts nothing, forever.
    if (typeof rootKey !== 'string' || rootKey.length === 0 || rootKey.length > 512) {
      return NextResponse.json({ error: 'rootKey must be a non-empty base64 string' }, { status: 400 });
    }

    const existing = await db.query.topicArchiveRoots.findFirst({
      where: eq(topicArchiveRoots.topicId, topicId),
    });

    /*
     * A root arriving AFTER the archive has rows cannot be the root those rows
     * were sealed under, so accepting it would hand every later reader a key
     * that opens nothing and quietly lose the history.
     *
     * The client used to guard this itself by decrypting the oldest row and
     * checking. Doing it here is both simpler and stronger: it holds for every
     * client, including one with a bug, and the row count is something the
     * server can see without reading a single message.
     */
    if (!existing) {
      const [{ count } = { count: 0 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(chatArchive)
        .where(eq(chatArchive.topicId, topicId));
      if (count > 0) {
        logger.warn(ROUTE, 'Refused a first root deposit for a topic that already has archive rows', {
          topicId,
          userId: session.userId,
          archiveRows: count,
        });
        return NextResponse.json(
          { error: 'This topic already has an archive; its root cannot be replaced' },
          { status: 409 },
        );
      }
    }
    if (existing) {
      // Idempotent for the same key so a client retry cannot fail; a conflict
      // for a different one, because the archive is already sealed under the
      // first and swapping it would strand every row written so far.
      if (existing.rootKey === rootKey) return NextResponse.json({ ok: true });
      logger.warn(ROUTE, 'Refused to replace an existing archive root', { topicId, userId: session.userId });
      return NextResponse.json({ error: 'A different archive root is already stored' }, { status: 409 });
    }

    await db.insert(topicArchiveRoots).values({
      topicId,
      rootKey,
      depositedBy: session.userId,
    });

    logger.info(ROUTE, 'Archive root deposited', { topicId, userId: session.userId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
