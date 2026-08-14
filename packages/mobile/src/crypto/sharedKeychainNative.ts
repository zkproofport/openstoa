/**
 * Platform-bound entry point for the OS-level TAK mirror (design §13.6).
 * All logic lives in `sharedKeychain.ts` (react-native free, unit tested); this
 * file only binds it to the running platform, the native secure-store module and
 * the host bridge.
 */
import { Platform } from 'react-native';
import {
  loadSecureStore,
  mirrorPushSessionWith,
  mirrorTakWith,
  type TakMirrorHost,
} from './sharedKeychain';

/**
 * Mirror one TAK to wherever this platform's background push handler can read
 * it, so it can decrypt this topic's push previews:
 *   - iOS     → the shared Keychain access group the NSE is entitled to.
 *   - Android → the host's Keystore-encrypted TAK store, over `host`.
 *
 * `host` is optional so a caller without one degrades to the iOS-only behaviour
 * instead of failing to compile. Returns false — never throws — when the mirror
 * is unavailable (other platform, host binary without the bridge method,
 * rejected key material).
 */
export function mirrorTakToSharedKeychain(
  topicId: string,
  takVersion: number,
  takB64: string,
  host?: TakMirrorHost | null,
): Promise<boolean> {
  return mirrorTakWith(loadSecureStore(), Platform.OS, topicId, takVersion, takB64, host);
}

/**
 * Mirror the session the iOS Notification Service Extension fetches ATTACHMENTS
 * with (P-1) — a key alone previews a message, but a picture has to be
 * downloaded through the membership-gated route.
 *
 * iOS only, and false rather than throwing on every unavailable path: the worst
 * outcome is a notification that says "📷 Photo" without the thumbnail.
 */
export function mirrorPushSessionToSharedKeychain(
  topicId: string,
  baseUrl: string,
  token: string,
): Promise<boolean> {
  return mirrorPushSessionWith(loadSecureStore(), Platform.OS, topicId, baseUrl, token);
}
