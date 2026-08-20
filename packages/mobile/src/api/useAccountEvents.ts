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
import EventSource from 'react-native-sse';
import { useHost } from '@openstoa/miniapp-bridge';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../stores/sessionStore';
import { grantRoomKeys } from '../crypto/keyGrant';
import { getPushRoutingHandle, subscribePushRoutingHandle } from '../hooks/pushRegistration';
import { subscribeKeyNeededPushes } from '../hooks/pushReceived';

type AccountEventName = 'key-needed' | 'ping';

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

  const esRef = useRef<EventSource<AccountEventName> | null>(null);
  /**
   * Topics with a grant in flight.
   *
   * The server broadcasts to every member, so a busy room can deliver several
   * events in a row; without this each one starts its own pass over the same
   * leaves. Cleared when the pass ends, so a later event still runs.
   */
  const inFlight = useRef<Set<string>>(new Set());

  /**
   * Run one grant, at most one at a time per topic.
   *
   * Shared by BOTH triggers on purpose. A push and a stream event for the same
   * topic routinely arrive together — the server wakes every device that is not
   * streaming, and "not streaming" is decided a moment before the stream comes
   * up — and two passes over the same leaves is waste at best and interleaved
   * writes at worst.
   */
  const grant = useCallback(
    (topicId: string) => {
      if (inFlight.current.has(topicId)) return;
      inFlight.current.add(topicId);
      void grantRoomKeys(client, host, topicId)
        .catch(() => {
          // Expected often: this device may hold nothing for that topic, or
          // may not be a member any more. Nothing to tell anyone.
        })
        .finally(() => inFlight.current.delete(topicId));
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
    // would only earn a 401 and a reconnect loop.
    if (mode !== 'authenticated') return;
    let cancelled = false;

    (async () => {
      const token = await host.getOpenStoaToken().catch(() => null);
      if (!token || cancelled) return;

      const base = `${host.getEnvironment().openstoaBaseUrl}/api/me/events`;
      const url = deviceHandle ? `${base}?device=${encodeURIComponent(deviceHandle)}` : base;
      const es = new EventSource<AccountEventName>(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      esRef.current = es;

      es.addEventListener('key-needed', (event) => {
        if (cancelled) return;
        let topicId: string | null = null;
        try {
          const data = JSON.parse((event as { data?: string }).data ?? '{}') as KeyNeededData;
          if (typeof data.topicId === 'string' && data.topicId) topicId = data.topicId;
        } catch {
          // A payload this client cannot read is not worth acting on, and not
          // worth surfacing either — the room's retry still covers the topic.
        }
        if (topicId) grant(topicId);
      });
    })();

    return () => {
      cancelled = true;
      try {
        esRef.current?.removeAllEventListeners();
        esRef.current?.close();
      } catch {
        // already closed
      }
      esRef.current = null;
    };
  }, [host, mode, deviceHandle, grant]);
}
