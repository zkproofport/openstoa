/**
 * Push notification TAP routing (design §13, P-O gap 5), extracted from the
 * React glue so it is unit-testable. Like `./pushRegistration` this module
 * imports NOTHING from React, React Native or the host bridge — the package's
 * vitest runner is a plain node environment (`vitest.config.ts`) and
 * `@openstoa/miniapp-bridge` is a Metro-only `file:` peer that does not resolve
 * there.
 *
 * What it owns: turning a raw host tap into a validated topic id, and holding
 * that id in a LATCH until some part of the navigation tree is alive to consume
 * it. The latch is what makes a cold-start tap survive — the app is launched by
 * the tap, and the chat stack does not exist until several seconds later (boot
 * beat + auth hydrate), so a tap delivered straight into `navigate()` would be
 * dropped on the floor.
 *
 * What it deliberately does NOT own: navigation itself. `OpenStoaTabNavigator`
 * focuses the Chat tab and `ChatListScreen` pushes the room, because those are
 * the only places with a navigation object for the right navigator.
 */

/** One notification tap, mirroring `PushNotificationTap` in the bridge. */
export interface PushNotificationTap {
  id?: string;
  data: Record<string, unknown>;
}

/** The slice of `HostApi` this module needs. The member is optional — a host
 *  without tap support (older binary, standalone shell) simply omits it. */
export interface PushTapHost {
  onPushNotificationTap?(
    listener: (tap: PushNotificationTap) => void,
  ): () => void;
}

/**
 * Topic ids are `uuid` primary keys (`community_topics.id`). Validating the
 * SHAPE — not merely "non-empty string" — is what keeps a malformed or hostile
 * payload from ever reaching `navigate()`: a junk id would otherwise mount
 * ChatRoom against a route param the server can only answer with 404, and a
 * path-shaped one would be interpolated straight into the chat REST URLs.
 */
const TOPIC_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `value` is a topic id we are willing to act on. Shared with
 * `../lib/chatNotifications`, which needs the same answer for a route param
 * rather than for a push payload — same id, same set of things that must never
 * be interpolated into a REST path or handed to the host as a match key.
 */
export function isTopicId(value: unknown): value is string {
  return typeof value === 'string' && TOPIC_ID_RE.test(value.trim());
}

/**
 * Unwrap the Expo push envelope, mirroring `PushPayload.dataDictionary` in the
 * iOS NSE (`proofport-app/ios/OpenStoaNSE/PushPayload.swift`).
 *
 * Expo's push service does NOT splice the message's `data` into the top level
 * of the APNs payload — it nests it under a `body` key, and expo-notifications
 * reads exactly that (`EXNotificationSerializer.m` returns
 * `request.content.userInfo[@"body"]`). By the time a tap reaches JS the host
 * has usually already unwrapped one level, so BOTH shapes occur in the wild and
 * we accept both rather than betting on one. `body` also shows up as a JSON
 * STRING on some Expo/FCM transports, which is why the string branch exists.
 *
 * Anything unrecognised falls through to the value as given, which is what a
 * direct (non-Expo) APNs sender would produce.
 */
export function flattenPushData(data: unknown): Record<string, unknown> {
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;

  const parseJson = (value: string): Record<string, unknown> | null => {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  };

  const top = asRecord(data) ?? (typeof data === 'string' ? parseJson(data) : null);
  if (!top) return {};

  const body = top.body;
  if (body === undefined) return top;
  const nested = asRecord(body) ?? (typeof body === 'string' ? parseJson(body) : null);
  // A `body` that is a number, an array, or unparseable JSON tells us nothing —
  // keep the top level rather than discarding a payload that may be flat.
  return nested ?? top;
}

/**
 * The topic this tap should open, or null when the payload carries none we can
 * trust. Null is ALWAYS a silent no-op for the caller: an absent, empty,
 * non-string or non-uuid `topicId` must never crash and never navigate.
 */
