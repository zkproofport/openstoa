import { useEffect } from 'react';
import { useHost } from '@openstoa/miniapp-bridge';
import { useOpenStoaClient } from './useOpenStoaClient';
import { useOpenStoaSession } from '../stores/sessionStore';
import { registerPushOnce } from './pushRegistration';

/**
 * Phase 6 push (design §13): once per authenticated session, ask the host to
 * register for OS push (permission + token + a stable opaque routing handle) and
 * POST the result to `/api/push/register` so the near-blind gateway can send
 * chat notifications. Best-effort — the host returns null when push is
 * unavailable (simulator, permission denied, no push support) and we simply
 * skip. Never throws into the render path.
 *
 * Mounted at the mini-app ROOT (`OpenStoaApp`), not on a screen: while this hung
 * off `ChatListScreen`, a user who never opened the chat list never registered
 * and therefore never received a push.
 *
 * The once-per-session dedupe lives in `./pushRegistration` (module-level, keyed
 * by session identity) rather than in a per-component ref, because the app root
 * itself can unmount/remount.
 *
 * @param enabled gate so guests don't attempt registration (no session yet).
 */
export function usePushRegistration(enabled: boolean): void {
  const host = useHost();
  const client = useOpenStoaClient();
  const userId = useOpenStoaSession((s) => s.userId);

  useEffect(() => {
    if (!enabled) return;
    // `userId` is a string whenever mode is 'authenticated' (setSession always
    // populates it); '' is a legitimate key for the hydrate path that could not
    // recover a userId from /api/auth/session.
    void registerPushOnce(userId ?? '', host, client);
  }, [enabled, host, client, userId]);
}
