'use client';

import { apiFetch } from '@/lib/apiFetch';
import { useCallback, useEffect, useState } from 'react';
import { sortConversationsByActivity } from '@/lib/chatSort';
import { sortDmChannels } from '@/lib/dm';

/**
 * The ONE place the conversation list is loaded and ordered.
 *
 * Three components fetched `/api/topics` and `/api/dm` and kept their own state:
 * `/chat`, the rail, and `/my`. Ordering therefore had to be fixed three times,
 * and it was not — `/chat` got the newest-first rule while the rail, which is
 * the list actually on screen most of the time, kept showing creation order.
 * Putting the rule in a shared function was not enough; the fetch had to move
 * too, or the next caller starts the same drift again.
 *
 * Deliberately not a data-fetching library: this is two GETs and a sort, and the
 * live updates that matter arrive over the chat SSE stream, not by polling.
 */

/** Minimum shape the list needs. Callers narrow to their own row types. */
export interface ConversationTopic {
  id: string;
  /** When the room was made — the ranking key for one nobody has spoken in. */
  createdAt?: string | null;
  /** Latest CHAT activity, from `GET /api/topics`. Not `lastActivityAt`, which
   *  posts bump — see the route. */
  lastChatAt?: string | null;
  /** Unread messages past this account's read cursor, from the same route. */
  unreadCount?: number;
}

export interface ConversationListState<T, D> {
  /** null while the first load is in flight — distinct from an empty list. */
  topics: T[] | null;
  dms: D[] | null;
  loading: boolean;
  /**
   * null when nothing failed. A STRING when it did — possibly empty, meaning
   * "the server said no" with no cause worth showing. Callers localise the empty
   * case and surface the non-empty one, which is how a reader gets to see
   * "network down" instead of a generic label that hides it.
   */
  error: string | null;
  /** Unauthenticated. Callers decide whether to redirect. */
  unauthenticated: boolean;
  /** Authenticated but the account still needs a nickname. */
  needsNickname: boolean;
  reload: () => void;
  /**
   * Zero one room's badge locally, without waiting for a refetch.
   *
   * Opening a room IS reading it, and the server hears about that on a debounce
   * from the panel. Between the two, a list that kept rendering the old count
   * would show a badge for messages the user is looking at. This is the local
   * CACHE half of the same fact — the server stays authoritative, and the next
   * load overwrites whatever this set.
   *
   * Matches by topic id across BOTH tabs, because a DM's id IS a topic id.
   */
  clearUnread: (topicId: string) => void;
}

export function useConversationList<T extends ConversationTopic, D>(options?: {
  /** Skip loading entirely (guests have no conversations). */
  enabled?: boolean;
}): ConversationListState<T, D> {
  const enabled = options?.enabled ?? true;
  const [topics, setTopics] = useState<T[] | null>(null);
  const [dms, setDms] = useState<D[] | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [unauthenticated, setUnauthenticated] = useState(false);
  const [needsNickname, setNeedsNickname] = useState(false);

  const reload = useCallback(() => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [topicsRes, dmsRes] = await Promise.all([
          apiFetch('/api/topics', { credentials: 'include' }),
          apiFetch('/api/dm', { credentials: 'include' }),
        ]);
        if (topicsRes.status === 401 || dmsRes.status === 401) {
          setUnauthenticated(true);
          return;
        }
        if (topicsRes.status === 403 || dmsRes.status === 403) {
          setNeedsNickname(true);
          return;
        }
        // No cause to show: the request completed and the server refused. The
        // empty string keeps this distinct from `null` (nothing failed).
        if (!topicsRes.ok || !dmsRes.ok) {
          setError('');
          return;
        }
        const [topicsData, dmsData] = await Promise.all([topicsRes.json(), dmsRes.json()]);
        const loaded: T[] = Array.isArray(topicsData?.topics) ? topicsData.topics : [];
        // `createdAt` comes straight from the topic row, so a room just created
        // ranks by "now" and lands at the top — where the person who made it is
        // looking for it.
        setTopics(
          sortConversationsByActivity(
            loaded.map((t) => ({ ...t, createdAt: t.createdAt ?? '' })),
            (t) => t.lastChatAt,
          ) as T[],
        );
        setDms(sortDmChannels(Array.isArray(dmsData?.dms) ? dmsData.dms : []) as D[]);
      } catch (err) {
        // An empty list here would read as "you have no conversations", which is
        // both wrong and undebuggable — say it failed so the caller can retry,
        // and keep the cause: "network down" tells the reader what to do.
        setError(err instanceof Error ? err.message : '');
      } finally {
        setLoading(false);
      }
    })();
  }, [enabled]);

  const clearUnread = useCallback((topicId: string) => {
    if (typeof topicId !== 'string' || topicId === '') return;
    setTopics((prev) =>
      prev === null
        ? prev
        : prev.map((t) => (t.id === topicId && t.unreadCount ? { ...t, unreadCount: 0 } : t)),
    );
    setDms((prev) =>
      prev === null
        ? prev
        : prev.map((d) => {
            const row = d as D & { topicId?: string; unreadCount?: number };
            return row.topicId === topicId && row.unreadCount ? { ...row, unreadCount: 0 } : d;
          }),
    );
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { topics, dms, loading, error, unauthenticated, needsNickname, reload, clearUnread };
}
