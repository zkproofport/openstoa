/**
 * Proving an install is the same one as last time.
 *
 * The server sends a nonce; the device signs it with the Ed25519 private key it
 * generated on first run and has never sent anywhere. Either the signature
 * checks against the registered public key or it does not.
 *
 * WHAT THIS REPLACES. `deviceId` is a random string the client makes up and puts
 * in a header. The server stored it and believed it, because it had nothing
 * else. That failed in both directions: lose the string and the phone becomes a
 * stranger to itself (staging: 48 distinct ids for one phone, each leaving the
 * epochs before it unreadable), and learn the string and anyone can claim to be
 * that device from anywhere.
 *
 * WHAT IT DOES NOT DO. The private key sits in `expo-secure-store`, beside the
 * MLS keys and the master_key, so an attacker who can dump that store can copy
 * it. Deliberate: MLS uses X25519/Ed25519 and the Secure Enclave holds only
 * P-256, so the chat keys stay in that store regardless — moving only this key
 * would harden the one thing such an attacker has no reason to steal. The
 * guarantee is precise: REMOTE forgery is closed, a dumped device is not.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { verify as edVerify } from 'node:crypto';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';

const MODULE = 'deviceProof';

/**
 * How long a nonce stays answerable.
 *
 * Short, because the only legitimate delay is one round trip. A long window is a
 * captured signature that keeps working, and the whole point is that possession
 * is proved NOW rather than once, long ago.
 */
export const NONCE_TTL_SECONDS = 120;

const nonceKey = (n: string) => `deviceproof:nonce:${n}`;

/** Mint a challenge and remember it, so it can be spent exactly once. */
export async function issueNonce(userId: string): Promise<string> {
  const nonce = randomBytes(32).toString('base64');
  const redis = getRedis();
  await redis.set(nonceKey(nonce), userId, 'EX', NONCE_TTL_SECONDS);
  return nonce;
}

/**
 * Spend a nonce. Returns the account it was issued to, or null.
 *
 * DELETE-THEN-CHECK, not check-then-delete: two requests arriving together must
 * not both find it present. Redis `del` reports how many keys it removed, so the
 * caller that got the 1 is the only one holding a valid challenge.
 */
export async function spendNonce(nonce: string): Promise<string | null> {
  const redis = getRedis();
  const key = nonceKey(nonce);
  const userId = await redis.get(key);
  if (!userId) return null;
  const removed = await redis.del(key);
  return removed === 1 ? userId : null;
}

/**
 * Check a signature over a nonce.
 *
 * Both inputs are decoded from base64 into raw bytes before verifying. Signing
 * the base64 TEXT on one side and the bytes on the other produces a signature
 * that verifies nowhere, and the failure looks exactly like a wrong key — an
 * hour of debugging that a sentence here prevents.
 */
export function verifyDeviceSignature(
  publicKeyB64: string,
  nonceB64: string,
  signatureB64: string,
): boolean {
  try {
    const raw = Buffer.from(publicKeyB64, 'base64');
    /*
     * The length check is BELT AND BRACES, and that is deliberate.
     *
     * Removing it changes no outcome — a wrong-sized key makes `verify` throw
     * "Failed to read asymmetric key", which the catch below turns into `false`.
     * Measured, because a mutation that removes it leaves the guards green and
     * the honest reading of that is "this line is not load-bearing", not "the
     * tests are weak".
     *
     * It stays for two reasons. Stating the shape is clearer than deducing it
     * from an exception, and the throw path writes a WARNING — so without this,
     * ordinary malformed input would file itself alongside the failures that
     * actually mean something.
     */
    if (raw.length !== 32) return false;
    /*
     * Ed25519 SPKI wrapper. Node's `verify` wants a KeyObject or a DER/PEM
     * encoding, and what the device sends is the bare 32-byte point — so the
     * fixed 12-byte prefix that names the algorithm goes in front of it.
     */
    const spki = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      raw,
    ]);
    return edVerify(
      null,
      Buffer.from(nonceB64, 'base64'),
      { key: spki, format: 'der', type: 'spki' },
      Buffer.from(signatureB64, 'base64'),
    );
  } catch (e) {
    logger.warn(MODULE, 'signature check threw', {
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/** Compare two public keys without leaking where they diverge. */
export function samePublicKey(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}
