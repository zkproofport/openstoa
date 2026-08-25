import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { defaultNickname } from '@/lib/defaultNickname';
import { ensurePersonalTopic } from '@/lib/personalTopic';

/**
 * The account behind a nullifier, created with a default name if it is new.
 *
 * Both sign-in paths — the mobile proof poll and the AI verifier — need exactly
 * this, and both used to inline it.
 *
 * There is no retry over the NAME: it is derived from the nullifier, so it is
 * unique for the same reason the nullifier is. An earlier version assembled
 * names from word lists and needed a retry ladder, which turned out to be worse
 * than it looked — the candidates were deterministic, so an account whose
 * candidates were all taken would have failed to sign in and failed again on
 * every retry, forever.
 */
export async function ensureUser(nullifier: string): Promise<{ nickname: string; created: boolean }> {
  const existing = await db.query.users.findFirst({ where: eq(users.id, nullifier) });
  if (existing) return { nickname: existing.nickname, created: false };

  const nickname = defaultNickname(nullifier);
  try {
    await db.insert(users).values({ id: nullifier, nickname });
    /*
     * The account's own space, made with the account.
     *
     * Here rather than at first visit so the person finds it already there —
     * a space you have to go and create reads as a feature to set up, and
     * most never do. Unawaited failure is deliberate: `ensurePersonalTopic`
     * answers null rather than throwing, and a sign-in must not fail because
     * a topic row did not insert. The next sign-in makes it.
     */
    await ensurePersonalTopic(nullifier);
    return { nickname, created: true };
  } catch (err) {
    // Two sign-ins for the same account raced. `id` is the primary key, so the
    // row that won is THIS account, and the name it already carries is the
    // right answer — a sign-in must not fail because it arrived second.
    const raced = await db.query.users.findFirst({ where: eq(users.id, nullifier) });
    if (raced) return { nickname: raced.nickname, created: false };
    throw err;
  }
}
