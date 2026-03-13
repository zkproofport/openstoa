import { db } from '@/lib/db';
import { posts, records, recordLimits } from '@/lib/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { keccak256, toUtf8Bytes } from 'ethers';

interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
}

const DAILY_RECORD_LIMIT = 3;
const MIN_POST_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Check if a user can record a post on-chain
 */
export async function checkRecordPolicy(
  postId: string,
  recorderNullifier: string,
): Promise<PolicyCheckResult> {
  // 1. Fetch the post
  const post = await db
    .select()
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);

  if (post.length === 0) {
    return { allowed: false, reason: 'Post not found' };
  }

  const thePost = post[0];

  // 2. Check: not own post
  if (thePost.authorId === recorderNullifier) {
    return { allowed: false, reason: 'Cannot record your own post' };
  }

  // 3. Check: minimum age (1 hour since creation)
  const postAge = Date.now() - new Date(thePost.createdAt!).getTime();
  if (postAge < MIN_POST_AGE_MS) {
    const remainingMinutes = Math.ceil((MIN_POST_AGE_MS - postAge) / 60000);
    return { allowed: false, reason: `Post must be at least 1 hour old. ${remainingMinutes} minutes remaining.` };
  }

  // 4. Check: not already recorded by this user
  const existing = await db
    .select({ id: records.id })
    .from(records)
    .where(
      and(
        eq(records.postId, postId),
        eq(records.recorderNullifier, recorderNullifier),
      )
    )
    .limit(1);

  if (existing.length > 0) {
    return { allowed: false, reason: 'You have already recorded this post' };
  }

  // 5. Check: daily limit
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const limitRow = await db
    .select()
    .from(recordLimits)
    .where(
      and(
        eq(recordLimits.userId, recorderNullifier),
        eq(recordLimits.date, today),
      )
    )
    .limit(1);

  const todayCount = limitRow.length > 0 ? limitRow[0].count : 0;
  if (todayCount >= DAILY_RECORD_LIMIT) {
    return { allowed: false, reason: `Daily record limit reached (${DAILY_RECORD_LIMIT}/day)` };
  }

  return { allowed: true };
}

/**
 * Compute the content hash for a post
 */
export function computeContentHash(content: string): string {
  return keccak256(toUtf8Bytes(content));
}

/**
 * Increment the daily record count for a user
 */
export async function incrementDailyCount(userId: string): Promise<void> {
  const today = new Date().toISOString().split('T')[0];

  await db
    .insert(recordLimits)
    .values({ userId, date: today, count: 1 })
    .onConflictDoUpdate({
      target: [recordLimits.userId, recordLimits.date],
      set: { count: sql`${recordLimits.count} + 1` },
    });
}

/**
 * Check if the current content hash matches a stored record's hash
 */
export function isContentHashMatch(currentContent: string, storedHash: string): boolean {
  return computeContentHash(currentContent) === storedHash;
}
