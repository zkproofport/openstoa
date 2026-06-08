import { useCallback } from 'react';
import { Alert } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useOpenStoaClient } from './useOpenStoaClient';
import { patchPostInAllCaches } from '../utils/postCachePatch';

export interface ReactionSummary {
  emoji: string;
  count: number;
  userReacted: boolean;
}

/**
 * Centralised set of post mutations: vote, bookmark, reaction, record,
 * comment. The contract:
 *
 *   • Every mutation reads current state from its argument (whatever the
 *     caller already derived from props / query cache) — these helpers
 *     hold ZERO local state of their own.
 *   • Every mutation writes the new value to the React Query cache via
 *     `patchPostInAllCaches`, which propagates to every cached list AND
 *     the post-detail screen in one shot. Add a new list screen? Just
 *     register its query key in utils/postCachePatch.ts.
 *   • On failure each mutation rolls the cache back to the pre-action
 *     value so the UI never gets stuck on an optimistic state.
 *
 * Use this from any component that lets the user mutate a post. Do not
 * spin up parallel useState + setQueriesData logic in screens.
 */
export function usePostMutations(postId: string) {
  const client = useOpenStoaClient();
  const queryClient = useQueryClient();

  const vote = useCallback(
    async (
      value: 1 | -1,
      current: { userVoted: 1 | -1 | null; upvoteCount: number },
    ) => {
      const prevVote = current.userVoted;
      const prevCount = current.upvoteCount;
      // Mirror the server's toggle math so the visual count moves
      // optimistically before the network round-trip.
      let nextVote: 1 | -1 | null;
      let delta: number;
      if (prevVote === value) {
        nextVote = null;
        delta = value === 1 ? -1 : 1;
      } else if (prevVote === null) {
        nextVote = value;
        delta = value === 1 ? 1 : -1;
      } else {
        nextVote = value;
        delta = value === 1 ? 2 : -2;
      }

      // Optimistic write to every cached list + the post detail.
      patchPostInAllCaches(queryClient, postId, (p) => ({
        ...p,
        userVoted: nextVote,
        upvoteCount: Math.max(
          0,
          (typeof p.upvoteCount === 'number' ? p.upvoteCount : prevCount) + delta,
        ),
      }));

      try {
        const res = await client.post<{
          vote: { value: number } | null;
          upvoteCount: number;
        }>(`/api/posts/${postId}/vote`, { value });
        const serverValue = (res.vote?.value ?? null) as 1 | -1 | null;
        // Replace optimistic with confirmed server state.
        patchPostInAllCaches(queryClient, postId, (p) => ({
          ...p,
          userVoted: serverValue,
          upvoteCount: res.upvoteCount,
        }));
      } catch (e) {
        // Roll cache back.
        patchPostInAllCaches(queryClient, postId, (p) => ({
          ...p,
          userVoted: prevVote,
          upvoteCount: prevCount,
        }));
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('403') || /not a member/i.test(msg)) {
          Alert.alert(
            'Join the topic first',
            'Only members of this topic can vote on its posts. Tap the topic name to open it and join.',
          );
        }
      }
    },
    [client, postId, queryClient],
  );

  const toggleBookmark = useCallback(
    async (currentBookmarked: boolean) => {
      const optimistic = !currentBookmarked;
      patchPostInAllCaches(queryClient, postId, (p) => ({
        ...p,
        userBookmarked: optimistic,
      }));
      try {
        // Server toggles on POST and returns the new state. Sending
        // DELETE here used to silently 405.
        const res = await client.post<{ bookmarked: boolean }>(
          `/api/posts/${postId}/bookmark`,
        );
        patchPostInAllCaches(queryClient, postId, (p) => ({
          ...p,
          userBookmarked: res.bookmarked,
        }));
        if (!res.bookmarked) {
          // Drop the now-unbookmarked entry from the dedicated list
          // (cache-patch only mutates rows it already knows about; the
          // bookmarks list needs an actual refetch to lose the row).
          void queryClient.invalidateQueries({ queryKey: ['my', 'bookmarks'] });
        }
      } catch {
        patchPostInAllCaches(queryClient, postId, (p) => ({
          ...p,
          userBookmarked: currentBookmarked,
        }));
      }
    },
    [client, postId, queryClient],
  );

  const toggleReaction = useCallback(
    async (emoji: string, currentReactions: ReactionSummary[]) => {
      const existing = currentReactions.find((r) => r.emoji === emoji);
      let next: ReactionSummary[];
      if (existing) {
        if (existing.userReacted) {
          const newCount = existing.count - 1;
          next = newCount <= 0
            ? currentReactions.filter((r) => r.emoji !== emoji)
            : currentReactions.map((r) =>
                r.emoji === emoji ? { ...r, count: newCount, userReacted: false } : r,
              );
        } else {
          next = currentReactions.map((r) =>
            r.emoji === emoji ? { ...r, count: r.count + 1, userReacted: true } : r,
          );
        }
      } else {
        next = [...currentReactions, { emoji, count: 1, userReacted: true }];
      }

      // Detail-screen authoritative cache.
      queryClient.setQueryData<{ reactions: ReactionSummary[] }>(
        ['reactions', postId],
        { reactions: next },
      );
      // Embedded in every list row.
      patchPostInAllCaches(queryClient, postId, (p) => ({
        ...p,
        reactions: next,
      }));

      try {
        await client.post(`/api/posts/${postId}/reactions`, { emoji });
      } catch {
        // Re-read the truth from the server so the cache stops lying.
        try {
          const res = await client.get<{ reactions: ReactionSummary[] }>(
            `/api/posts/${postId}/reactions`,
          );
          if (res.reactions) {
            queryClient.setQueryData(['reactions', postId], { reactions: res.reactions });
            patchPostInAllCaches(queryClient, postId, (p) => ({
              ...p,
              reactions: res.reactions,
            }));
          }
        } catch {
          // network/server unreachable — leave cache as-is, user can refresh.
        }
      }
    },
    [client, postId, queryClient],
  );

  const record = useCallback(
    async (current: { recorded: boolean; recordCount: number }) => {
      if (current.recorded) return;
      patchPostInAllCaches(queryClient, postId, (p) => ({
        ...p,
        userRecorded: true,
        recordCount:
          (typeof p.recordCount === 'number' ? p.recordCount : current.recordCount) + 1,
      }));
      try {
        const res = await client.post<{ record?: { recordCount?: number } }>(
          `/api/posts/${postId}/record`,
        );
        patchPostInAllCaches(queryClient, postId, (p) => ({
          ...p,
          userRecorded: true,
          recordCount: res?.record?.recordCount ?? current.recordCount + 1,
        }));
      } catch (e) {
        // Roll the optimistic patch back, then re-throw so the caller
        // can surface the real reason (policy rejection, daily limit
        // reached, 1-hour age gate, etc.). The previous silent-catch
        // here was the source of "tap, see 1, see 0 again" with no
        // user-visible explanation.
        patchPostInAllCaches(queryClient, postId, (p) => ({
          ...p,
          userRecorded: false,
          recordCount: current.recordCount,
        }));
        throw e;
      }
    },
    [client, postId, queryClient],
  );

  const addComment = useCallback(
    async (content: string): Promise<{ ok: boolean; reason?: 'not_member' | 'other'; message?: string }> => {
      try {
        await client.post(`/api/posts/${postId}/comments`, { content });
        // Bump the comment count everywhere the post is rendered.
        patchPostInAllCaches(queryClient, postId, (p) => ({
          ...p,
          commentCount:
            (typeof p.commentCount === 'number' ? p.commentCount : 0) + 1,
        }));
        // The actual comment list lives in the post detail payload, so
        // invalidate that one query (the list-row caches were just patched
        // for the count and don't carry the comment body).
        void queryClient.invalidateQueries({ queryKey: ['post', postId] });
        return { ok: true };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('403') || /not a member/i.test(msg)) {
          return { ok: false, reason: 'not_member', message: msg };
        }
        return { ok: false, reason: 'other', message: msg };
      }
    },
    [client, postId, queryClient],
  );

  const togglePin = useCallback(
    async (currentPinned: boolean): Promise<{ ok: boolean; message?: string }> => {
      const optimistic = !currentPinned;
      // Optimistically flip `isPinned` everywhere the post is rendered so
      // the pin indicator appears immediately. Server is the source of
      // truth — we reconcile on response or roll back on error.
      patchPostInAllCaches(queryClient, postId, (p) => ({
        ...p,
        isPinned: optimistic,
      }));
      try {
        // Server toggles on POST and returns `{ pinned: boolean }`
        // (see openstoa/src/app/api/posts/[postId]/pin/route.ts).
        const res = await client.post<{ pinned?: boolean }>(
          `/api/posts/${postId}/pin`,
        );
        const next = typeof res?.pinned === 'boolean' ? res.pinned : optimistic;
        patchPostInAllCaches(queryClient, postId, (p) => ({
          ...p,
          isPinned: next,
        }));
        // Invalidate list views so newly-pinned posts surface at the top
        // (server orders by isPinned desc).
        void queryClient.invalidateQueries({ queryKey: ['topic'] });
        void queryClient.invalidateQueries({ queryKey: ['feed'] });
        return { ok: true };
      } catch (e) {
        patchPostInAllCaches(queryClient, postId, (p) => ({
          ...p,
          isPinned: currentPinned,
        }));
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, message: msg };
      }
    },
    [client, postId, queryClient],
  );

  return { vote, toggleBookmark, toggleReaction, record, addComment, togglePin };
}
