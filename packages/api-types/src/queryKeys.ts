/**
 * The cache keys both clients use, so the same resource is the same entry.
 *
 * WHY THIS IS SHARED. The mini-app has used TanStack Query from the start; the
 * web had no query layer at all and grew seventeen hand-rolled fetches of
 * `/api/auth/session` and two components fetching one topic side by side. The
 * fix for the web was to adopt what the mini-app already standardised on — and
 * adopting the library without adopting the keys would have left two clients
 * naming the same resource differently, which is the same divergence one layer
 * up.
 *
 * A KEY IS PART OF THE API CONTRACT, which is why it lives beside the response
 * types rather than in either client. `['topic', id]` is a claim about what the
 * server considers one resource; if that claim differs between the web and the
 * mini-app, an invalidation written for one silently misses the other.
 *
 * These are FUNCTIONS, not constants, so a caller cannot assemble a key by hand
 * and get the order or the arity subtly wrong — the one failure mode that costs
 * an invalidation and shows up as stale data much later.
 */

/** Everything under one topic — the detail, its posts, its members. */
export const topicKeys = {
  /**
   * Every topic entry — the prefix an invalidation uses to say "all of them".
   *
   * Prefixes are keys too, and they are the easiest to get subtly wrong by
   * hand: `['topic']` invalidates every topic and every list hanging off one,
   * while `['topics']` invalidates nothing at all and looks identical in a
   * review.
   */
  all: () => ['topic'] as const,
  /** The topic itself: `/api/topics/{id}`. */
  detail: (topicId: string) => ['topic', topicId] as const,
  /** Its members: `/api/topics/{id}/members`. */
  members: (topicId: string) => ['topic', topicId, 'members'] as const,
  /**
   * A page of its posts. The sort and filters are part of the key because they
   * are part of the request — two different sorts are two different lists, and
   * sharing one entry between them shows the reader the wrong order.
   */
  posts: (topicId: string, sort: string, tag: string | null, q: string | null) =>
    ['topic', topicId, 'posts', sort, tag, q] as const,
  /** Every page of this topic's posts, whatever the sort — an invalidation prefix. */
  postsAll: (topicId: string) => ['topic', topicId, 'posts'] as const,
  /** Pending join requests: `/api/topics/{id}/requests`. */
  requests: (topicId: string) => ['topic', topicId, 'requests'] as const,
  /** Chat history for the room: `/api/topics/{id}/chat`. */
  chat: (topicId: string) => ['chat-history', topicId] as const,
  /**
   * Every room's chat history — an invalidation prefix.
   *
   * Written here rather than by hand at the call site for the reason at the
   * top of this file: `['chat-history']` is a prefix of every room's key and
   * `['chat']` is a prefix of nothing, and the two are one character apart.
   *
   * The caller that needs it is RECOVERY. Restoring the keychain does not tell
   * an open room anything — measured on a phone on 2026-08-27, a room left
   * open through a recovery still read `키를 기다리는 중…` two and a half
   * minutes later, and only opened when the person left and came back. Nobody
   * would guess to do that; they would conclude the recovery failed.
   */
  chatAll: () => ['chat-history'] as const,
} as const;

/** The signed-in account: `/api/auth/session`. */
export const sessionKeys = {
  current: () => ['session'] as const,
} as const;

/** Lists that are not scoped to one topic. */
export const listKeys = {
  /** `/api/categories` — small, static, and read by three screens. */
  categories: () => ['categories'] as const,
  /** `/api/tags`, optionally scoped to a topic and a search term. */
  tags: (topicId?: string | null, q?: string | null) =>
    ['tags', topicId ?? null, q ?? null] as const,
  /** A topic list, keyed by the view it is asking for. */
  topics: (view: string, sort: string, limit: number) =>
    ['topics', view, sort, limit] as const,
} as const;

/** One post and what hangs off it. */
export const postKeys = {
  detail: (postId: string) => ['post', postId] as const,
  reactions: (postId: string) => ['post', postId, 'reactions'] as const,
  bookmark: (postId: string) => ['bookmark', postId] as const,
  records: (postId: string) => ['post', postId, 'records'] as const,
} as const;