export function extractTopicId(tap: PushNotificationTap): string | null {
  const data = flattenPushData(tap?.data);
  const raw = data.topicId;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return TOPIC_ID_RE.test(trimmed) ? trimmed : null;
}

/**
 * De-duplication key for one tap. The notification id is authoritative when the
 * host supplies one; otherwise we fall back to the payload's own identity so a
 * cold-start replay and the OS listener firing for the SAME notification still
 * collapse into one navigation.
 */
function tapKey(tap: PushNotificationTap, topicId: string): string {
  if (typeof tap.id === 'string' && tap.id.length > 0) return `id:${tap.id}`;
  const data = flattenPushData(tap.data);
  const messageId = typeof data.messageId === 'string' ? data.messageId : '';
  return `topic:${topicId}:${messageId}`;
}

/** Outcome of routing one tap. Returned rather than logged so tests can assert
 *  the branch taken; the subscription callback ignores it. */
export type PushTapResult = 'invalid' | 'duplicate' | 'pending';

/** Taps already routed in this app process, keyed by `tapKey`. */
const routedTaps = new Set<string>();

let pendingTopicId: string | null = null;
const pendingListeners = new Set<() => void>();

function emitPending(): void {
  // Snapshot: a listener may unsubscribe from inside its own callback.
  for (const listener of [...pendingListeners]) {
    try {
      listener();
    } catch {
      // A misbehaving subscriber must not stop the others from being told.
    }
  }
}

/**
 * Route one tap: validate, de-duplicate, and latch the topic for whoever can
 * navigate. Never throws — it runs from a host/OS callback.
 */
export function routePushTap(tap: PushNotificationTap): PushTapResult {
  const topicId = tap ? extractTopicId(tap) : null;
  if (!topicId) return 'invalid';
  const key = tapKey(tap, topicId);
  if (routedTaps.has(key)) return 'duplicate';
  routedTaps.add(key);
  if (pendingTopicId !== topicId) {
    pendingTopicId = topicId;
    emitPending();
  }
  return 'pending';
}

/** The latched topic id, or null. Safe to call at any time. */
export function getPendingChatTopicId(): string | null {
  return pendingTopicId;
}

/**
 * Subscribe to latch changes. Returns an unsubscribe function. Used by the
 * React glue via `useSyncExternalStore`, so the getter above must stay
 * referentially stable for an unchanged latch — it returns a string, so it is.
 */
export function subscribePendingChatTopic(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

/**
 * Consume the latch. Clearing on read is what stops a remount of the chat list
 * from navigating a second time for a tap that was already honoured.
 */
export function takePendingChatTopicId(): string | null {
  const topicId = pendingTopicId;
  if (topicId === null) return null;
  pendingTopicId = null;
  emitPending();
  return topicId;
}

/**
 * Drop the latch without navigating — used when the session turns out to be a
 * guest, so a tap that arrived during boot doesn't fire much later at the
 * moment the user happens to sign in.
 */
export function clearPendingChatTopic(): void {
  takePendingChatTopicId();
}

/**
 * Wire the host's tap listener. Returns an unsubscribe function in every case,
 * including when the host has no tap support at all — the caller is a React
 * effect and must always have something to return.
 */
export function subscribePushTaps(host: PushTapHost): () => void {
  if (!host || typeof host.onPushNotificationTap !== 'function') {
    return () => {};
  }
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = host.onPushNotificationTap((tap) => {
      try {
        routePushTap(tap);
      } catch {
        // A malformed payload must never propagate into an OS callback.
      }
    });
  } catch {
    // Host implementation blew up (native module missing, permission race) —
    // tap routing is simply unavailable for this session.
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

/** Test seam: forget the latch, its subscribers and every routed tap. Never
 *  called in app code. */
export function resetPushTapRouting(): void {
  routedTaps.clear();
  pendingTopicId = null;
  pendingListeners.clear();
}
