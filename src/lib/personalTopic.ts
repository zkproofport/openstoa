import crypto from 'crypto';
import { db } from '@/lib/db';
import { topics, topicMembers } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * The space an account gets for itself, made when the account is.
 *
 * WHAT IT IS: an ordinary secret topic with exactly one member. It sits in the
 * owner's topic list and its chat room sits in their chat list — both read the
 * same `/api/topics` — and posts, comments and E2EE chat all work because
 * nothing downstream treats it as a special case. That is the reason it is a
 * topic at all rather than a separate feature with its own storage, its own
 * screens and its own bugs.
 *
 * WHAT IS DIFFERENT: nobody else can ever be in it. Every door is refused —
 * invite creation, joining by code, joining directly, asking to join. The
 * refusals are at the routes, not in the UI: a client that forgets to hide a
 * button must not be able to open someone's private space to a stranger.
 *
 * MADE AT ACCOUNT CREATION, not on first visit. Someone who signs in and finds
 * it already there reads it as part of the account; someone who has to find a
 * "create" button reads it as a feature to set up, and most never will.
 *
 * THE TITLE IS SHARED BY EVERY ACCOUNT and that is safe: there is no uniqueness
 * constraint on topic titles, and a secret topic never appears in anyone else's
 * list or search, so two people's spaces are never on screen together.
 */

/** The name a fresh personal topic carries. */
export const PERSONAL_TOPIC_TITLE = 'My space';

/**
 * Create this account's personal topic, or return the one it already has.
 *
 * IDEMPOTENT, and it must be: every path that can create an account calls it,
 * and two sign-ins arriving together is ordinary. The unique index on
 * `(creator_id) where personal` is what actually enforces one per account; the
 * race handling here is how that enforcement reaches the caller as an id rather
 * than an exception.
 *
 * Returns null when the row could not be made. The caller is signing someone
 * in, and a missing personal space must never cost them that — it will be made
 * on their next sign-in.
 */
export async function ensurePersonalTopic(userId: string): Promise<string | null> {
  try {
    const existing = await db.query.topics.findFirst({
      where: and(eq(topics.creatorId, userId), eq(topics.personal, true)),
      columns: { id: true },
    });
    if (existing) return existing.id;

    /*
     * An invite code is stored even though no invite can ever be made from it.
     * The column is NOT NULL and unique, and a sentinel like '' would collide
     * with the second personal topic ever created. A random string nothing
     * reads is cheaper than making every other topic care about a nullable
     * column.
     */
    const [row] = await db
      .insert(topics)
      .values({
        title: PERSONAL_TOPIC_TITLE,
        description: null,
        creatorId: userId,
        inviteCode: crypto.randomBytes(8).toString('hex'),
        visibility: 'secret',
        kind: 'topic',
        personal: true,
      })
      .returning({ id: topics.id });

    await db.insert(topicMembers).values({ topicId: row.id, userId, role: 'owner' });
    return row.id;
  } catch {
    /*
     * Losing the race is the expected way to arrive here: another sign-in made
     * the row a moment ago, so the answer is that row rather than an error.
     * Re-read instead of inspecting the exception — the same catch also covers
     * a database that was briefly unreachable, and there the honest answer is
     * null.
     */
    const raced = await db.query.topics
      .findFirst({
        where: and(eq(topics.creatorId, userId), eq(topics.personal, true)),
        columns: { id: true },
      })
      .catch(() => null);
    return raced?.id ?? null;
  }
}

/** The message every refused door gives. One wording, so they cannot drift. */
export const PERSONAL_TOPIC_CLOSED = 'This space is yours alone — it cannot be shared.';
