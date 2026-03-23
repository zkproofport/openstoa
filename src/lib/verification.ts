import { db } from './db';
import { userVerifications } from './db/schema';
import { eq, and } from 'drizzle-orm';

const VERIFICATION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function saveVerification(
  userId: string,
  proofType: string,
  options?: { domain?: string; country?: string; proof?: string; publicInputs?: string },
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + VERIFICATION_DURATION_MS);

  await db
    .insert(userVerifications)
    .values({
      userId,
      proofType,
      domain: options?.domain ?? null,
      country: options?.country ?? null,
      verifiedAt: now,
      expiresAt,
      proof: options?.proof ?? null,
      publicInputs: options?.publicInputs ?? null,
    })
    .onConflictDoUpdate({
      target: [userVerifications.userId, userVerifications.proofType],
      set: {
        domain: options?.domain ?? null,
        country: options?.country ?? null,
        verifiedAt: now,
        expiresAt,
        proof: options?.proof ?? null,
        publicInputs: options?.publicInputs ?? null,
      },
    });
}

export async function getActiveVerifications(userId: string) {
  const now = new Date();
  const verifications = await db.query.userVerifications.findMany({
    where: eq(userVerifications.userId, userId),
  });
  return verifications.filter(v => v.expiresAt > now);
}

export async function hasValidVerification(
  userId: string,
  proofType: string,
  requiredDomain?: string,
): Promise<boolean> {
  const now = new Date();
  const verification = await db.query.userVerifications.findFirst({
    where: and(
      eq(userVerifications.userId, userId),
      eq(userVerifications.proofType, proofType),
    ),
  });
  if (!verification || verification.expiresAt <= now) return false;
  if (requiredDomain && verification.domain !== requiredDomain) return false;
  return true;
}
