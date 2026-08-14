/**
 * Encrypted chat attachments (R-3): store, serve and delete OPAQUE bytes.
 *
 * The server holds ciphertext and nothing else. It cannot tell a photo from a
 * screenshot from a random 4KB, it is never given the key, and the key is never
 * derivable from anything it stores — the AEAD key comes from the topic's TAK,
 * which lives only on member devices, and the object reference travels inside
 * the MLS-sealed message body (SI-1 / C1).
 *
 * That is also why this route exists at all instead of `/api/upload`: that one
 * sniffs magic bytes, transcodes HEIC, validates image content types and writes
 * to a permanently PUBLIC URL. Every one of those is either impossible or wrong
 * for bytes the server may not read. The plaintext route is left exactly as it
 * was for post images, topic covers and avatars.
 *
 * Reads go through here rather than a public CDN URL for two reasons: a public
 * object URL is an unauthenticated handle that outlives every membership check
 * in the product, and a cross-origin `fetch` of the ciphertext (which the client
 * must do, because it has to decrypt before displaying) needs an origin that
 * answers to us.
 *
 * Intentionally NOT in the OpenAPI surface: this is E2EE client transport, not
 * an agent-callable endpoint. An agent cannot decrypt what it fetches here.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { chatMedia, topicMembers, topics } from '@/lib/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { unhandledRouteError } from '@/lib/apiError';
import { isValidUUID } from '@/lib/uuid';
import { checkRateLimit, decodeBase64Strict, type RateLimit } from '@/lib/mls/http';
import { deleteR2Object, getR2Object, putR2Object } from '@/lib/r2';
import {
  MAX_CHAT_MEDIA_CIPHERTEXT_BYTES,
  chatMediaObjectKey,
  isChatMediaKeyForTopic,
} from '@/lib/chatMedia';

const ROUTE = '/api/topics/[topicId]/chat/media';

/**
 * Uploads are bounded per member: an attachment is up to 10MB of storage the
 * server can never inspect, so the flood case has to be cheap to refuse. 60/min
 * is far above any human attach rate and far below a useful abuse rate.
 */
const RATE_MEDIA_UPLOAD: RateLimit = { max: 60, windowSec: 60 };

const MEDIA_ID_RE = /^[0-9a-f]{32}$/;
/** The `{userId}` path segment. A nullifier, but never trusted to be one. */
const USER_SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Stamp `claimed_at` on an unclaimed row, swallowing everything.
 *
 * A `.catch()` on the query alone is not enough: a query builder that throws
 * SYNCHRONOUSLY (a bad connection, a bug in the chain) never produces a promise
 * to catch, so the throw lands in the caller's try block and a member's read
 * answers 500 because a bookkeeping write failed. The try/catch here is the
 * part that makes it truly fire-and-forget.
 */
function claimQuietly(topicId: string, objectKey: string): void {
  const swallow = (err: unknown) => {
    logger.warn(ROUTE, 'Claim-on-read failed', {
      topicId,
      error: err instanceof Error ? err.message : String(err),
    });
  };
  try {
    void db
      .update(chatMedia)
      .set({ claimedAt: sql`now()` })
      .where(and(eq(chatMedia.objectKey, objectKey), eq(chatMedia.topicId, topicId), isNull(chatMedia.claimedAt)))
      .catch(swallow);
  } catch (err) {
    swallow(err);
  }
}

/**
 * Is this key one THIS member uploaded?
 *
 * Rebuilt through `chatMediaObjectKey` and compared whole, rather than matched
 * against a prefix spelled out here. A hand-written `chat/{topicId}/{userId}/`
 * silently stopped matching the moment the storage layout moved under
 * `topics/{topicId}/…` (M-3), and a false answer here does not fail loudly — it
 * just tells uploaders they may not touch their own attachment. Deriving it
 * cannot drift, and an exact comparison is stricter than a prefix anyway.
 */
function isOwnObjectKey(key: string, topicId: string, userId: string): boolean {
  const mediaId = key.slice(key.lastIndexOf('/') + 1).replace(/\.bin$/, '');
  return key === chatMediaObjectKey(topicId, userId, mediaId);
}

async function requireMember(request: NextRequest, topicId: string) {
  const session = await getSession(request);
  if (!session) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  const membership = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
  });
  if (!membership) {
    logger.warn(ROUTE, 'Non-member request', { userId: session.userId, topicId });
    return { error: NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 }) };
  }
  return { session, membership };
}

