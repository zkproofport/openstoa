import crypto from 'crypto';
import { redis } from './redis';
import { COMMUNITY_SCOPE } from './proof';

const CHALLENGE_TTL = 300; // 5 minutes
const PAYMENT_TX_TTL = 86400; // 24 hours — prevent replay within this window

export async function createChallenge(): Promise<{
  challengeId: string;
  scope: string;
  expiresIn: number;
}> {
  const challengeId = crypto.randomUUID();
  const createdAt = Math.floor(Date.now() / 1000);
  await redis.set(`community:challenge:${challengeId}`, String(createdAt), 'EX', CHALLENGE_TTL);
  return { challengeId, scope: COMMUNITY_SCOPE, expiresIn: CHALLENGE_TTL };
}

/**
 * Consume a challenge and return its creation timestamp (unix seconds).
 * Returns null if the challenge does not exist or was already consumed.
 */
export async function consumeChallenge(challengeId: string): Promise<number | null> {
  const result = await redis.eval(
    "local v = redis.call('get', KEYS[1]); if v then redis.call('del', KEYS[1]); end; return v;",
    1,
    `community:challenge:${challengeId}`,
  );
  return result !== null ? Number(result) : null;
}

/**
 * Check if a paymentTxHash has already been used. If not, mark it as used.
 * Returns true if the TX is new (not yet used), false if already used.
 */
export async function markPaymentTxUsed(paymentTxHash: string): Promise<boolean> {
  const key = `community:payment-tx:${paymentTxHash}`;
  // SET NX returns 'OK' if set, null if key already exists
  const result = await redis.set(key, '1', 'EX', PAYMENT_TX_TTL, 'NX');
  return result === 'OK';
}
