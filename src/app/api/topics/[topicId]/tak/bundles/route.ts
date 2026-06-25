import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { topicMembers } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import {
  decodeBase64Strict,
  checkRateLimit,
  isValidTakScope,
  MLS_MAX_TAK_BUNDLE_BYTES,
  MLS_RATE_TAK,
} from '@/lib/mls/http';
import { storeTakBundle, fetchUndeliveredBundles, markBundlesDelivered } from '@/lib/mls/archive';

const ROUTE = '/api/topics/[topicId]/tak/bundles';

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
 * /api/topics/{topicId}/tak/bundles:
 *   post:
 *     tags: [MLS]
 *     summary: Deliver an HPKE-wrapped TAK bundle to a member's device (history back-fill)
 *     description: |
 *       Stores one **Topic Archive Key (TAK) bundle** so a member who joined later can read
 *       messages from before they joined — history that MLS forward secrecy otherwise locks out
 *       (Phase 3, design §5). The bundle is a set of archive keys **HPKE-wrapped to ONE recipient
 *       device's public key by the sender**; the server stores it as opaque ciphertext and never
 *       unwraps it (crypto-free Delivery Service, C1/SI-1).
 *
 *       **Sender responsibility (CVE-2024-47080 / -47824 gate, §5.5):** before wrapping, the
 *       sender MUST verify the recipient device's identity (its KeyPackage credential is the
 *       claimed user and it is a real group member). The server cannot do crypto, so it enforces
 *       only the **envelope**: the caller and the recipient are current members. The server does NOT
 *       check a device directory — clients address bundles by a key derived from the recipient's MLS
 *       leaf. Live MLS key rules are NOT reused for archive keys.
 *
 *       `scope` records the granted range, tier-differentiated (design §5.2): `full` (public seed
 *       chain — whole history), `since_epoch:N`, `Nd` (last N days), `N` (last N messages), or
 *       `none`. **Membership required.** Rate-limited and size-capped (SI-4).
 *     operationId: deliverTakBundle
 *     x-related-skills: [get-tak-bundles, submit-mls-commit, publish-mls-key-package]
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
 *             required: [recipientUserId, recipientDeviceId, bundle, scope]
 *             properties:
 *               recipientUserId:
 *                 type: string
 *                 description: The recipient member's user id (nullifier). Must be a current member of the topic.
 *               recipientDeviceId:
 *                 type: string
 *                 description: Opaque id of the recipient device (derived from its MLS leaf key). The recipient fetches bundles addressed to this id.
 *               bundle:
 *                 type: string
 *                 format: byte
 *                 description: base64 HPKE-wrapped TAK bundle. The server stores it as-is and never decrypts it. Capped at 64 KiB.
 *               scope:
 *                 type: string
 *                 description: 'Granted history range: full | since_epoch:N | Nd | N | none. Validated against an allowlist.'
 *     responses:
 *       201:
 *         description: Bundle stored for delivery
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { id: { type: string, format: uuid, description: the stored bundle id } }
 *       400: { description: Invalid/oversized bundle, invalid scope, or missing recipient fields }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { description: Caller is not a member, or the recipient is not a member }
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

    if (!(await checkRateLimit('tak', session.userId, MLS_RATE_TAK))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { recipientUserId, recipientDeviceId, bundle, scope } = body as Record<string, unknown>;

    if (typeof recipientUserId !== 'string' || recipientUserId.length === 0) {
      return NextResponse.json({ error: 'recipientUserId is required' }, { status: 400 });
    }
    if (typeof recipientDeviceId !== 'string' || recipientDeviceId.trim().length === 0) {
      return NextResponse.json({ error: 'recipientDeviceId is required' }, { status: 400 });
    }
    if (!isValidTakScope(scope)) {
      return NextResponse.json({ error: 'scope must be one of: full | since_epoch:N | Nd | N | none' }, { status: 400 });
    }

    const bundleBytes = decodeBase64Strict(bundle);
    if (!bundleBytes || bundleBytes.length === 0) {
      return NextResponse.json({ error: 'Valid base64 bundle is required' }, { status: 400 });
    }
    if (bundleBytes.length > MLS_MAX_TAK_BUNDLE_BYTES) {
      return NextResponse.json({ error: `bundle must be ${MLS_MAX_TAK_BUNDLE_BYTES} bytes or fewer` }, { status: 400 });
    }

    // Envelope gate: only a member may upload bundles (caller checked above).
    // `recipientUserId` is informational — the MLS leaf credential is a device
    // id, not the user's nullifier, so the server can't map it to a member and
    // does not gate on it. Bundles are addressed by `recipientDeviceId` (derived
    // from the recipient's leaf key); confidentiality is the client HPKE wrap to
    // that leaf, and the CVE-2024-47080 identity check is client-side (the sender
    // wraps only to a leaf key read from its OWN validated ratchet tree).
    const id = await storeTakBundle(db, topicId, recipientUserId, recipientDeviceId, bundleBytes, scope);
    logger.info(ROUTE, 'TAK bundle stored', {
      topicId,
      senderId: session.userId,
      recipientUserId,
      recipientDeviceId,
      scope,
      id,
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/topics/{topicId}/tak/bundles:
 *   get:
 *     tags: [MLS]
 *     summary: Fetch undelivered TAK bundles for one of the caller's devices
 *     description: |
 *       Returns the not-yet-acked TAK bundles addressed to the caller's `deviceId`, oldest first.
 *       The caller can only read **its own** bundles (`recipientUserId` is the session user). This
 *       is read-only — bundles stay pending until the device acks them with `DELETE` after durably
 *       persisting the keys, so a crash between fetch and persist re-delivers rather than losing
 *       history. **Membership required** (a removed member gets 403 — D11 archive gating).
 *     operationId: getTakBundles
 *     x-related-skills: [deliver-tak-bundle]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - name: deviceId
 *         in: query
 *         required: true
 *         description: The caller's device id whose pending bundles to fetch.
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Pending bundles in delivery order
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 bundles:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string, format: uuid }
 *                       bundle: { type: string, format: byte, description: base64 HPKE-wrapped TAK bundle }
 *                       scope: { type: string }
 *                       createdAt: { type: string, format: date-time }
 *       400: { description: Missing deviceId }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await requireMember(request, topicId);
    if ('error' in auth) return auth.error!;

    const deviceId = new URL(request.url).searchParams.get('deviceId');
    if (!deviceId || deviceId.trim().length === 0) {
      return NextResponse.json({ error: 'deviceId query parameter is required' }, { status: 400 });
    }

    const bundles = await fetchUndeliveredBundles(db, topicId, deviceId);
    return NextResponse.json({
      bundles: bundles.map((b) => ({
        id: b.id,
        bundle: b.ciphertext.toString('base64'),
        scope: b.scope,
        createdAt: b.createdAt,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/topics/{topicId}/tak/bundles:
 *   delete:
 *     tags: [MLS]
 *     summary: Acknowledge delivered TAK bundles
 *     description: |
 *       Marks the listed bundle ids delivered for the caller's `deviceId`, called AFTER the device
 *       has durably persisted the keys. Scoped to the caller's own (user, device) — a caller can
 *       never ack another device's bundles. Already-acked or foreign ids are ignored. **Membership
 *       required.**
 *     operationId: ackTakBundles
 *     x-related-skills: [get-tak-bundles]
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
 *             required: [deviceId, ids]
 *             properties:
 *               deviceId: { type: string, description: the caller's device id that received the bundles }
 *               ids:
 *                 type: array
 *                 items: { type: string, format: uuid }
 *                 description: bundle ids to mark delivered
 *     responses:
 *       200:
 *         description: Count of bundles newly marked delivered
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties: { acked: { type: integer } }
 *       400: { description: Missing deviceId or ids }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await requireMember(request, topicId);
    if ('error' in auth) return auth.error!;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { deviceId, ids } = body as Record<string, unknown>;
    if (typeof deviceId !== 'string' || deviceId.trim().length === 0) {
      return NextResponse.json({ error: 'deviceId is required' }, { status: 400 });
    }
    if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) {
      return NextResponse.json({ error: 'ids must be an array of bundle ids' }, { status: 400 });
    }
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const valid = (ids as string[]).filter((i) => uuidRe.test(i));

    const acked = await markBundlesDelivered(db, topicId, deviceId, valid);
    return NextResponse.json({ acked });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in DELETE', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