/** Store one encrypted attachment. Body: `{ mediaId, ciphertext }` (base64). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const { topicId } = await params;
    if (!isValidUUID(topicId)) {
      return NextResponse.json({ error: 'Invalid topicId' }, { status: 400 });
    }
    const gate = await requireMember(request, topicId);
    if (gate.error) return gate.error;
    const session = gate.session!;

    if (!USER_SEGMENT_RE.test(session.userId)) {
      logger.error(ROUTE, 'Session userId is not usable as an object key segment', { topicId });
      return NextResponse.json({ error: 'Unsupported account id' }, { status: 400 });
    }

    if (!(await checkRateLimit('chat-media', session.userId, RATE_MEDIA_UPLOAD))) {
      return NextResponse.json({ error: 'Too many uploads' }, { status: 429 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
    }
    const { mediaId, ciphertext } = (body ?? {}) as { mediaId?: unknown; ciphertext?: unknown };

    if (typeof mediaId !== 'string' || !MEDIA_ID_RE.test(mediaId)) {
      return NextResponse.json({ error: 'mediaId must be 32 lowercase hex characters' }, { status: 400 });
    }
    const bytes = decodeBase64Strict(ciphertext);
    if (!bytes) {
      return NextResponse.json({ error: 'ciphertext must be canonical base64' }, { status: 400 });
    }
    if (bytes.length === 0) {
      return NextResponse.json({ error: 'ciphertext is empty' }, { status: 400 });
    }
    if (bytes.length > MAX_CHAT_MEDIA_CIPHERTEXT_BYTES) {
      logger.warn(ROUTE, 'Attachment too large', { userId: session.userId, topicId, size: bytes.length });
      return NextResponse.json({ error: 'Attachment is too large' }, { status: 400 });
    }

    // NOTE: no content sniffing, no transcode, no content-type check. The bytes
    // are AEAD output; anything that "recognised" them would mean they are not.
    const key = chatMediaObjectKey(topicId, session.userId, mediaId);

    /*
     * INDEX FIRST, then store (M-1).
     *
     * The order is the whole point of the row. Insert after a successful upload
     * and a failed insert strands an object that nothing can ever find again —
     * its only other reference is inside a sealed message body the server
     * cannot read. This way a failed upload leaves a row pointing at an object
     * that does not exist, which the unclaimed collector removes on its next
     * pass: the failure mode is self-healing instead of permanent.
     *
     * `onConflictDoNothing` on the unique key makes a retry of the same upload
     * idempotent rather than a 500.
     */
    await db
      .insert(chatMedia)
      .values({ topicId, objectKey: key, uploaderId: session.userId })
      .onConflictDoNothing({ target: chatMedia.objectKey });

    try {
      await putR2Object(key, bytes);
    } catch (err) {
      /*
       * The object provably does not exist, so the row must not either.
       *
       * Index-before-store is right — an object with no row can never be found
       * again — but the mirror state is not harmless: a row naming an object
       * that was never written is a handle to nothing, and the unclaimed
       * collector would not tidy it for an hour. We are already INSIDE the
       * failure, so we clean it up here rather than leaning on a sweep.
       *
       * NOTE the asymmetry with DELETE, which keeps its row when the object
       * delete fails: there the object may still exist, so the row is the only
       * thing that will ever name it again. Opposite states, opposite rules.
       */
      await db
        .delete(chatMedia)
        .where(and(eq(chatMedia.objectKey, key), eq(chatMedia.topicId, topicId)))
        .catch((cleanupErr: unknown) => {
          // Now it IS the collector's problem — an unclaimed row pointing at
          // nothing, which it removes after the grace window.
          logger.error(ROUTE, 'Could not roll back the index row after a failed store', {
            topicId,
            error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
          });
        });
      throw err;
    }

    logger.info(ROUTE, 'Stored encrypted attachment', {
      userId: session.userId,
      topicId,
      key,
      size: bytes.length,
    });
    return NextResponse.json({ key });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'POST', error);
  }
}

/** Serve one encrypted attachment to a member of its topic. `?key=` */
export async function GET(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const { topicId } = await params;
    if (!isValidUUID(topicId)) {
      return NextResponse.json({ error: 'Invalid topicId' }, { status: 400 });
    }
    const key = new URL(request.url).searchParams.get('key');
    // Membership first, key second: answering 400 to a non-member would tell
    // them whether a key is well-formed for this topic before establishing that
    // they may ask about this topic at all.
    const gate = await requireMember(request, topicId);
    if (gate.error) return gate.error;

    // The key is attacker-supplied — it arrives from inside a message body any
    // member could have written. This is what confines it to this topic.
    if (!isChatMediaKeyForTopic(key, topicId)) {
      logger.warn(ROUTE, 'Rejected attachment key', { topicId, key });
      return NextResponse.json({ error: 'Invalid attachment key' }, { status: 400 });
    }

    const bytes = await getR2Object(key);
    if (!bytes) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });

    /*
     * A successful READ is proof the object is live, so it claims it too (M-1).
     *
     * The only way a member obtains this key is out of a sealed message body
     * they were able to open — so someone reaching this line means a real
     * message references this object, which is precisely what `claimed_at`
     * records. That makes the collector self-healing: if the uploader's own
     * claim never landed (offline, crash, a dropped PATCH), the first reader
     * repairs it, and an object that no message references is never read and so
     * is never claimed.
     *
     * Fire-and-forget, and only on an unclaimed row, so a read costs at most
     * one narrow UPDATE and never fails because of one.
     */
    claimQuietly(topicId, key);

    /*
     * base64 in JSON rather than a binary stream, on both clients.
     *
     * React Native's `Response.arrayBuffer()` is not dependable (its FileReader
     * has no readAsArrayBuffer), so a binary body would work in the browser and
     * fail on the phone — and shipping two response shapes for one object is
     * how the two clients drift. 33% on the wire buys one code path for an
     * attachment that is capped at 10MB and sent by hand.
     */
    return NextResponse.json(
      { ciphertext: Buffer.from(bytes).toString('base64') },
      {
        headers: {
          // Ciphertext is immutable and per-member: cache on the device, never
          // in a shared cache.
          'Cache-Control': 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    );
  } catch (error) {
    return unhandledRouteError(ROUTE, 'GET', error);
  }
}

