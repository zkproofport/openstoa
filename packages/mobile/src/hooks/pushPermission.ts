/**
 * OS notification-permission reconciliation for the in-app notification switch
 * (P-M). Extracted from the settings screen so it is unit-testable: like
 * `./pushRegistration`, this module imports NOTHING from React, React Native or
 * the host bridge — the package's vitest runner is a plain node environment.
 *
 * Why this exists: the in-app switch is a SERVER-side preference. It cannot by
 * itself tell whether the operating system will actually deliver a push, so a
 * user who denied the OS prompt would flip the switch on and see nothing happen
 * — the exact "silently does nothing" failure this reconciliation prevents.
 *
 * Two sources, in order of confidence:
 *   1. `host.getPushPermissionStatus()` — a direct, NON-prompting read
 *      (expo-notifications `getPermissionsAsync` on the ZKProofport host).
 *   2. A registration ATTEMPT — hosts that predate (1) still return null from
 *      `registerForPush()` when the permission is denied, so a failed attempt
 *      downgrades the state to `blocked`. This is the fallback that makes the
 *      feature work on the host as it exists today.
 */

/** The slice of `HostApi` this module needs. Both members are optional. */
export interface PushPermissionHost {
  getPushPermissionStatus?(): Promise<
    'granted' | 'denied' | 'undetermined' | 'unavailable'
  >;
  registerForPush?(): Promise<{
    routingHandle: string;
    pushToken: string;
    platform: 'ios' | 'android';
  } | null>;
}

/**
 * What the settings UI renders.
 *
 * - `granted`  — the OS will deliver; the in-app switch is the only gate.
 * - `blocked`  — the OS refuses (denied, or a registration attempt came back
 *                empty). The UI must SAY SO and offer to open system settings;
 *                flipping the in-app switch alone will not help.
 * - `prompt`   — never asked. Turning the switch on will trigger the OS prompt.
 * - `unknown`  — the host cannot tell us (no `getPushPermissionStatus`, no push
 *                support at all, or the call threw). Render the switch with no
 *                claim about the OS rather than guessing.
 */
export type OsPushState = 'granted' | 'blocked' | 'prompt' | 'unknown';

/**
 * Read the OS permission WITHOUT prompting. Never throws — a host whose
 * implementation rejects is reported as `unknown`, because a settings screen
 * that crashes is worse than one that omits a hint.
 */
export async function readOsPushState(host: PushPermissionHost): Promise<OsPushState> {
  if (typeof host.getPushPermissionStatus !== 'function') {
    // No direct read available. If the host cannot register at all there is
    // genuinely no push on this build; otherwise we simply do not know yet.
    return typeof host.registerForPush === 'function' ? 'unknown' : 'blocked';
  }
  try {
    const status = await host.getPushPermissionStatus();
    switch (status) {
      case 'granted':
        return 'granted';
      case 'denied':
      case 'unavailable':
        return 'blocked';
      case 'undetermined':
        return 'prompt';
      default:
        // An unrecognised status from a newer/older host is not a licence to
        // claim anything about the OS.
        return 'unknown';
    }
  } catch {
    return 'unknown';
  }
}

/**
 * Fold the outcome of a registration ATTEMPT into the OS state. `'unavailable'`
 * from `registerPushOnce`/`registerPushNow` means the host could not produce a
 * token — on a real device that is a denied permission, so the UI switches to
 * `blocked` and offers system settings.
 *
 * A direct read that already said `granted` is NOT overwritten: on a simulator
 * (or with no EAS project id) registration also returns `'unavailable'` while
 * the permission itself is genuinely granted, and telling that user their
 * notifications are blocked would be wrong.
 */
export function applyRegistrationOutcome(
  current: OsPushState,
  outcome: 'unsupported' | 'duplicate' | 'unavailable' | 'registered' | 'failed',
): OsPushState {
  if (outcome === 'registered') return 'granted';
  if (outcome === 'unsupported') return 'blocked';
  if (outcome === 'unavailable') return current === 'granted' ? 'granted' : 'blocked';
  // 'duplicate' (already registered this session) and 'failed' (transient
  // network/host error) say nothing new about the OS permission.
  return current;
}
