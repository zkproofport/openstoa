'use client';

/**
 * The account's own event stream, open for as long as a community page is.
 *
 * The chat stream is per topic and only lives while that room is on screen,
 * which is useless for the one thing scoped-tier chat depends on: telling a
 * browser that HOLDS keys that somebody needs them. That browser is almost
 * never in the room — which is precisely why the newcomer is stuck reading
 * "Encrypted — this device has no key for it".
 *
 * The web matters here even more than the mini-app: it has no push at all, so
 * this stream is the ONLY way a browser holding keys can be told to hand them
 * over without its user happening to open the right conversation.
 *
 * Nothing secret arrives. The event names a topic; the keys themselves go on
 * travelling sealed to a recipient leaf through the bundle mailbox, which the
 * server cannot open. This stream only decides WHEN a holder tries.
 */
import { useEffect, useRef } from 'react';
import { grantRoomKeys } from '@/lib/keyGrant';

/**
 * @param enabled false for a signed-out visitor: there is no account to receive
 *   anything for, and opening the stream would only earn a 401.
 */
/** How long after a grant the same topic is left alone. */
export const GRANT_COOLDOWN_MS = 60_000;
/** Cap on the per-topic memory, so a long-lived tab cannot grow it without end. */
const GRANT_MEMORY_MAX = 200;

export function useAccountEvents(enabled: boolean): void {
  /**
   * Topics with a grant in flight.
   *
   * The server broadcasts to every member, so a busy room can deliver several
   * events in a row; without this each one starts its own pass over the same
   * leaves. Cleared when the pass ends, so a later event still runs.
   */
  const inFlight = useRef<Set<string>>(new Set());
  /**
   * When each topic last finished a grant, so a reconnect does not redo it.
   *
   * The server REPLAYS `key-needed` on every connect (up to 20 topics), and
   * `EventSource` reconnects on its own after any blip — so without this, a
   * flaky connection re-runs twenty passes over the same leaves each time. The
   * twin of this map lives in the mini-app's `api/useAccountEvents.ts`.
   */
  const lastGrantAt = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!enabled) return;
    /*
     * No EventSource, no stream — and no crash.
     *
     * This hook sits in the layout that wraps every community page, so a throw
     * here takes the whole page down. That is not hypothetical: it is exactly
     * what happened the first time this was mounted, in an environment without
     * the API. Losing the key nudge costs a delay the room's own retry already
     * covers; losing the page costs everything.
     */
    if (typeof EventSource === 'undefined') return;

    // Same-origin, so the session cookie rides along and no handle is needed:
    // the browser is not a push target, and the server gives an unnamed stream
    // an id that can never suppress a real device's notification.
    const es = new EventSource('/api/me/events');

    es.addEventListener('key-needed', (event) => {
      let topicId: string | null = null;
      try {
        const data = JSON.parse((event as MessageEvent).data) as { topicId?: unknown };
        if (typeof data.topicId === 'string' && data.topicId) topicId = data.topicId;
      } catch {
        // A payload this client cannot read is not worth acting on, and not
        // worth surfacing either — the room's own retry still covers the topic.
      }
      if (!topicId || inFlight.current.has(topicId)) return;
      /*
       * Not again straight away — including after a failure. A grant that
       * failed for a reason a retry would fix is covered by the room's own
       * repeating tick; redoing it on every reconnect fixes nothing.
       */
      if (Date.now() - (lastGrantAt.current.get(topicId) ?? 0) < GRANT_COOLDOWN_MS) return;

      const id = topicId;
      inFlight.current.add(id);
      void grantRoomKeys(id)
        .catch(() => {
          // Expected often: this browser may hold nothing for that topic, or
          // may not be a member any more. Nothing to tell anyone.
        })
        .finally(() => {
          inFlight.current.delete(id);
          lastGrantAt.current.set(id, Date.now());
          // Bounded: nothing else trims this over a long-lived tab.
          if (lastGrantAt.current.size > GRANT_MEMORY_MAX) {
            const oldest = lastGrantAt.current.keys().next().value;
            if (oldest !== undefined) lastGrantAt.current.delete(oldest);
          }
        });
    });

    // EventSource reconnects on its own; a signed-out visitor gets a 401 and
    // the browser stops retrying, which is the behaviour we want.
    return () => es.close();
  }, [enabled]);
}