/**
 * CLAIM one attachment — "the message referencing this went out". `?key=`
 *
 * An upload happens before the message POST, so an object whose POST never
 * landed has nothing referencing it and nothing that will ever delete it. The
 * client calls this once the send succeeds; anything still unclaimed after the
 * grace window is collected.
 *
 * Deliberately carries NO message id. The server could store one and get a
 * tidier lifecycle, at the price of a map of exactly which messages contain
 * pictures — the metadata the sealed envelope exists to withhold. A bare
 * timestamp says everything the collector needs and nothing else.
 *
 * Idempotent, and only the uploader may claim: claiming is a statement about
 * one's own upload.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const { topicId } = await params;
    if (!isValidUUID(topicId)) {
      return NextResponse.json({ error: 'Invalid topicId' }, { status: 400 });
    }
    const key = new URL(request.url).searchParams.get('key');
    const gate = await requireMember(request, topicId);
    if (gate.error) return gate.error;
    const session = gate.session!;

    if (!isChatMediaKeyForTopic(key, topicId)) {
      return NextResponse.json({ error: 'Invalid attachment key' }, { status: 400 });
    }
    if (!isOwnObjectKey(key, topicId, session.userId)) {
      logger.warn(ROUTE, 'Claim attempted on another member attachment', {
        userId: session.userId,
        topicId,
      });
      return NextResponse.json({ error: 'Not allowed to claim this attachment' }, { status: 403 });
    }

    // Only an UNCLAIMED row is stamped: a second claim must not move the
    // timestamp, or a client retry would keep resetting it.
    const claimed = await db
      .update(chatMedia)
      .set({ claimedAt: sql`now()` })
      .where(and(eq(chatMedia.objectKey, key), eq(chatMedia.topicId, topicId), isNull(chatMedia.claimedAt)))
      .returning({ id: chatMedia.id });

    // A key with no row is a pre-M-1 upload (or one already collected). Not an
    // error: there is nothing to claim and nothing that will delete it.
    return NextResponse.json({ claimed: claimed.length > 0 });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'PATCH', error);
  }
}

/**
 * Delete one attachment. `?key=`
 *
 * Two callers: a client cleaning up after its own message POST failed (the
 * object is already uploaded and nothing will ever reference it), and a topic
 * owner or admin removing content. Anyone else deleting another member's
 * attachment would be destroying a message body they cannot even read.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ topicId: string }> }) {
  try {
    const { topicId } = await params;
    if (!isValidUUID(topicId)) {
      return NextResponse.json({ error: 'Invalid topicId' }, { status: 400 });
    }
    const key = new URL(request.url).searchParams.get('key');
    const gate = await requireMember(request, topicId);
    if (gate.error) return gate.error;
    const session = gate.session!;

    if (!isChatMediaKeyForTopic(key, topicId)) {
      return NextResponse.json({ error: 'Invalid attachment key' }, { status: 400 });
    }

    // The uploader owns the `{userId}` segment of their own keys.
    const isUploader = isOwnObjectKey(key, topicId, session.userId);
    let allowed = isUploader || session.role === 'admin' || gate.membership?.role === 'owner';
    if (!allowed) {
      const topic = await db.query.topics.findFirst({ where: eq(topics.id, topicId) });
      allowed = topic?.creatorId === session.userId;
    }
    if (!allowed) {
      logger.warn(ROUTE, 'Unauthorized attachment delete', { userId: session.userId, topicId, key });
      return NextResponse.json({ error: 'Not allowed to delete this attachment' }, { status: 403 });
    }

    // Object first, then its index row: a row outliving a deleted object costs
    // one wasted retry, while a deleted row over a surviving object strands it
    // permanently — the server can never name that object again.
    const deleted = await deleteR2Object(key);
    if (deleted) {
      await db.delete(chatMedia).where(and(eq(chatMedia.objectKey, key), eq(chatMedia.topicId, topicId)));
    }
    return NextResponse.json({ deleted });
  } catch (error) {
    return unhandledRouteError(ROUTE, 'DELETE', error);
  }
}
