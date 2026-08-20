/**
 * Push-registration orchestration, extracted from `usePushRegistration` so it is
 * unit-testable. This module deliberately imports NOTHING from React, the host
 * bridge, or React Native — the package's vitest runner is a plain node
 * environment (`vitest.config.ts`) and `@openstoa/miniapp-bridge` is a
 * Metro-only `file:` peer that does not resolve there.
 *
 * The behaviour under test is the "exactly once per authenticated session"
 * trigger contract (design §13, Phase 6 push).
 */

/** The slice of `HostApi` this module needs. `registerForPush` is optional — a
 *  host without push support simply omits it. */
export interface PushRegistrationHost {
  registerForPush?(): Promise<{
    routingHandle: string;
    pushToken: string;
    platform: 'ios' | 'android';
  } | null>;
}

/** The slice of `OpenStoaClient` this module needs. */
export interface PushRegistrationPoster {
  post<T>(path: string, body?: unknown): Promise<T>;
}

/**
 * Outcome of one `registerPushOnce` call. Returned rather than logged so tests
 * can assert the branch that was taken; the hook ignores it.
 *
 * - `unsupported`  — host has no `registerForPush` (e.g. standalone shell).
 * - `duplicate`    — this identity already registered in this app process.
 * - `unavailable`  — host returned null: simulator, permission denied, or no
 *                    EAS project id. The claim is KEPT so we never re-prompt
 *                    for notification permission on every remount.
 * - `registered`   — token POSTed to `/api/push/register`.
 * - `failed`       — the host call or the POST threw. The claim is RELEASED so
 *                    a later mount retries (best-effort semantics).
 */
export type PushRegistrationResult =
  | 'unsupported'
  | 'duplicate'
  | 'unavailable'
  | 'registered'
  | 'failed';

/**
 * Session identities (`sessionStore.userId`) this app process has already
 * registered. Module-level on purpose — a per-component ref only dedupes within
 * one mount, which was fine while the trigger lived on a single screen but is
 * not now that it sits at the app root: the OpenStoa tab can unmount/remount
 * (tab switches, host navigation, React StrictMode's double-invoked effects)
 * and each remount would otherwise re-run the whole permission-prompt +
 * token-mint + POST sequence.
 *
 * Keyed by identity rather than a bare boolean so signing out and back in as a
 * DIFFERENT user still registers that user's device row (the server keys
 * push_tokens on (user_id=nullifier, routing_handle)). Re-authenticating as the
 * SAME user is correctly skipped: the OS push token and the routing handle are
 * both device-stable, so the row would be byte-identical.
 */
const registeredIdentities = new Set<string>();

/** Test seam: forget every recorded registration. Never called in app code. */
export function resetPushRegistrations(): void {
  registeredIdentities.clear();
}

/**
 * Register NOW, ignoring the once-per-session claim. Used by the notification
 * settings screen when the user turns the in-app switch ON: the automatic
 * once-per-session attempt may have already run (and been skipped, or declined)
 * before the user ever opened settings, so a plain `registerPushOnce` would
 * return `'duplicate'` and the device would stay unregistered.
 *
 * Deliberately implemented by releasing the claim and delegating, so there is
 * exactly ONE copy of the permission → token → POST sequence.
 */
export async function registerPushNow(
  identity: string,
  host: PushRegistrationHost,
  client: PushRegistrationPoster,
): Promise<PushRegistrationResult> {
  registeredIdentities.delete(identity);
  return registerPushOnce(identity, host, client);
}

/**
 * Claim `identity` and run the registration, at most once per identity per app
 * process. Never throws — the caller is a React effect and a push failure must
 * not disrupt the app.
 */
/**
 * This device's push routing handle, once it is known.
 *
 * Published because the account event stream has to identify itself by the SAME
 * name the push fan-out addresses devices with. Presence recorded under any
 * other name suppresses nothing — or worse, suppresses a different device — and
 * the case that matters is a browser being open while THIS phone, the one
 * holding the chat keys, is asleep.
 *
 * Set even when the registration POST fails: the handle is this device's
 * identity, not a receipt for the server having stored it.
 */
let routingHandle: string | null = null;
const handleListeners = new Set<(handle: string) => void>();

export function getPushRoutingHandle(): string | null {
  return routingHandle;
}

/** Notified once the handle is known. Returns an unsubscribe function. */
export function subscribePushRoutingHandle(listener: (handle: string) => void): () => void {
  handleListeners.add(listener);
  if (routingHandle) listener(routingHandle);
  return () => handleListeners.delete(listener);
}

function publishRoutingHandle(handle: string): void {
  if (routingHandle === handle) return;
  routingHandle = handle;
  for (const l of handleListeners) l(handle);
}

export async function registerPushOnce(
  identity: string,
  host: PushRegistrationHost,
  client: PushRegistrationPoster,
): Promise<PushRegistrationResult> {
  if (typeof host.registerForPush !== 'function') return 'unsupported';
  if (registeredIdentities.has(identity)) return 'duplicate';
  // Claim the slot SYNCHRONOUSLY, before the first await, so two mounts landing
  // in the same tick cannot both fire the registration.
  registeredIdentities.add(identity);
  try {
    const reg = await host.registerForPush();
    if (!reg) return 'unavailable';
    publishRoutingHandle(reg.routingHandle);
    await client.post('/api/push/register', {
      routingHandle: reg.routingHandle,
      pushToken: reg.pushToken,
      platform: reg.platform,
    });
    return 'registered';
  } catch {
    registeredIdentities.delete(identity);
    return 'failed';
  }
}
