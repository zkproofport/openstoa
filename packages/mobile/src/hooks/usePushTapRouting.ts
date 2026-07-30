import { useEffect, useSyncExternalStore } from 'react';
import { useHost } from '@openstoa/miniapp-bridge';
import { useOpenStoaSession } from '../stores/sessionStore';
import {
  clearPendingChatTopic,
  getPendingChatTopicId,
  subscribePendingChatTopic,
  subscribePushTaps,
} from './pushTapRouting';

/**
 * Phase 6 push (design §13, P-O gap 5): subscribe to notification taps and latch
 * the topic they point at. Mounted at the mini-app ROOT (`OpenStoaApp`) so it is
 * alive during boot — a cold-start tap (the app was LAUNCHED by the tap) is
 * replayed by the host to the first subscriber, and the chat stack does not
 * exist yet at that moment.
 *
 * Routing itself happens in two places that own the relevant navigation object:
 * `OpenStoaTabNavigator` focuses the Chat tab, `ChatListScreen` pushes the room
 * (which is also what keeps the list beneath it, so Back works).
 *
 * A host without `onPushNotificationTap` (older binary, standalone shell)
 * degrades to a clean no-op.
 */
export function usePushTapRouting(): void {
  const host = useHost();
  const mode = useOpenStoaSession((s) => s.mode);

  useEffect(() => subscribePushTaps(host), [host]);

  // A guest has no chat to route to. Taps are latched unconditionally — during
  // boot the session mode is still 'unknown', and refusing to latch then would
  // lose exactly the cold-start tap this feature exists for — so the latch is
  // dropped once boot resolves to a guest, rather than firing much later at the
  // moment the user happens to sign in.
  useEffect(() => {
    if (mode === 'guest') clearPendingChatTopic();
  }, [mode]);
}

/**
 * The topic a notification tap is waiting to open, or null. Backed by the
 * module-level latch in `./pushTapRouting` (not a React store) because the
 * subscription that fills it starts before any navigator is mounted.
 */
export function usePendingChatTopicId(): string | null {
  return useSyncExternalStore(
    subscribePendingChatTopic,
    getPendingChatTopicId,
    getPendingChatTopicId,
  );
}
