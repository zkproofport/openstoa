import { db } from '@/lib/db';
import { topicMembers, topics } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';

/**
 * May this caller ACT on this post?
 *
 * THE RULE, which already existed and was written down in three places: a
 * `public` or `private` topic is readable by any signed-in user, and a `secret`
 * one is members-only. Acting on a post — reacting, voting, bookmarking,
 * recording — should require no less than being able to read it.
 *
 * WHY THIS FILE. It did not require that. `comments` checked membership;
 * `reactions`, `vote`, `bookmark` and `record` checked nothing at all, so a
 * signed-in stranger holding a post id could react to and upvote a post inside
 * somebody's private topic. Probed on a real container: reaction
 * `{"added":true}`, vote `{"upvoteCount":1}`, bookmark `{"bookmarked":true}` —
 * all 200, all from an account with no membership anywhere near that topic.
 *
 * The mark lands where the owner sees it, and the vote moves the post's score.
 *
 * It predates personal spaces and applies to every private and secret topic.
 * What changed is the reach: every account now has private content by default,
 * so "some users have posts a stranger could touch" became "all of them do".
 *
 * ONE implementation rather than a fifth copy of the condition — four routes
 * disagreeing about the same question is how this happened.
 */
export async function canActOnPost(
  topicId: string,
  userId: string,
): Promise<boolean> {
  const topic = await db.query.topics.findFirst({
    where: eq(topics.id, topicId),
    columns: { visibility: true },
  });
  if (!topic) return false;
  // Unrecognised visibility is treated as the STRICTEST case, so a new tier
  // added later is closed until someone decides it should be open.
  if (topic.visibility === 'public' || topic.visibility === 'private') return true;

  const membership = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, userId)),
    columns: { userId: true },
  });
  return !!membership;
}

/** The one wording every refusal uses, so they cannot drift apart. */
export const NOT_A_MEMBER = 'Not a member of this topic';
