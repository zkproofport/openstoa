/**
 * OS-level mirror of the Topic Archive Key for the background push handler
 * (design §13.6 strategy A).
 *
 * The handler that turns an incoming chat notification into a real preview runs
 * outside the mini-app — on iOS a Notification Service Extension in its OWN
 * process, on Android an FCM service with no JS runtime attached — so it cannot
 * ask the mini-app for a key. The key has to be sitting in OS storage it can
 * read before the push arrives. This module puts it there.
 *
 * Two platforms, two destinations, one entry key format:
 *   - iOS     → the shared Keychain access group both the host app and
 *               `OpenStoaNSE` are entitled to, written via `expo-secure-store`.
 *   - Android → a Keystore-encrypted store the host's FCM service owns, written
 *               over the host bridge (`HostApi.mirrorTopicArchiveKey`). There is
 *               no access-group problem there — the service runs in the same
 *               package — but the mini-app still cannot reach that store
 *               directly, hence the bridge. Reading `expo-secure-store`'s own
 *               Android storage from Kotlin was rejected: it is a private
 *               envelope format that is free to change on any upgrade.
 *
 * Why the TAK and not the MLS key: opening the live MLS ciphertext consumes a
 * forward-secret ratchet key; if the handler did that, the host app could no
 * longer derive the same key and the group would desync. The TAK is a stable
 * symmetric key — decrypting with it consumes nothing.
 *
 * Additive by construction: this writes NEW `openstoa.tak.*` entries only. The
 * canonical MLS/TAK state keeps living where it already lives (the host secure
 * store via `HostApi.secureStore`), untouched. On a host binary that supports
 * neither path, every call is a silent no-op.
 *
 * This file is deliberately free of `react-native` imports so it is unit
 * testable in node; the platform-bound entry point is `sharedKeychainNative.ts`
 * (same split as `pushRegistration.ts` / `usePushRegistration.ts`).
 */

/** Kept in sync with `OpenStoaNSE/NotificationService.swift` + the host entitlements. */
export const SHARED_KEYCHAIN_ACCESS_GROUP = 'com.masselabs.zkproofport.openstoa';

/** Raw TAK length in bytes (takClient TAK_LEN) — a mirrored key must be exactly this. */
export const TAK_BYTES = 32;

/**
 * Storage entry name for one topic's TAK at one version. Identical on both
 * platforms — the iOS Keychain account (`TakKeychain.account`) and the Android
 * store key (`OpenStoaTakStore.entryKey`) — so the two stay comparable.
 */
export function sharedTakKey(topicId: string, takVersion: number): string {
  return `openstoa.tak.${topicId}.${takVersion}`;
}

/**
 * Storage entry name for the session the iOS extension fetches ATTACHMENTS with
 * (P-1). Mirrors `TakKeychain.pushSessionAccount` in the NSE.
 *
 * Per TOPIC, for the same reason the TAK is: the host owns ONE APNs token while
 * the mini-app may hold several session nullifiers, and the push carries none.
 * An entry written under a topic is by construction a session that is a member
 * of it, so the extension picks the right one without knowing which nullifier
 * the push was routed to (§13.6).
 */
export function sharedPushSessionKey(topicId: string): string {
  return `openstoa.push.session.${topicId}`;
}

/**
 * Mirror the credential the iOS Notification Service Extension needs to FETCH an
 * attachment (P-1).
 *
 * A message preview needs only a key, because the ciphertext rides in the push.
 * A picture does not fit in a push, so the extension has to go and get it — and
 * the read route is membership-gated, correctly, since a public object URL would
 * be an unauthenticated handle outliving every membership check. The extension
 * cannot ask this process for a token (different process, app not running), so
 * the token has to be sitting in shared storage before the push arrives, exactly
 * like the TAK beside it.
 *
 * What is stored is a bearer token, which is more sensitive than the TAK only in
 * that it is not topic-scoped. It goes to the SAME access group — scoped by the
 * app identifier prefix, so only this app's own binaries can read it — under the
 * same `AFTER_FIRST_UNLOCK` protection, and is overwritten on every visit to the
 * room, so a stale one is replaced rather than accumulating. A stale entry is not
 * a failure mode worth guarding: the fetch 401s and the recipient gets the
 * caption without the thumbnail.
 *
 * iOS only. Android's handler shows text and never fetches (see
 * `OpenStoaPushHandler`), so mirroring a token there would store a credential
 * for a caller that does not exist.
 */
