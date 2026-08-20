/**
 * Notifications that were DELIVERED but never tapped (design §13.7).
 *
 * The account event stream (`useAccountEvents`) is the fast path for "somebody
 * needs a key": a device with the app open hears it in milliseconds. But the
 * device that HOLDS a scoped topic's keys is usually the one in a pocket with
 * the app closed, and a closed app has no stream. That is what the `key-needed`
 * push is for — and a push that only works when its banner is tapped puts the
 * newcomer's ability to read the room behind somebody noticing a notification.
 *
 * So this is the same grant trigger, driven by the delivery instead of the tap.
 *
 * Like `./pushTapRouting`, this module imports NOTHING from React, React Native
 * or the host bridge, so the package's plain-node vitest runner can exercise it.
 * And unlike that module it does not latch or navigate: a delivery is only
 * information, and the action it triggers is a background one.
 */
import { extractTopicId, flattenPushData, type PushNotificationTap } from './pushTapRouting';

/** The slice of `HostApi` this module needs; absent on a host without support. */
export interface PushReceivedHost {
  onPushNotificationReceived?(
    listener: (tap: PushNotificationTap) => void,
  ): () => void;
}

/**
 * The `kind` the server stamped on the payload, or null. Only an exact match
 * counts: `data.kind` is chosen from a fixed set by `src/lib/push.ts`, so a
 * near-miss is a payload from something else, not a variant to be lenient with.
 */
export function extractPushKind(tap: PushNotificationTap): string | null {
  const kind = flattenPushData(tap?.data).kind;
  return typeof kind === 'string' && kind.length > 0 ? kind : null;
}

/** The kind that asks a holder to hand keys over. Mirrors `buildKeyNeededPayload`. */
export const KEY_NEEDED_KIND = 'key-needed';

/**
 * The topic a delivery is asking this device to grant keys for, or null for
 * every other notification. Null is ALWAYS a silent no-op: a chat message push
 * arrives here too, and it is not this module's business.
 */
export function keyNeededTopicId(tap: PushNotificationTap): string | null {
  if (!tap || extractPushKind(tap) !== KEY_NEEDED_KIND) return null;
  return extractTopicId(tap);
}

/**
 * Wire the host's delivery listener. Returns an unsubscribe function in every
 * case, including when the host has no support at all — the caller is a React
 * effect and must always have something to return.
 */
export function subscribeKeyNeededPushes(
  host: PushReceivedHost,
  onKeyNeeded: (topicId: string) => void,
): () => void {
  if (!host || typeof host.onPushNotificationReceived !== 'function') {
    return () => {};
  }
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = host.onPushNotificationReceived((tap) => {
      try {
        const topicId = keyNeededTopicId(tap);
        if (topicId) onKeyNeeded(topicId);
      } catch {
        // A malformed payload must never propagate into an OS callback.
      }
    });
  } catch {
    // Host implementation blew up (native module missing, permission race) —
    // delivery routing is simply unavailable for this session.
    return () => {};
  }
  return () => {
    try {
      unsubscribe?.();
    } catch {
      // Best-effort teardown; a throwing host must not break unmount.
    }
  };
}
