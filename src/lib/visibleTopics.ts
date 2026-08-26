import { db } from '@/lib/db';
import { topics, topicMembers } from '@/lib/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * The topics a caller is allowed to see content from.
 *
 * Public and not blinded, plus — when there is a session — every topic the
 * caller is a member of. A guest gets the public half only.
 *
 * This used to live inside the feed route as two private helpers. `/api/tags`
 * had no equivalent and asked the `tags` table directly, so a tag written only
 * inside someone's private space was returned to any caller — including a
 * logged-out one — and `?topicId=<their topic>` listed that topic's whole tag
 * vocabulary with no membership check at all. Tags are free text a person
 * writes, so the tag name IS content.
 *
 * One rule, one implementation: a surface that shows posts, or anything
 * derived from posts, resolves its topic set here.
 */
export async function resolveVisibleTopicIds(
  userId: string | null,
  categoryTopicIds: string[] | null,
): Promise<string[]> {
  if (categoryTopicIds !== null && categoryTopicIds.length === 0) return [];

  const publicRows = await db
    .select({ id: topics.id })
    .from(topics)
    .where(and(eq(topics.visibility, 'public'), isNull(topics.blindedAt)));
  const ids = new Set(publicRows.map((r) => r.id));

  if (userId) {
    const memberships = await db
      .select({ topicId: topicMembers.topicId })
      .from(topicMembers)
      .innerJoin(topics, eq(topicMembers.topicId, topics.id))
      .where(and(eq(topicMembers.userId, userId), isNull(topics.blindedAt)));
    for (const m of memberships) ids.add(m.topicId);
  }

  const all = [...ids];
  if (categoryTopicIds === null) return all;
  const wanted = new Set(categoryTopicIds);
  return all.filter((id) => wanted.has(id));
}

/** Whether this caller may see content from one specific topic. */
export async function canSeeTopic(userId: string | null, topicId: string): Promise<boolean> {
  const topic = await db.query.topics.findFirst({
    where: eq(topics.id, topicId),
    columns: { visibility: true, blindedAt: true },
  });
  if (!topic || topic.blindedAt) return false;
  if (topic.visibility === 'public') return true;
  if (!userId) return false;
  const membership = await db.query.topicMembers.findFirst({
    where: and(eq(topicMembers.topicId, topicId), eq(topicMembers.userId, userId)),
    columns: { userId: true },
  });
  return !!membership;
}

/** Narrow a caller-supplied topic id list to the ones they may see. */
export async function filterVisibleTopicIds(
  userId: string | null,
  topicIds: string[],
): Promise<string[]> {
  if (topicIds.length === 0) return [];
  const visible = await resolveVisibleTopicIds(userId, null);
  const set = new Set(visible);
  return topicIds.filter((id) => set.has(id));
}
