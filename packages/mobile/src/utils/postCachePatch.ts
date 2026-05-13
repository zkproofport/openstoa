import type { QueryClient } from '@tanstack/react-query';

// A post-shaped object as it appears in cached query data. We intentionally
// keep the field set permissive so the same patcher works for the
// trimmed shape used by some list endpoints, the full detail shape, and
// any future fields callers want to update.
export interface CachedPost {
  id: string;
  [key: string]: unknown;
}

type CachedListShape =
  | { posts?: CachedPost[] }
  | { pages?: { posts?: CachedPost[] }[] }
  | CachedPost[];

// All known list-style cache keys that may contain Post objects. Adding
// a new list screen? Add its query key prefix here and patches propagate
// automatically. React Query's `setQueriesData` does prefix matching, so
// e.g. `['topic']` covers `['topic', '<id>', 'posts', sort, tag]`.
const LIST_KEY_PREFIXES: readonly (readonly string[])[] = [
  ['feed'],
  ['topic'],          // covers ['topic', topicId, 'posts', sort, tag]
  ['my', 'posts'],
  ['my', 'likes'],
  ['my', 'bookmarks'],
  ['my', 'recorded'],
] as const;

/**
 * Apply `patcher` to a single post (matched by id) across every cached
 * list and the post-detail cache. Idempotent and side-effect free apart
 * from the cache writes. Returns nothing — callers don't need to thread
 * results back through.
 *
 * Use this from any handler that mutates a post (vote, bookmark,
 * reaction, record, …) so list views and detail views stay in lockstep
 * without an extra refetch round-trip and without a per-screen
 * setQueriesData call.
 */
export function patchPostInAllCaches(
  queryClient: QueryClient,
  postId: string,
  patcher: (p: CachedPost) => CachedPost,
): void {
  const apply = (p: CachedPost): CachedPost => (p.id === postId ? patcher(p) : p);

  for (const prefix of LIST_KEY_PREFIXES) {
    queryClient.setQueriesData<CachedListShape>(
      { queryKey: prefix as unknown as readonly unknown[] },
      (old) => {
        if (!old) return old;
        if (Array.isArray(old)) return old.map(apply);
        if ('posts' in old && Array.isArray(old.posts)) {
          return { ...old, posts: old.posts.map(apply) };
        }
        if ('pages' in old && Array.isArray(old.pages)) {
          return {
            ...old,
            pages: old.pages.map((pg) => ({
              ...pg,
              posts: pg.posts?.map(apply) ?? [],
            })),
          };
        }
        return old;
      },
    );
  }

  // Post-detail cache lives at ['post', id] with the post stored directly.
  // Some screens wrap it as { post, comments }; handle both shapes.
  queryClient.setQueryData(['post', postId], (old: unknown) => {
    if (!old) return old;
    if (typeof old === 'object' && old !== null && 'id' in old) {
      return patcher(old as CachedPost);
    }
    if (
      typeof old === 'object' &&
      old !== null &&
      'post' in old &&
      (old as { post?: CachedPost }).post?.id === postId
    ) {
      const wrapper = old as { post: CachedPost; [k: string]: unknown };
      return { ...wrapper, post: patcher(wrapper.post) };
    }
    return old;
  });
}
