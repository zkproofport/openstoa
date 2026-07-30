import { useEffect, useRef, useState } from 'react';
import EventSource from 'react-native-sse';
import { useHost } from '@openstoa/miniapp-bridge';
import type { ChatMessage, PresencePayload } from '@openstoa/api-types';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { getMlsSessionStore, toDisplayMessageMls } from '../crypto/mobileTransport';

type SSEEventName = 'message' | 'presence' | 'ping';

export interface UseChatSocketResult {
  messages: ChatMessage[];
  presence: PresencePayload | null;
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
  error: string | null;
}

/**
 * Subscribe to OpenStoa chat events for a given topic via SSE
 * (`GET /api/topics/:id/chat/subscribe`). The host's HostApi provides the
 * base URL and a fresh JWT for the Authorization header. Auto-reconnects
 * on transient errors; cleans up on unmount.
 */
export function useChatSocket(topicId: string | null | undefined): UseChatSocketResult {
  const host = useHost();
  const client = useOpenStoaClient();
  // Pass the host secure store so MLS state persists across restarts (same leaf
  // restored, no re-join). Singleton: first caller (here or ChatRoomScreen) wins.
  const mls = getMlsSessionStore(client, host.secureStore, host.localStore);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [presence, setPresence] = useState<PresencePayload | null>(null);
  const [status, setStatus] = useState<UseChatSocketResult['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!topicId) {
      setStatus('idle');
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        setStatus('connecting');
        const token = await host.getOpenStoaToken();
        if (!token) {
          throw new Error('Not authenticated — cannot open chat socket');
        }
        if (cancelled) return;

        const url = `${host.getEnvironment().openstoaBaseUrl}/api/topics/${topicId}/chat/subscribe`;
        const es = new EventSource(url, {
          headers: { Authorization: `Bearer ${token}` },
          // react-native-sse handles reconnect via its own polling timer.
        });
        esRef.current = es;

        es.addEventListener('open', () => {
          if (cancelled) return;
          setStatus('open');
          setError(null);
        });

        const onMessage = (e: any) => {
          if (cancelled) return;
          try {
            const raw = JSON.parse(e.data) as ChatMessage;
            // Decrypt the sealed body before display (async); dedupe by id.
            // NOTE: the sender's OWN message can't be decrypted here (MLS sender
            // ratchet advanced) → it surfaces as "[unable to decrypt]". The send
            // path must optimistically echo the local plaintext (same fix as
            // web ChatPanel) — finalize during simulator verification (P2-21).
            // .catch is mandatory: an unhandled rejection here would drop the
            // live row silently AND surface as an unhandled promise rejection.
            // toDisplayMessageMls already degrades per row, so this only covers
            // a future regression — it must never take the socket down.
            toDisplayMessageMls(mls, topicId, raw)
              .then((data) => {
                if (cancelled) return;
                setMessages((prev) =>
                  prev.some((m) => m.id === data.id) ? prev : [...prev, data],
                );
              })
              .catch(() => {
                /* undecryptable live row — the history refetch shows it later */
              });
          } catch (err) {
            // ignore malformed
          }
        };

        const onPresence = (e: any) => {
          if (cancelled) return;
          try {
            const data = JSON.parse(e.data) as PresencePayload;
            setPresence(data);
          } catch (err) {
            // ignore malformed
          }
        };

        const onPing = () => { /* keepalive */ };

        const onError = (e: any) => {
          if (cancelled) return;
          setStatus('error');
          setError(e?.message ?? 'SSE error');
        };

        es.addEventListener('message' as SSEEventName, onMessage);
        es.addEventListener('presence' as SSEEventName, onPresence);
        es.addEventListener('ping' as SSEEventName, onPing);
        es.addEventListener('error', onError);
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      try {
        esRef.current?.close();
      } catch {
        /* ignore */
      }
      esRef.current = null;
      // Do not call setStatus here — the next effect invocation will set its
      // own status. Calling it unconditionally would race with 'connecting'
      // already set by the new effect on the same render cycle.
    };
  }, [topicId, host]);

  return { messages, presence, status, error };
}
