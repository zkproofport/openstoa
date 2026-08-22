'use client';

import { apiFetch } from '@/lib/apiFetch';
import { useCallback } from 'react';

export interface ReactionSummary {
  emoji: string;
  count: number;
  userReacted: boolean;
}

export interface VoteState {
  userVoted: 1 | -1 | null;
  upvoteCount: number;
}

export interface RecordState {
  recorded: boolean;
  recordCount: number;
}

export interface VoteResult {
  ok: boolean;
  next: VoteState;
  error?: 'not_member' | 'network';
}

export interface BookmarkResult {
  ok: boolean;
  next: boolean;
}

export interface RecordResult {
  ok: boolean;
  next: RecordState;
  error?: string;
}

// Centralised post mutations for the web app. Every function is pure
// (no internal state) — it takes the current state from the caller and
// returns the next state plus an `ok` flag. Components own their own
// optimistic UI state; the hook owns the API contract.
//
// This mirrors openstoa/packages/mobile/src/hooks/usePostMutations.ts
// so the list / detail / profile surfaces share one toggle / vote /
// reaction recipe instead of three inline copies.
export function usePostMutations(postId: string) {
  const vote = useCallback(
    async (value: 1 | -1, current: VoteState): Promise<VoteResult> => {
      try {
        const res = await apiFetch(`/api/posts/${postId}/vote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value }),
        });
        if (res.status === 403) return { ok: false, next: current, error: 'not_member' };
        if (!res.ok) return { ok: false, next: current, error: 'network' };
        const data = await res.json();
        return {
          ok: true,
          next: {
            userVoted: (data.vote?.value ?? null) as 1 | -1 | null,
            upvoteCount: typeof data.upvoteCount === 'number' ? data.upvoteCount : current.upvoteCount,
          },
        };
      } catch {
        return { ok: false, next: current, error: 'network' };
      }
    },
    [postId],
  );

  const toggleBookmark = useCallback(
    async (current: boolean): Promise<BookmarkResult> => {
      try {
        const res = await apiFetch(`/api/posts/${postId}/bookmark`, { method: 'POST' });
        if (!res.ok) return { ok: false, next: current };
        const data = await res.json();
        return { ok: true, next: !!data.bookmarked };
      } catch {
        return { ok: false, next: current };
      }
    },
    [postId],
  );

  const toggleReaction = useCallback(
    async (emoji: string, current: ReactionSummary[]): Promise<ReactionSummary[]> => {
      // Optimistically derive the next reaction set so the caller can
      // paint immediately. The server is the authority — on failure the
      // caller can re-fetch the canonical list, but the optimistic shape
      // is correct in the common case (matches the server toggle math).
      const existing = current.find((r) => r.emoji === emoji);
      let next: ReactionSummary[];
      if (existing) {
        if (existing.userReacted) {
          const c = existing.count - 1;
          next = c <= 0
            ? current.filter((r) => r.emoji !== emoji)
            : current.map((r) => (r.emoji === emoji ? { ...r, count: c, userReacted: false } : r));
        } else {
          next = current.map((r) => (r.emoji === emoji ? { ...r, count: r.count + 1, userReacted: true } : r));
        }
      } else {
        next = [...current, { emoji, count: 1, userReacted: true }];
      }
      try {
        await apiFetch(`/api/posts/${postId}/reactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emoji }),
        });
      } catch {
        // Best-effort recovery: re-read the truth from the server.
        try {
          const res = await apiFetch(`/api/posts/${postId}/reactions`);
          if (res.ok) {
            const data = await res.json();
            if (data?.reactions) return data.reactions as ReactionSummary[];
          }
        } catch {}
      }
      return next;
    },
    [postId],
  );

  const record = useCallback(
    async (current: RecordState): Promise<RecordResult> => {
      if (current.recorded) return { ok: true, next: current };
      try {
        const res = await apiFetch(`/api/posts/${postId}/record`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { ok: false, next: current, error: data?.error ?? 'Failed to record' };
        }
        return {
          ok: true,
          next: {
            recorded: true,
            recordCount: data?.record?.recordCount ?? current.recordCount + 1,
          },
        };
      } catch {
        return { ok: false, next: current, error: 'Network error' };
      }
    },
    [postId],
  );

  return { vote, toggleBookmark, toggleReaction, record };
}
