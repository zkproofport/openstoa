import { db } from './db';
import { postTags, tags } from './db/schema';
import { eq, inArray } from 'drizzle-orm';

/**
 * Batch-load tag rows for a set of posts and attach them as `.tags`.
 * Mirrors the per-post tag block on the detail endpoint so list endpoints
 * (feed / my-posts / my-recorded / bookmarks / topic posts) can render
 * the same PostCard chip row without an extra round-trip per card.
 *
 * Posts already carrying a `tags` array (e.g. the detail endpoint which
 * fetches them itself) are left untouched so this helper is safe to call
 * from any layer.
 */
export async function attachTagsToPosts<
  T extends { id: string; tags?: { name: string; slug: string }[] },
>(postsList: T[]): Promise<void> {
  if (postsList.length === 0) return;
  const postIds = postsList.map((p) => p.id);

  const rows = await db
    .select({ postId: postTags.postId, name: tags.name, slug: tags.slug })
    .from(postTags)
    .innerJoin(tags, eq(postTags.tagId, tags.id))
    .where(inArray(postTags.postId, postIds));

  const tagMap = new Map<string, { name: string; slug: string }[]>();
  for (const row of rows) {
    const existing = tagMap.get(row.postId) ?? [];
    existing.push({ name: row.name, slug: row.slug });
    tagMap.set(row.postId, existing);
  }
  for (const post of postsList) {
    if (post.tags === undefined) {
      post.tags = tagMap.get(post.id) ?? [];
    }
  }
}
