import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topicMembers } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import {
  decodeBase64Strict,
  checkRateLimit,
  MLS_MAX_ARCHIVE_BYTES,
  MLS_RATE_ARCHIVE,
} from '@/lib/mls/http';
import { storeArchiveRow, getArchiveSince, type ArchiveCursor } from '@/lib/mls/archive';
import { requireAiCapability } from '@/lib/aiPermissions';
import { historyGrantDenial, resolveEnforcedHistoryGrant } from '@/lib/historyGrant';
import { getArchiveWindowed, isUnboundedWindow, resolveHistoryWindow } from '@/lib/mls/historyWindow';

const ROUTE = '/api/topics/[topicId]/archive';
const ARCHIVE_PAGE_DEFAULT = 200;
const ARCHIVE_PAGE_MAX = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireMember(request: NextRequest, topicId: string) {
  const session = await getSession(request);
  if (!session) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  const membership = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
  });
  if (!membership) return { error: NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 }) };
  return { session };
}

/**
 * @openapi
 * /api/topics/{topicId}/archive:
 *   post:
 *     tags: [MLS]
 *     summary: Store a TAK-re-encrypted past message (archive ingest)
 *     description: |
 *       Stores one past message body re-encrypted under the topic's current TAK so later members
 *       can read it (Phase 3, design §9.2). The **client** does the re-encryption — the server must
 *       never see plaintext (SI-1), so it stores opaque ciphertext keyed by the original message id
 *       and the TAK version used. Idempotent: one archive row per message, so a retry or two senders
 *       racing the same message do not duplicate. **Membership required.** Rate-limited and
 *       size-capped (SI-4).
 *     operationId: storeArchiveMessage
 *     x-related-skills: [get-archive, deliver-tak-bundle]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [messageId, takVersion, archive]
 *             properties:
 *               messageId:
 *                 type: string
 *                 format: uuid
 *                 description: id of the original chat_messages row this archive body corresponds to.
 *               takVersion:
 *                 type: integer
 *                 description: which TAK version encrypted this body (lets the reader pick the right key).
 *               archive:
 *                 type: string
 *                 format: byte
 *                 description: base64 TAK-encrypted message body. Server stores it as-is. Capped at 256 KiB.
 *     responses:
 *       201: { description: Archive row stored }
 *       200: { description: Archive row already existed for this message (idempotent no-op) }
 *       400: { description: Invalid messageId/takVersion or invalid/oversized archive }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       429: { description: Per-member rate limit exceeded (SI-4) }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await requireMember(request, topicId);
    if ('error' in auth) return auth.error!;
    const { session } = auth;

    if (!(await checkRateLimit('archive', session.userId, MLS_RATE_ARCHIVE))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { messageId, takVersion, archive } = body as Record<string, unknown>;

    if (typeof messageId !== 'string' || !UUID_RE.test(messageId)) {
      return NextResponse.json({ error: 'messageId must be a uuid' }, { status: 400 });
    }
    if (typeof takVersion !== 'number' || !Number.isSafeInteger(takVersion) || takVersion < 0) {
      return NextResponse.json({ error: 'takVersion must be a non-negative integer' }, { status: 400 });
    }

    const archiveBytes = decodeBase64Strict(archive);
    if (!archiveBytes || archiveBytes.length === 0) {
      return NextResponse.json({ error: 'Valid base64 archive is required' }, { status: 400 });
    }
    if (archiveBytes.length > MLS_MAX_ARCHIVE_BYTES) {
      return NextResponse.json({ error: `archive must be ${MLS_MAX_ARCHIVE_BYTES} bytes or fewer` }, { status: 400 });
    }

    const stored = await storeArchiveRow(db, topicId, messageId, takVersion, archiveBytes);
    logger.info(ROUTE, 'Archive row ingest', { topicId, userId: session.userId, messageId, takVersion, stored });
    return NextResponse.json({ stored }, { status: stored ? 201 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/topics/{topicId}/archive:
 *   get:
 *     tags: [MLS]
 *     summary: Read TAK-encrypted archived messages (keyset paginated)
 *     description: |
 *       Returns archived (past) message bodies as ciphertext, ascending by creation order, for a
 *       member to back-fill history after joining. The reader decrypts each with the TAK it received
 *       via `GET /tak/bundles` (matching `takVersion`). Pagination is keyset: pass the last row's
 *       `createdAt` + `messageId` back as `since` + `sinceMsg` to get the next page — exact even when
 *       rows share a timestamp (no skips, no duplicates). **Membership required** (a removed member
 *       gets 403 — D11 archive gating).
 *
 *       **API-key callers — two scopes apply.** The key needs `/openstoa/chat/read` in its `cmd`
 *       (else 403), AND its `historyGrant` bounds which rows come back: `full` = everything,
 *       `none` = **403**, `Nd` / `since_epoch:N` / `N` = only rows whose ORIGINAL message falls
 *       inside that window (the bound is on the message's own age and epoch, not on when the row
 *       was archived). Pair the grant with the matching TAK bundles from `GET /tak/bundles`, which
 *       enforces the same grant. Human sessions are unaffected.
 *     operationId: getArchive
 *     x-related-skills: [store-archive-message, get-tak-bundles]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - name: since
 *         in: query
 *         required: false
 *         description: keyset cursor — createdAt (ISO) of the last row from the previous page.
 *         schema: { type: string, format: date-time }
 *       - name: sinceMsg
 *         in: query
 *         required: false
 *         description: keyset cursor tiebreak — messageId of the last row from the previous page (required with `since`).
 *         schema: { type: string, format: uuid }
 *       - name: limit
 *         in: query
 *         required: false
 *         description: page size (default 200, max 500).
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Archived messages in chronological order
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 archive:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       messageId: { type: string, format: uuid }
 *                       takVersion: { type: integer }
 *                       ciphertext: { type: string, format: byte, description: base64 TAK-encrypted body }
 *                       createdAt: { type: string, format: date-time }
 *       400: { description: Invalid since/sinceMsg/limit }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403:
 *         description: |
 *           Not a member; or an API key lacking `/openstoa/chat/read`; or an API key whose
 *           `historyGrant` is `none`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await requireMember(request, topicId);
    if ('error' in auth) return auth.error!;

    // Profile-level AI capability (design §7): an isAI reader must hold the
    // chat/read capability — keeps out-of-scope past unreadable at the server
    // gate. Humans are gated by membership only.
    const readGate = await requireAiCapability(db, auth.session, '/openstoa/chat/read');
    if (readGate) return readGate;

    // …and the key's own history grant bounds WHICH archived rows it may pull
    // back (`src/lib/historyGrant.ts`). `null` = human or `full`: the read below
    // then takes the original, unbounded path.
    const grant = resolveEnforcedHistoryGrant(auth.session);
    const grantDenied = historyGrantDenial(grant);
    if (grantDenied) {
      logger.warn(ROUTE, 'AI caller has no history grant', { topicId, userId: auth.session.userId });
      return grantDenied;
    }

    const sp = new URL(request.url).searchParams;
    const since = sp.get('since');
    const sinceMsg = sp.get('sinceMsg');
    const limitRaw = sp.get('limit');

    let limit = ARCHIVE_PAGE_DEFAULT;
    if (limitRaw !== null) {
      const n = parseInt(limitRaw, 10);
      if (!Number.isSafeInteger(n) || n <= 0) {
        return NextResponse.json({ error: 'limit must be a positive integer' }, { status: 400 });
      }
      limit = Math.min(n, ARCHIVE_PAGE_MAX);
    }

    let cursor: ArchiveCursor | null = null;
    if (since !== null) {
      // Validate it parses, but pass the ORIGINAL string through — re-stringifying
      // via Date would drop sub-millisecond precision and corrupt the keyset cursor.
      if (Number.isNaN(Date.parse(since))) {
        return NextResponse.json({ error: 'since must be an ISO timestamp' }, { status: 400 });
      }
      if (!sinceMsg || !UUID_RE.test(sinceMsg)) {
        return NextResponse.json({ error: 'sinceMsg (uuid) is required with since' }, { status: 400 });
      }
      cursor = { createdAt: since, messageId: sinceMsg };
    }

    // A bounded grant goes through the windowed read (joins chat_messages so the
    // bound is on the ORIGINAL message's age, not on when the row was archived —
    // see src/lib/mls/historyWindow.ts). Everyone else keeps the plain read.
    const window = grant ? await resolveHistoryWindow(db, topicId, grant) : null;
    const rows = window && !isUnboundedWindow(window)
      ? await getArchiveWindowed(db, topicId, cursor, limit, window)
      : await getArchiveSince(db, topicId, cursor, limit);
    return NextResponse.json({
      archive: rows.map((r) => ({
        messageId: r.messageId,
        takVersion: r.takVersion,
        ciphertext: r.ciphertext.toString('base64'),
        createdAt: r.createdAt,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
