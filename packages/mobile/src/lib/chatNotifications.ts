/**
 * Clearing a conversation's delivered notifications when the user reads it.
 *
 * The defect: nothing ever cleared them. A chat push stayed in Notification
 * Center until its own banner was tapped, so opening the app — or the very
 * room the push announced — left the tray holding messages already read, and
 * the pile only ever grew.
 *
 * The rule is PER CONVERSATION, never the whole tray. Opening room A must not
 * take away room B's banner: that banner is the user's only record that B has
 * something waiting. Signal draws the same line (`cancelNotifications(threadId:)`
 * from its conversation controller) and keeps a whole-tray sweep as a separate,
 * category-filtered operation.
 *
 * Like `../hooks/pushTapRouting` this module imports NOTHING from React, React
 * Native or the host bridge, so the package's plain-node vitest runner can
 * exercise it. The host does the actual OS work (`HostApi.clearTopicNotifications`
 * → `proofport-app/src/openstoa-host/pushClearing.ts`); what lives here is which
 * conversation is open and when to ask.
 *
 * WHY THE ACTIVE ROOM IS TRACKED AT ALL, rather than clearing once on entry:
 * a person reads a room, backgrounds the app, receives three more messages for
 * that same room, then comes back to the app still sitting in it. React
 * Navigation fires no `focus` for that — the screen never blurred — so entry
 * alone would leave those three in the tray while they are on screen. The
 * app-foreground path (`useChatNotificationClearing`) re-clears whatever room
 * is open, and this module is what remembers which one that is.
 */
import { isTopicId } from '../hooks/pushTapRouting';

/** The slice of `HostApi` this module needs; absent on a host without support. */
export interface ChatNotificationHost {
  clearTopicNotifications?(topicId: string): Promise<void>;
}

/** The chat room currently on screen, or null when none is. */
let activeTopicId: string | null = null;

/**
 * Ask the host to clear one conversation's notifications. Never throws and
 * never rejects: every caller is a navigation callback or an OS lifecycle
 * listener, and clearing is a courtesy — a host that cannot do it must not
 * take the screen transition down with it.
 *
 * Returns whether the request was actually dispatched, so a test can assert
 * the branch rather than inferring it from a spy that may not have been called
 * for an entirely different reason.
 */
export function clearTopicNotifications(
  host: ChatNotificationHost | null | undefined,
  topicId: unknown,
): boolean {
  if (!host || typeof host.clearTopicNotifications !== 'function') return false;
  // Same shape rule as tap routing: a route param that is not a topic id is a
  // bug upstream, and turning it into a host call is how a wildcard match gets
  // invented later.
  if (!isTopicId(topicId)) return false;
  try {
    void Promise.resolve(host.clearTopicNotifications(topicId.trim())).catch(() => {
      // No permission, no OS support, native module missing.
    });
  } catch {
    // A host implementation that throws synchronously.
  }
  return true;
}

/**
 * The user opened a chat room: remember it and clear what it already delivered.
 *
 * An unusable id still CLEARS the previously-active room's claim, rather than
 * leaving a stale one behind that a later foreground would clear on behalf of
 * a screen nobody is looking at.
 */
export function enterChatRoom(
  host: ChatNotificationHost | null | undefined,
  topicId: unknown,
): void {
  activeTopicId = isTopicId(topicId) ? topicId.trim() : null;
  clearTopicNotifications(host, topicId);
}

/**
 * The user left a chat room.
 *
 * Guarded on identity rather than clearing unconditionally: pushing room B on
 * top of room A delivers B's `focus` BEFORE A's `blur` on some navigators, and
 * an unconditional clear there would forget B the moment it opened.
 */
export function leaveChatRoom(topicId: unknown): void {
  if (!isTopicId(topicId)) return;
  if (activeTopicId === topicId.trim()) activeTopicId = null;
}

/** The chat room currently on screen, or null. */
export function getActiveChatTopicId(): string | null {
  return activeTopicId;
}

/**
 * Re-clear whatever room is open. Called when the app returns to the
 * foreground — see the note at the top of this file for why entry alone is not
 * enough. A no-op when no room is open, which is the common case.
 */
export function clearActiveChatNotifications(
  host: ChatNotificationHost | null | undefined,
): boolean {
  if (activeTopicId === null) return false;
  return clearTopicNotifications(host, activeTopicId);
}

/** Test seam: forget the active room. Never called in app code. */
export function resetChatNotifications(): void {
  activeTopicId = null;
}
