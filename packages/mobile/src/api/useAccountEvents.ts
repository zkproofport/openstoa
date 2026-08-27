/**
 * The account's own event stream, open for as long as the app is.
 *
 * `useChatSocket` is per topic and only lives while that room is on screen,
 * which is useless for the one thing scoped-tier chat depends on: telling a
 * device that HOLDS keys that somebody needs them. That device is almost never
 * in the room — that is precisely why the newcomer is stuck reading "Encrypted
 * — this device has no key for it".
 *
 * So this one is per account. It is opened once, near the root, and its only
 * job today is to run a grant when the server says a topic may need one.
 *
 * Nothing secret arrives here. The event names a topic; the keys themselves go
 * on travelling sealed to a recipient leaf through the bundle mailbox, which
 * the server cannot open. This stream only decides WHEN a holder tries.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { openReconnectingStream } from './reconnectingStream';
import { useHost } from '@openstoa/miniapp-bridge';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../stores/sessionStore';
import { grantRoomKeys } from '../crypto/keyGrant';
import { getPushRoutingHandle, subscribePushRoutingHandle } from '../hooks/pushRegistration';
import { subscribeKeyNeededPushes } from '../hooks/pushReceived';

type AccountEventName = 'key-needed' | 'ping';

/** How long after a grant the same topic is left alone. */
export const GRANT_COOLDOWN_MS = 60_000;
/** Cap on the per-topic memory, so a long session cannot grow it without end. */
const GRANT_MEMORY_MAX = 200;

interface KeyNeededData {
  topicId?: unknown;
}

export function useAccountEvents(): void {
  const host = useHost();
  const client = useOpenStoaClient();
  const mode = useOpenStoaSession((s) => s.mode);
  /*
   * The name this device is known by to the push fan-out.
   *
   * Sent so the server can tell that THIS device is already listening and skip
   * waking it. It arrives asynchronously — push registration and this stream
   * start together — so the stream reconnects once it is known rather than
   * waiting for it: an unnamed stream still receives everything, it just does
   * not suppress its own push until the name lands.
   */
  const [deviceHandle, setDeviceHandle] = useState<string | null>(() => getPushRoutingHandle());
  useEffect(() => subscribePushRoutingHandle(setDeviceHandle), []);

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
   * The server REPLAYS `key-needed` on every connect (up to 20 topics), and a
   * phone reconnects whenever the network changes — so without this, walking
   * between wifi and cellular re-runs twenty passes over the same leaves. The
   * twin of this map lives in the web's `src/lib/useAccountEvents.ts`.
   */
  const lastGrantAt = useRef<Map<string, number>>(new Map());

  /**
   * Run one grant: at most one at a time per topic, and not again straight away.
   *
   * Shared by BOTH triggers on purpose. A push and a stream event for the same
   * topic routinely arrive together — the server wakes every device that is not
   * streaming, and "not streaming" is decided a moment before the stream comes
   * up — and two passes over the same leaves is waste at best and interleaved
   * writes at worst.
   *
   * The cooldown applies to failures too. A grant that failed for a reason a
   * retry would fix is covered by the room's own repeating tick, which backs
   * off from 3s; hammering the same pass on every reconnect is not what fixes
   * anything.
   */
  const grant = useCallback(
    (topicId: string) => {
      if (inFlight.current.has(topicId)) return;
      const last = lastGrantAt.current.get(topicId) ?? 0;
      if (Date.now() - last < GRANT_COOLDOWN_MS) return;

      inFlight.current.add(topicId);
      void grantRoomKeys(client, host, topicId)
        .catch(() => {
          // Expected often: this device may hold nothing for that topic, or
          // may not be a member any more. Nothing to tell anyone.
        })
        .finally(() => {
          inFlight.current.delete(topicId);
          lastGrantAt.current.set(topicId, Date.now());
          // Bounded: the key is a topic id from the server, but nothing else
          // trims this map over a long-lived session.
          if (lastGrantAt.current.size > GRANT_MEMORY_MAX) {
            const oldest = lastGrantAt.current.keys().next().value;
            if (oldest !== undefined) lastGrantAt.current.delete(oldest);
          }
        });
    },
    [client, host],
  );

  /*
   * The push fallback for exactly the case the stream cannot cover: this device
   * was asleep when somebody joined, so it had no stream to be told on. The
   * host replays anything delivered while the mini-app was unmounted, so a
   * notification that arrived on another tab is not lost either.
   */
  useEffect(() => {
    if (mode !== 'authenticated') return;
    return subscribeKeyNeededPushes(host, grant);
  }, [host, mode, grant]);

  useEffect(() => {
    // Guests have no account to receive anything for, and opening the stream
    // would only earn a 401 and a rebuild loop.
    if (mode !== 'authenticated') return;

    /*
     * The stream owns its own reconnect, and re-reads the token on every
     * attempt. Until 2026-08-27 the token was read once and baked into the
     * connection's headers; `react-native-sse` then retried that same dead
     * credential forever after a session refresh, and because this stream had
     * no error listener at all, nothing said so. `key-needed` simply stopped
     * arriving and rooms sat on "Waiting for the key…".
     */
    const stream = openReconnectingStream<AccountEventName>({
      url: () => {
        const base = `${host.getEnvironment().openstoaBaseUrl}/api/me/events`;
        return deviceHandle ? `${base}?device=${encodeURIComponent(deviceHandle)}` : base;
      },
      token: () => host.getOpenStoaToken().catch(() => null),
      /*
       * This effect only runs for an authenticated session (`mode !== …` above
       * returns early), so the answer is constant here — but it is passed
       * EXPLICITLY rather than left to the default. A default that has to be
       * right for two different callers is a default that will be wrong for
       * one of them the next time it is changed.
       */
      isAuthenticated: () => true,
      on: {
        'key-needed': (event) => {
          let topicId: string | null = null;
          try {
            const data = JSON.parse(event.data ?? '{}') as KeyNeededData;
            if (typeof data.topicId === 'string' && data.topicId) topicId = data.topicId;
          } catch {
            // A payload this client cannot read is not worth acting on, and not
            // worth surfacing either — the room's retry still covers the topic.
          }
          if (topicId) grant(topicId);
        },
      },
    });

    return () => stream.close();
  }, [host, mode, deviceHandle, grant]);
}
