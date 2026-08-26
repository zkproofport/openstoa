import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { getSession } from '@/lib/session';
import { db } from '@/lib/db';
import { deviceSigningKeys } from '@/lib/db/schema';
import { deviceFromRequest } from '@/lib/deviceFromRequest';
import {
  issueNonce,
  spendNonce,
  verifyDeviceSignature,
  samePublicKey,
} from '@/lib/deviceProof';
import { logger } from '@/lib/logger';

const ROUTE = '/api/auth/device/challenge';

/**
 * @openapi
 * /api/auth/device/challenge:
 *   get:
 *     summary: Get a nonce to prove this device
 *     description: |
 *       Returns a one-time random value for the caller to sign with its device key. Send it back to
 *       `POST /api/auth/device/challenge` together with the signature and the device's public key.
 *
 *       **Agents do not need this.** An API key already identifies the caller; this exists because a
 *       phone's device id is a string the phone chose, which the server has no way to check. Signing
 *       proves possession of a key instead of asserting a name.
 *
 *       The nonce is answerable for two minutes and exactly once. A second attempt with the same
 *       value fails even inside that window, so a captured signature is not a reusable password.
 *     operationId: getDeviceChallenge
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: A nonce to sign
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nonce:
 *                   type: string
 *                   description: Base64. Sign the DECODED BYTES, not this text.
 *                 expiresInSeconds:
 *                   type: integer
 *                   description: How long it stays answerable.
 *       401:
 *         description: No session
 */
export async function GET(request: NextRequest) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const nonce = await issueNonce(session.userId);
  return NextResponse.json({ nonce, expiresInSeconds: 120 });
}

/**
 * @openapi
 * /api/auth/device/challenge:
 *   post:
 *     summary: Prove this device, registering its key on first use
 *     description: |
 *       Answers the nonce from `GET /api/auth/device/challenge`. Send the signature over the DECODED
 *       nonce bytes and the device's Ed25519 public key, both base64.
 *
 *       **First call for a device registers the key**, because there is no earlier moment at which the
 *       server could have learned it — the key is generated on the phone and the private half never
 *       leaves. Later calls check against what was registered.
 *
 *       A device that presents a DIFFERENT key for an id it has already registered is answered `409`,
 *       not accepted. That is a genuinely new install which lost the private half, and quietly
 *       accepting it is how one phone came to hold 48 separate identities — each one leaving the
 *       messages before it unreadable to the next. Sign in again, or restore from a backup.
 *     operationId: proveDevice
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [nonce, signature, publicKey]
 *             properties:
 *               nonce:
 *                 type: string
 *                 description: Exactly the value from GET, base64.
 *               signature:
 *                 type: string
 *                 description: Ed25519 signature over the DECODED nonce bytes, base64.
 *               publicKey:
 *                 type: string
 *                 description: The device's Ed25519 public key, 32 raw bytes, base64.
 *     responses:
 *       200:
 *         description: Proved
 *       400:
 *         description: Missing or malformed fields
 *       401:
 *         description: No session, or the nonce is spent, expired or not yours
 *       403:
 *         description: The signature does not check against the key
 *       409:
 *         description: A different key is already registered for this device id
 */
export async function POST(request: NextRequest) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: { nonce?: unknown; signature?: unknown; publicKey?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const nonce = typeof body.nonce === 'string' ? body.nonce : '';
  const signature = typeof body.signature === 'string' ? body.signature : '';
  const publicKey = typeof body.publicKey === 'string' ? body.publicKey : '';
  if (!nonce || !signature || !publicKey) {
    return NextResponse.json(
      { error: 'nonce, signature and publicKey are all required' },
      { status: 400 },
    );
  }

  /*
   * Spend the nonce BEFORE checking anything else.
   *
   * A wrong signature must consume the challenge too, or the endpoint becomes an
   * oracle: keep the nonce, keep guessing. Ed25519 is not brute-forceable, but
   * the property to hold is "one nonce, one answer", and holding it here means
   * no later change can quietly lose it.
   */
  const issuedTo = await spendNonce(nonce);
  if (!issuedTo || issuedTo !== session.userId) {
    logger.warn(ROUTE, 'Nonce is spent, expired, or belongs to another account', {
      userId: session.userId,
    });
    return NextResponse.json({ error: 'Challenge is no longer valid' }, { status: 401 });
  }

  if (!verifyDeviceSignature(publicKey, nonce, signature)) {
    logger.warn(ROUTE, 'Signature did not verify', { userId: session.userId });
    return NextResponse.json({ error: 'Signature did not verify' }, { status: 403 });
  }

  const device = deviceFromRequest(request);
  const existing = await db.query.deviceSigningKeys.findFirst({
    where: and(
      eq(deviceSigningKeys.userId, session.userId),
      eq(deviceSigningKeys.deviceId, device.id),
    ),
  });

  if (!existing) {
    await db.insert(deviceSigningKeys).values({
      userId: session.userId,
      deviceId: device.id,
      publicKey,
      lastProvedAt: new Date(),
    });
    logger.info(ROUTE, 'Registered a device key', {
      userId: session.userId,
      deviceId: device.id,
    });
    return NextResponse.json({ status: 'registered' });
  }

  if (!samePublicKey(existing.publicKey, publicKey)) {
    /*
     * Same id, different key.
     *
     * Not an attack in the ordinary case — it is a reinstall whose private half
     * went with the old install, presenting a fresh one under the id it happens
     * to still have. Accepting it would let the account keep collecting
     * identities, which is exactly the failure this table exists to end.
     *
     * Refusing does not lock anyone out: signing in again mints a session, and
     * the phone registers under whatever id that flow gives it.
     */
    logger.warn(ROUTE, 'Device id already holds a different key', {
      userId: session.userId,
      deviceId: device.id,
    });
    return NextResponse.json(
      {
        error: 'This device already has a different key registered.',
        code: 'DEVICE_KEY_MISMATCH',
      },
      { status: 409 },
    );
  }

  await db
    .update(deviceSigningKeys)
    .set({ lastProvedAt: new Date() })
    .where(eq(deviceSigningKeys.id, existing.id));

  return NextResponse.json({ status: 'proved' });
}
