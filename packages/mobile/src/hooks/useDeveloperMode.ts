import { useEffect, useState } from 'react';
import { useHost } from '@openstoa/miniapp-bridge';

/**
 * Returns the host's Developer Mode flag and keeps it in sync with the
 * host's runtime toggle (mirrors how `useThemeContext` subscribes to
 * `host.onThemeChange`). Mini-app code uses this to gate experimental
 * affordances — e.g. mDL sign-in — so they only surface when the host
 * user has explicitly opted in.
 *
 * Hosts that don't expose Developer Mode return `false` from
 * `getDeveloperMode()` and never invoke the change listener, so this hook
 * safely degrades on standalone shells.
 */
export function useDeveloperMode(): boolean {
  const host = useHost();
  const [enabled, setEnabled] = useState<boolean>(host.getDeveloperMode());

  useEffect(() => {
    return host.onDeveloperModeChange(setEnabled);
  }, [host]);

  return enabled;
}
