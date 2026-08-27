import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { chatMessages, topicMembers, topics, users } from '@/lib/db/schema';
import { eq, and, desc, count, gt, gte, lt } from 'drizzle-orm';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { isValidUUID } from '@/lib/uuid';
import { requireAiCapability } from '@/lib/aiPermissions';
import { historyGrantDenial, resolveEnforcedHistoryGrant } from '@/lib/historyGrant';
import { resolveHistoryWindow } from '@/lib/mls/historyWindow';
import {
  dispatchDummyForMessage,
  dispatchCiphertextForMessage,
  getPushProvider,
  getPushMode,
} from '@/lib/push';

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

/** The optional TAK-sealed preview copy a sender may attach for push (design §13.6). */
interface PushArchiveInput {
  ct: string;
  takVersion: number;
}

/**
 * Validate the OPTIONAL `pushArchive` field. It is a preview optimisation, not
 * message data: anything malformed returns null and the message is stored and
 * dispatched exactly as if the field had been absent (NEVER a 400 — a client
 * with a broken archive layer must still be able to chat). The bytes are opaque
 * to the server (it holds no TAK) and are never persisted here; the archive row
 * itself is still written by the separate POST /archive call.
 */
function parsePushArchive(v: unknown): PushArchiveInput | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { ct, takVersion } = v as Record<string, unknown>;
  const bytes = decodeBase64Strict(ct);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_CIPHERTEXT_BYTES) return null;
  if (typeof takVersion !== 'number' || !Number.isSafeInteger(takVersion) || takVersion < 0) return null;
  return { ct: ct as string, takVersion };
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
 *
 *       **API-key callers — two scopes apply.** The key needs the `/openstoa/chat/read`
 *       capability in its `cmd` (else 403), AND its `historyGrant` bounds how far back it can
 *       see: `full` = everything, `none` = **403, no history at all**, `Nd` = only messages from
 *       the last N days, `since_epoch:N` = only messages sealed at group epoch N or later,
 *       `N` = only the newest N messages. The bound is applied in the query, so paging with
 *       `before=` cannot walk past it, and `total` counts only what is inside the window. Issue
 *       the key with the grant you actually need — see `POST /api/profile/api-keys`. Human
 *       (non-agent) sessions are unaffected.
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
 *         description: |
 *           Not a member; or an API key lacking the `/openstoa/chat/read` capability; or an API
 *           key whose `historyGrant` is `none` (it may not read history at all).
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

    // Profile-level AI capability (design §7): an isAI reader must hold the
    // chat/read capability in its owner's profile, else 403. Humans unaffected.
    const readGate = await requireAiCapability(db, session, '/openstoa/chat/read');
    if (readGate) {
      logger.warn(ROUTE, 'AI caller lacks chat/read capability', { userId: session.userId, topicId });
      return readGate;
    }

    // The key's OWN history grant (design §7, `src/lib/historyGrant.ts`): holding
    // chat/read says the key may call this endpoint, the grant says how far back
    // it may see. `null` = human or `full` — the query below is then built
    // exactly as it was before this gate existed.
    const grant = resolveEnforcedHistoryGrant(session);
    const grantDenied = historyGrantDenial(grant);
    if (grantDenied) {
      logger.warn(ROUTE, 'AI caller has no history grant', { userId: session.userId, topicId });
      return grantDenied;
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

    // Apply the history grant to BOTH the page and the total. It bounds the page
    // so out-of-scope rows are never selected (not filtered after the fact, so
    // pagination cannot walk around it), and it bounds `total` so the count does
    // not leak how much history exists beyond the window.
    let totalWhere = eq(chatMessages.topicId, topicId);
    if (grant) {
      const window = await resolveHistoryWindow(db, topicId, grant);
      const bounds = [];
      if (window.createdAfter) bounds.push(gte(chatMessages.createdAt, window.createdAfter));
      // NULL epochs (system join/leave rows) fall outside `>=` and are excluded
      // under a since_epoch grant — conservative on purpose: a row whose epoch is
      // unknown cannot be proven to be inside the granted range.
      if (window.minEpoch !== null) bounds.push(gte(chatMessages.epoch, window.minEpoch));
      if (bounds.length > 0) {
        whereClause = and(whereClause, ...bounds)!;
        totalWhere = and(totalWhere, ...bounds)!;
      }
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
        .where(totalWhere),
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
    return unhandledRouteError(ROUTE, 'GET', error);
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
 *               pushArchive:
 *                 type: object
 *                 nullable: true
 *                 description: |
 *                   **Optional, push-preview only.** A second copy of this same body sealed under the
 *                   topic's **Topic Archive Key (TAK)** instead of the MLS group key, so a recipient's
 *                   iOS Notification Service Extension can show the real message on the lockscreen.
 *                   It exists because opening the live MLS `ciphertext` would consume a forward-secret
 *                   ratchet key and desync that device's group state, while the TAK is a stable
 *                   symmetric key and consumes nothing.
 *
 *                   Send it in this request (not afterwards): push fan-out happens inside this call, so
 *                   the copy uploaded by `POST /api/topics/{topicId}/archive` does not exist yet.
 *                   The server treats these bytes as opaque, never stores them, and never decrypts them.
 *
 *                   **Agents that do not implement MLS/TAK should simply omit this field** — chat works
 *                   identically without it; recipients then get a content-free "New message" push.
 *                   A malformed value is ignored (never a 400).
 *                 properties:
 *                   ct:
 *                     type: string
 *                     format: byte
 *                     description: |
 *                       base64 of `nonce ‖ AEAD(HKDF(TAK, "openstoa-archive/v1:push-preview"), body)`,
 *                       max 4096 decoded bytes (same cap as `ciphertext`). Bigger values are ignored.
 *                   takVersion:
 *                     type: integer
 *                     minimum: 0
 *                     description: |
 *                       TAK version `ct` was sealed under — `0` for a public topic (the shared archive
 *                       root key), otherwise the current MLS epoch for private/secret topics.
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

    // Profile-level AI capability (design §7): an isAI caller must hold the
    // chat/send capability in its owner's profile, else 403. Humans (no isAI)
    // are unaffected — membership is their only gate.
    const sendGate = await requireAiCapability(db, session, '/openstoa/chat/send');
    if (sendGate) {
      logger.warn(ROUTE, 'AI caller lacks chat/send capability', { userId: session.userId, topicId });
      return sendGate;
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { ciphertext, epoch, takVersion, pushArchive, type: messageType } =
      body as Record<string, unknown>;

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

      /*
       * `notice` — a message the SYSTEM addresses to this person, sealed.
       *
       * NOT a `join`/`leave` system row: those carry `systemText`, a PLAINTEXT
       * column the server reads (SI-1). A recovery code cannot go there — it is
       * the value that opens `master_key`, and storing it in the clear defeats
       * everything it protects. A notice is sealed like any other message; only
       * its TYPE differs.
       *
       * NOT an ordinary message either. The client draws the bubble on the RIGHT
       * when the row's `userId` matches the reader, and the reader's own token is
       * what files this — so the recovery note appeared as something the person
       * had written to themselves. They had not. A notice renders as a RECEIVED
       * bubble: it keeps tap-to-copy (a code that cannot be copied is barely a
       * copy) without claiming an author.
       *
       * PERSONAL ROOM ONLY. Otherwise anyone could post something that looks
       * like it came from the system into a room they share — "the system"
       * telling members to paste a code somewhere is a phishing primitive. A
       * person's own space has nobody to deceive.
       */
      let rowType: 'message' | 'notice' = 'message';
      if (messageType !== undefined && messageType !== null) {
        if (messageType !== 'notice') {
          return NextResponse.json(
            { error: "type must be 'notice' when present" },
            { status: 400 },
          );
        }
        const topicRow = await db.query.topics.findFirst({
          where: eq(topics.id, topicId),
          columns: { personal: true, creatorId: true },
        });
        if (!topicRow?.personal || topicRow.creatorId !== session.userId) {
          logger.warn(ROUTE, 'notice refused outside the caller own personal room', {
            userId: session.userId,
            topicId,
          });
          return NextResponse.json(
            { error: 'A notice may only be filed in your own space' },
            { status: 403 },
          );
        }
        rowType = 'notice';
      }

    const [inserted] = await db
      .insert(chatMessages)
      .values({
        topicId,
        userId: session.userId,
        ciphertext: sealedBytes,
        epoch,
        takVersion: (takVersion as number | undefined) ?? null,
        type: rowType,
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

    // Push (design §13, D12-D14): notify every other member's device.
    // Fire-and-forget — a push failure (or an unconfigured provider) must NEVER
    // break the 200 response. Mode is env-gated (`PUSH_MODE`):
    //   content-free (Phase A, default) — a dummy "New message" with zero
    //     content (SI-1); the tapped app fetches + decrypts locally.
    //   ciphertext   (Phase B, §13.5) — additionally carries the OPAQUE sealed
    //     ciphertext already stored above, so an on-device NSE / FCM handler can
    //     preview on the lockscreen; over the size budget it self-falls-back to
    //     the content-free dummy. Either way no plaintext ever leaves the server.
    // §13.6 strategy A: when the sender attached a TAK-sealed copy it rides along
    // as `act`/`tv` — the only body an iOS NSE can safely open (decrypting the MLS
    // `ct` would consume a ratchet key and desync that device). Ignored when
    // absent/malformed; the dispatch itself is unchanged.
    // The try/catch covers the SYNCHRONOUS part (provider resolution, payload
    // assembly); .catch() covers the async fan-out. Both must be swallowed — the
    // message is already stored and published, so nothing about push may turn a
    // successful send into a 500.
    try {
      const preview = parsePushArchive(pushArchive);
      const pushProvider = getPushProvider();
      const pushDispatch =
        getPushMode() === 'ciphertext'
          ? dispatchCiphertextForMessage(
              db,
              {
                topicId,
                senderUserId: session.userId,
                messageId: inserted.id,
                sealedCiphertextB64: payload.sealed.ciphertext,
                epoch: payload.sealed.epoch,
                archiveCiphertextB64: preview?.ct,
                takVersion: preview?.takVersion,
              },
              pushProvider,
            )
          : dispatchDummyForMessage(db, topicId, session.userId, pushProvider);
      pushDispatch.catch((err) => logger.warn(ROUTE, 'push dispatch failed', { topicId, err: String(err) }));
    } catch (err) {
      logger.warn(ROUTE, 'push dispatch setup failed', { topicId, err: String(err) });
    }

    // NOTE: The inline @ask AI command was intentionally removed. AI inside
    // topic chat will return later as a first-class participant (a real
    // user account with isAI=true joining the topic via the normal
    // members flow), not as a magic string parser on the send endpoint.
    // The standalone /ask page is unaffected.

    logger.info(ROUTE, 'Message sent and published', { userId: session.userId, topicId, messageId: inserted.id });
    return NextResponse.json({ message: payload }, { status: 201 });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}
