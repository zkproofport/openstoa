import { useEffect, useRef } from 'react';
import { useHost } from '@openstoa/miniapp-bridge';
import { useOpenStoaClient } from './useOpenStoaClient';

/**
 * Phase 6 push (design §13): once per mount, ask the host to register for OS
 * push (permission + token + a stable opaque routing handle) and POST the result
 * to `/api/push/register` so the near-blind gateway can send content-free dummy
 * notifications. Best-effort — the host returns null when push is unavailable
 * (simulator, permission denied, no push support) and we simply skip. Never
 * throws into the render path.
 *
 * @param enabled gate so guests don't attempt registration (no session yet).
 */
export function usePushRegistration(enabled: boolean): void {
  const host = useHost();
  const client = useOpenStoaClient();
  const attempted = useRef(false);

  useEffect(() => {
    if (!enabled || attempted.current) return;
    if (typeof host.registerForPush !== 'function') return; // host doesn't support push
    attempted.current = true;
    (async () => {
      try {
        const reg = await host.registerForPush!();
        if (!reg) return; // push unavailable on this host — skip silently
        await client.post('/api/push/register', {
          routingHandle: reg.routingHandle,
          pushToken: reg.pushToken,
          platform: reg.platform,
        });
      } catch {
        // Best-effort: a failed registration must never disrupt chat. Allow a
        // later mount to retry.
        attempted.current = false;
      }
    })();
  }, [enabled, host, client]);
}
