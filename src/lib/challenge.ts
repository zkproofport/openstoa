import crypto from 'crypto';
import { redis } from './redis';
import { COMMUNITY_SCOPE } from './proof';

const CHALLENGE_TTL = 300; // 5 minutes

export async function createChallenge(): Promise<{
  challengeId: string;
  scope: string;
  expiresIn: number;
}> {
  const challengeId = crypto.randomUUID();
  await redis.set(`community:challenge:${challengeId}`, '1', 'EX', CHALLENGE_TTL);
  return { challengeId, scope: COMMUNITY_SCOPE, expiresIn: CHALLENGE_TTL };
}

export async function consumeChallenge(challengeId: string): Promise<boolean> {
  const result = await redis.eval(
    "local v = redis.call('get', KEYS[1]); if v then redis.call('del', KEYS[1]); end; return v;",
    1,
    `community:challenge:${challengeId}`,
  );
  return result !== null;
}
