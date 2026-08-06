'use client';

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
  /** Latest CHAT activity, from `GET /api/topics`. Not `lastActivityAt`, which
   *  posts bump — see the route. */
  lastChatAt?: string | null;
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
          fetch('/api/topics', { credentials: 'include' }),
          fetch('/api/dm', { credentials: 'include' }),
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
        // `createdAt: ''` because the row types carry no creation time — rooms
        // nobody has spoken in keep their server order rather than shuffling.
        setTopics(
          sortConversationsByActivity(
            loaded.map((t) => ({ ...t, createdAt: '' })),
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

  useEffect(() => {
    reload();
  }, [reload]);

  return { topics, dms, loading, error, unauthenticated, needsNickname, reload };
}
