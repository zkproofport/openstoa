import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { useHost } from '@openstoa/miniapp-bridge';
import { clearActiveChatNotifications } from '../lib/chatNotifications';

/**
 * Re-clear the open chat room's notifications when the app comes back to the
 * foreground.
 *
 * Entering a room clears it (`ChatStack`'s `screenListeners`), but that fires
 * on FOCUS, and the case the tester hit has no focus change in it: read a
 * room, background the app, three more messages arrive for that same room,
 * come back to the app still sitting in it. The screen never blurred, so no
 * focus event follows — and without this the three notifications stay in the
 * tray while the messages themselves are on screen.
 *
 * Still per conversation: this clears whatever room is open and nothing else.
 * `clearActiveChatNotifications` is a no-op when none is, which is the common
 * case, so foregrounding anywhere else in the app costs one comparison.
 */
export function useChatNotificationClearing(): void {
  const host = useHost();
  useEffect(() => {
    // Also on mount: a cold start launched by a notification tap lands here
    // with the room already opening, and there is no 'active' transition to
    // listen for because the app was never anything else.
    clearActiveChatNotifications(host);
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') clearActiveChatNotifications(host);
    });
    return () => subscription.remove();
  }, [host]);
}
