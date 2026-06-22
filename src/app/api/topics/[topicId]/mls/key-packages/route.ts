import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { deviceKeyPackages, topicMembers } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import {
  decodeBase64Strict,
  checkRateLimit,
  MLS_MAX_KEY_PACKAGE_BYTES,
  MLS_RATE_KEY_PACKAGE,
} from '@/lib/mls/http';
import { consumeOneKeyPackage } from '@/lib/mls/keyPackages';

const ROUTE = '/api/topics/[topicId]/mls/key-packages';

async function requireMember(request: NextRequest, topicId: string) {
  const session = await getSession(request);
  if (!session) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  const membership = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, session.userId)),
  });
  if (!membership) {
    return { error: NextResponse.json({ error: 'Not a member of this topic' }, { status: 403 }) };
  }
  return { session };
}

/**
 * @openapi
 * /api/topics/{topicId}/mls/key-packages:
 *   post:
 *     tags: [MLS]
 *     summary: Publish a device MLS KeyPackage (public key material)
 *     description: |
 *       Publishes one **public** MLS KeyPackage (RFC 9420 §10) for the caller's device into the
 *       topic's KeyPackage directory. A KeyPackage is the joining device's offer of public keys;
 *       an existing member later **consumes** one (via `GET`) to MLS-Add the device to the group.
 *       KeyPackages are **single-use** — each is consumed at most once (SI-3) — so a device should
 *       keep a few unconsumed packages published. Always-on AI members publish a reusable
 *       `isLastResort` package instead. The server stores opaque public bytes and runs no MLS
 *       crypto: it never sees private keys. **Membership required.**
 *     operationId: publishMlsKeyPackage
 *     x-related-skills: [commit-mls, get-mls-group-info]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         description: Topic ID (the MLS group is keyed by the topic).
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [keyPackage, deviceId]
 *             properties:
 *               keyPackage:
 *                 type: string
 *                 format: byte
 *                 description: base64-encoded public KeyPackage bytes (RFC 9420), max 16384 decoded bytes.
 *               deviceId:
 *                 type: string
 *                 description: Stable per-device identifier so a user's multiple devices each keep their own packages.
 *               isLastResort:
 *                 type: boolean
 *                 description: If true, the package is reusable (not consumed). Reserved for always-on AI members.
 *     responses:
 *       201: { description: KeyPackage published }
 *       400: { description: Missing/invalid base64 keyPackage or deviceId, or payload too large }
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

    if (!(await checkRateLimit('key-package', session.userId, MLS_RATE_KEY_PACKAGE))) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const { keyPackage, deviceId, isAI, isLastResort } = body as Record<string, unknown>;

    const kpBytes = decodeBase64Strict(keyPackage);
    if (!kpBytes || kpBytes.length === 0) {
      return NextResponse.json({ error: 'Valid base64 keyPackage is required' }, { status: 400 });
    }
    if (kpBytes.length > MLS_MAX_KEY_PACKAGE_BYTES) {
      return NextResponse.json(
        { error: `keyPackage must be ${MLS_MAX_KEY_PACKAGE_BYTES} bytes or fewer` },
        { status: 400 },
      );
    }
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > 256) {
      return NextResponse.json({ error: 'deviceId is required (1-256 chars)' }, { status: 400 });
    }

    const [inserted] = await db
      .insert(deviceKeyPackages)
      .values({
        userId: session.userId,
        deviceId,
        keyPackage: kpBytes,
        isAI: session.isAI ?? Boolean(isAI),
        isLastResort: Boolean(isLastResort),
      })
      .returning({ id: deviceKeyPackages.id });

    logger.info(ROUTE, 'KeyPackage published', { userId: session.userId, topicId, deviceId, id: inserted.id });
    return NextResponse.json({ id: inserted.id }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in POST', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * @openapi
 * /api/topics/{topicId}/mls/key-packages:
 *   get:
 *     tags: [MLS]
 *     summary: Atomically consume one KeyPackage for a joining device (SI-3)
 *     description: |
 *       Called by an existing member who is about to MLS-Add a joiner. Atomically claims **exactly
 *       one** unconsumed KeyPackage belonging to `userId` (`UPDATE ... WHERE consumed_at IS NULL
 *       ... RETURNING` with row locking), so two concurrent adders can never consume the same
 *       package (SI-3 — no double-join). Non-last-resort packages are marked consumed; last-resort
 *       (AI) packages are returned without consuming. Returns 404 when the user has no package
 *       available. **Membership required.**
 *     operationId: consumeMlsKeyPackage
 *     x-related-skills: [publish-mls-key-package, commit-mls]
 *     parameters:
 *       - name: topicId
 *         in: path
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - name: userId
 *         in: query
 *         required: true
 *         description: The joining user (nullifier) whose KeyPackage to consume.
 *         schema: { type: string }
 *       - name: deviceId
 *         in: query
 *         required: false
 *         description: Optionally restrict to a specific device of that user.
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: One KeyPackage, now consumed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string, format: uuid }
 *                 deviceId: { type: string }
 *                 keyPackage: { type: string, format: byte, description: base64 KeyPackage bytes }
 *                 isLastResort: { type: boolean }
 *       400: { description: Missing userId }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { description: No unconsumed KeyPackage available for that user }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ topicId: string }> },
): Promise<NextResponse> {
  try {
    const { topicId } = await params;
    const auth = await requireMember(request, topicId);
    if ('error' in auth) return auth.error!;

    const { searchParams } = new URL(request.url);
    const targetUserId = searchParams.get('userId');
    const targetDeviceId = searchParams.get('deviceId');
    if (!targetUserId) {
      return NextResponse.json({ error: 'userId query parameter is required' }, { status: 400 });
    }

    // SI-3 atomic consume (shared with the concurrency test via the helper).
    const consumed = await consumeOneKeyPackage(db, targetUserId, targetDeviceId);
    if (!consumed) {
      return NextResponse.json({ error: 'No KeyPackage available for that user' }, { status: 404 });
    }
    logger.info(ROUTE, 'KeyPackage consumed', { topicId, targetUserId, id: consumed.id, lastResort: consumed.isLastResort });
    return NextResponse.json({
      id: consumed.id,
      deviceId: consumed.deviceId,
      keyPackage: consumed.keyPackage.toString('base64'),
      isLastResort: consumed.isLastResort,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(ROUTE, 'Unhandled error in GET', { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
