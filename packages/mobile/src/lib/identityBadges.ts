import type { PublicBadge } from '@openstoa/api-types';
import type { QueryClient } from '@tanstack/react-query';

export const identityBadgesKey = (userId: string) => ['identity-badges', userId] as const;
const IDENTITY_QUERY_ROOTS = new Set(['session', 'feed', 'my', 'topic', 'post', 'post-records', 'dm-list', 'dm-candidates', 'chat-history']);

/** Patch batched identity payloads in place in the query cache after a confirmed
 * preference change. Owner verification controls are deliberately excluded. */
export function updateIdentityBadgeCaches(queryClient: QueryClient, userId: string, badges: PublicBadge[]) {
  queryClient.setQueryData(identityBadgesKey(userId), badges);
  queryClient.setQueriesData({ predicate: query => IDENTITY_QUERY_ROOTS.has(String(query.queryKey[0])) }, data => patch(data));
  function patch(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(patch);
    if (!value || typeof value !== 'object') return value;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    const record = value as Record<string, unknown>;
    const next = Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, patch(entry)]));
    if (record.authorId === userId || (record.userId === userId && typeof record.nickname === 'string')) next.badges = badges;
    if (record.recorderId === userId) next.recorderBadges = badges;
    return next;
  }
}
