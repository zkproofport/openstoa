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
export function useAccountEvents(enabled: boolean): void {
  /**
   * Topics with a grant in flight.
   *
   * The server broadcasts to every member, so a busy room can deliver several
   * events in a row; without this each one starts its own pass over the same
   * leaves. Cleared when the pass ends, so a later event still runs.
   */
  const inFlight = useRef<Set<string>>(new Set());

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

      const id = topicId;
      inFlight.current.add(id);
      void grantRoomKeys(id)
        .catch(() => {
          // Expected often: this browser may hold nothing for that topic, or
          // may not be a member any more. Nothing to tell anyone.
        })
        .finally(() => inFlight.current.delete(id));
    });

    // EventSource reconnects on its own; a signed-out visitor gets a 401 and
    // the browser stops retrying, which is the behaviour we want.
    return () => es.close();
  }, [enabled]);
}
