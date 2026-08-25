/**
 * Asking another member to unlock the stretch of history you cannot read.
 *
 * WHY THIS EXISTS. After a recovery on a new phone, `public` rooms come back in
 * full — the server holds the archive root. `private`, `secret` and `dm` do
 * not: they open only as far as the OLD phone's last backup, because epochs
 * that advanced while that phone was off never reached its keychain and so were
 * never in the blob. No amount of backing up fixes that; you cannot upload a
 * key you never received.
 *
 * The keys still exist — on the devices of members who were online. So the
 * missing step is not cryptography, it is ASKING, and the ask has to outlive
 * the moment: the person who can grant is usually not looking at their phone.
 *
 * WHAT THE SERVER LEARNS. That a device would like keys for a topic. It never
 * sees the keys: a grant travels as an HPKE-sealed `tak_bundles` row addressed
 * to the requester's leaf, exactly like every other key delivery here.
 *
 * SECRET TOPICS ARE THE POINT, not an exception. `grantPrivateHistory` does not
 * auto-grant for them by design — the owner decides, per person. This gives
 * that decision somewhere to arrive.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { keyRequests } from '@/lib/db/schema';
import type { db as Database } from '@/lib/db';

/** The drizzle handle, or a transaction with the same surface. */
type DB = typeof Database;

export interface KeyRequest {
  id: string;
  topicId: string;
  requesterUserId: string;
  requesterDeviceId: string;
  haveFromEpoch: number | null;
  grantedAt: Date | null;
  grantedByUserId: string | null;
  createdAt: Date | null;
}

/**
 * Record the ask, or refresh the one already there.
 *
 * RE-ASKING IS NOT A NEW REQUEST. A screen that retries on every mount would
 * otherwise turn one person's tap into a queue nobody reads to the end, and the
 * second row would tell a granting member nothing the first did not. The unique
 * index makes that structural rather than a thing each caller remembers.
 *
 * Re-asking DOES clear a previous grant, because that is what it means: the
 * device still cannot read, so whatever was granted did not cover it.
 */
export async function requestKeys(
  db: DB,
  input: {
    topicId: string;
    requesterUserId: string;
    requesterDeviceId: string;
    haveFromEpoch: number | null;
  },
): Promise<void> {
  await db
    .insert(keyRequests)
    .values({
      topicId: input.topicId,
      requesterUserId: input.requesterUserId,
      requesterDeviceId: input.requesterDeviceId,
      haveFromEpoch: input.haveFromEpoch,
    })
    .onConflictDoUpdate({
      target: [keyRequests.topicId, keyRequests.requesterDeviceId],
      set: {
        haveFromEpoch: input.haveFromEpoch,
        requesterUserId: input.requesterUserId,
        grantedAt: null,
        grantedByUserId: null,
        createdAt: sql`now()`,
      },
    });
}

/**
 * The requests a member could answer — open ones only.
 *
 * Newest first: a member who has been away opens this to a list, and the room
 * someone is waiting on right now matters more than one from last month.
 */
export async function openRequests(db: DB, topicId: string): Promise<KeyRequest[]> {
  const rows = await db
    .select()
    .from(keyRequests)
    .where(and(eq(keyRequests.topicId, topicId), isNull(keyRequests.grantedAt)))
    .orderBy(desc(keyRequests.createdAt));
  return rows as KeyRequest[];
}

/** This device's own request for a topic, granted or not. Null when never asked. */
export async function myRequest(
  db: DB,
  topicId: string,
  requesterDeviceId: string,
): Promise<KeyRequest | null> {
  const rows = await db
    .select()
    .from(keyRequests)
    .where(
      and(
        eq(keyRequests.topicId, topicId),
        eq(keyRequests.requesterDeviceId, requesterDeviceId),
      ),
    )
    .limit(1);
  return (rows[0] as KeyRequest) ?? null;
}

/**
 * Mark one answered.
 *
 * Called AFTER the granting client has posted the sealed bundle, never before:
 * a request marked granted with no bundle behind it is worse than an open one,
 * because the asker stops asking and nothing arrives.
 *
 * Returns false when the request was already answered or does not exist, so two
 * members tapping at the same time produce one grant and one no-op rather than
 * a double send.
 */
export async function markGranted(
  db: DB,
  requestId: string,
  grantedByUserId: string,
): Promise<boolean> {
  const rows = await db
    .update(keyRequests)
    .set({ grantedAt: new Date(), grantedByUserId })
    .where(and(eq(keyRequests.id, requestId), isNull(keyRequests.grantedAt)))
    .returning({ id: keyRequests.id });
  return rows.length > 0;
}

/** Drop every request for a topic. Used when the topic itself is deleted. */
export async function deleteRequestsForTopic(db: DB, topicId: string): Promise<void> {
  await db.delete(keyRequests).where(eq(keyRequests.topicId, topicId));
}