export async function mirrorPushSessionWith(
  store: SecureStoreLike | null,
  platformOS: string,
  topicId: string,
  baseUrl: string,
  token: string,
): Promise<boolean> {
  if (typeof topicId !== 'string' || topicId.length === 0) return false;
  if (typeof token !== 'string' || token.length === 0) return false;
  // Absolute http(s) only. The extension re-checks this before sending the
  // token anywhere, but a value that could never be usable should not be
  // written in the first place.
  if (typeof baseUrl !== 'string' || !/^https?:\/\/[^/\s]+/i.test(baseUrl)) return false;
  if (platformOS !== 'ios') return false;
  if (!store || typeof store.setItemAsync !== 'function') return false; // stale host binary
  try {
    await store.setItemAsync(
      sharedPushSessionKey(topicId),
      JSON.stringify({ baseUrl, token }),
      {
        keychainAccessGroup: SHARED_KEYCHAIN_ACCESS_GROUP,
        keychainAccessible: store.AFTER_FIRST_UNLOCK ?? undefined,
      },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The slice of `expo-secure-store` we use. Declared structurally rather than
 * imported: the package is a HOST dependency, not one of this package's own.
 */
export interface SecureStoreLike {
  setItemAsync(
    key: string,
    value: string,
    options?: { keychainAccessGroup?: string; keychainAccessible?: unknown },
  ): Promise<void>;
  /** `AFTER_FIRST_UNLOCK` — absent on older module builds. */
  AFTER_FIRST_UNLOCK?: unknown;
}

/** base64 of exactly TAK_BYTES raw bytes — rejects anything else. */
function isTakB64(v: unknown): v is string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(v) || v.length % 4 !== 0) return false;
  try {
    return globalThis.atob(v).length === TAK_BYTES;
  } catch {
    return false;
  }
}

/**
 * The slice of `HostApi` the Android path needs. Optional by contract: a host
 * binary older than the bridge method simply omits it.
 */
export interface TakMirrorHost {
  mirrorTopicArchiveKey?(
    topicId: string,
    takVersion: number,
    takB64: string,
  ): Promise<boolean>;
}

/**
 * Shared argument validation. Applies to BOTH platforms: whatever the
 * destination, only a real topic id, a non-negative safe-integer version and
 * base64 of exactly 32 raw bytes may be written.
 */
function isMirrorable(topicId: string, takVersion: number, takB64: string): boolean {
  if (typeof topicId !== 'string' || topicId.length === 0) return false;
  if (typeof takVersion !== 'number' || !Number.isSafeInteger(takVersion) || takVersion < 0) return false;
  return isTakB64(takB64);
}

/**
 * Testable core. Returns true only when the key was actually written. Never
 * throws — a failed mirror just means the background handler falls back to the
 * content-free "New message" placeholder.
 *
 * iOS writes straight into the shared Keychain access group through
 * `expo-secure-store`; Android has no access group to write into and no way to
 * reach the FCM service's store from JS, so it goes over the host bridge. Any
 * other platform (the standalone shell, web) has no background handler at all.
 */
export async function mirrorTakWith(
  store: SecureStoreLike | null,
  platformOS: string,
  topicId: string,
  takVersion: number,
  takB64: string,
  host?: TakMirrorHost | null,
): Promise<boolean> {
  if (!isMirrorable(topicId, takVersion, takB64)) return false;

  if (platformOS === 'android') {
    // Host binary predating the bridge method → no background preview path.
    if (!host || typeof host.mirrorTopicArchiveKey !== 'function') return false;
    try {
      // The host resolves false for a rejected/failed write; coerce so a host
      // that resolves something else can never look like a success.
      return (await host.mirrorTopicArchiveKey(topicId, takVersion, takB64)) === true;
    } catch {
      return false;
    }
  }

  if (platformOS !== 'ios') return false; // no background handler on this platform
  if (!store || typeof store.setItemAsync !== 'function') return false; // stale host binary
  try {
    await store.setItemAsync(sharedTakKey(topicId, takVersion), takB64, {
      keychainAccessGroup: SHARED_KEYCHAIN_ACCESS_GROUP,
      // Notifications arrive while the device is locked, so the extension needs an
      // item that survives the lock screen — but still requires one unlock since
      // boot. `?? undefined` keeps this working on an older module build.
      keychainAccessible: store.AFTER_FIRST_UNLOCK ?? undefined,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * expo-secure-store is a native module: a top-level import instantiates its
 * bridge at module-load time and throws on a stale host binary. Same lazy-require
 * precaution ChatRoomScreen uses for expo-image-picker.
 */
export function loadSecureStore(): SecureStoreLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-secure-store') as SecureStoreLike;
  } catch {
    return null;
  }
}
