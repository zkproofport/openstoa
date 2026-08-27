import { useEffect, useState } from 'react';
import { openReconnectingStream } from './reconnectingStream';
import { useOpenStoaSession } from '../stores/sessionStore';
import { useHost } from '@openstoa/miniapp-bridge';
import type { ChatMessage, PresencePayload } from '@openstoa/api-types';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { getMlsSessionStore, toDisplayMessageMls } from '../crypto/mobileTransport';

/**
 * The event names the chat stream emits ON TOP of react-native-sse's built-ins
 * ('open' | 'message' | 'error' | 'close'). `EventSource` is generic over
 * exactly this set — leaving it off makes the parameter `never`, which is why
 * `addEventListener('presence', ...)` used to need a cast to compile. The cast
 * silenced the error without registering the listener type, so a rename on
 * either side went unnoticed; the generic makes the compiler check it.
 */
type SSECustomEventName = 'presence' | 'ping';

export interface UseChatSocketResult {
  messages: ChatMessage[];
  presence: PresencePayload | null;
  /**
   * `rejected` is terminal and means the SERVER refused the credential twice,
   * each time with a freshly read token — the session is dead and no amount of
   * waiting revives it. Distinct from `error`, which is a connection that
   * dropped and will be retried, because the two need opposite sentences on
   * screen: "reconnecting" is a lie once the server has said no.
   */
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed' | 'rejected';
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

  useEffect(() => {
    if (!topicId) {
      setStatus('idle');
      return;
    }

    /*
     * The stream owns its own reconnect, and re-reads the token on every
     * attempt. Until 2026-08-27 the token was read once and baked into the
     * connection's headers; `react-native-sse` then retried that same dead
     * credential after a session refresh, so the "Reconnecting to the chat
     * server…" banner appeared and never cleared while sends failed and sat
     * offering Resend. Reported from an iPhone.
     */
    const stream = openReconnectingStream<SSECustomEventName>({
      url: () => `${host.getEnvironment().openstoaBaseUrl}/api/topics/${topicId}/chat/subscribe`,
      token: () => host.getOpenStoaToken(),
      // A guest has no session to lose; see `isAuthenticated` in the stream.
      isAuthenticated: () => useOpenStoaSession.getState().mode === 'authenticated',
      onStatus: (s, detail) => {
        setStatus(s);
        setError(s === 'error' || s === 'rejected' ? (detail ?? 'SSE error') : null);
      },
      on: {
        message: (event) => {
          try {
            const raw = JSON.parse(event.data ?? '') as ChatMessage;
            /*
             * The sender's OWN message cannot be decrypted here — the MLS
             * sender ratchet has moved on — so it surfaces as unreadable and
             * the send path echoes the local plaintext instead.
             *
             * `.catch` is mandatory: an unhandled rejection would drop the live
             * row silently AND surface as an unhandled promise rejection.
             */
            void toDisplayMessageMls(mls, topicId, raw)
              .then((data) => {
                setMessages((prev) =>
                  prev.some((m) => m.id === data.id) ? prev : [...prev, data],
                );
              })
              .catch(() => {
                /* undecryptable live row — the history refetch shows it later */
              });
          } catch {
            // ignore malformed
          }
        },
        presence: (event) => {
          try {
            setPresence(JSON.parse(event.data ?? '') as PresencePayload);
          } catch {
            // ignore malformed
          }
        },
        ping: () => {
          /* keepalive */
        },
      },
    });

    return () => stream.close();
  }, [topicId, host, mls]);

  return { messages, presence, status, error };
}
