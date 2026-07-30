/**
 * Popped-out chat width preference (`/chat/[topicId]`, `/dm/[topicId]`) — the
 * reader's own choice of how much of the window the conversation content
 * should use. Kept dependency-free like `chatRail.ts`'s open/closed
 * preference, and for the same reason: every rule here is unit-testable
 * without mounting a component.
 *
 * Default is 'full' — these pages are opened as a genuine separate browser
 * tab (see `BareChatShell.tsx`'s module doc), so the window itself is
 * already the outer size control; capping the content by default would
 * fight that. 'narrow' and 'wide' exist for a reader who prefers a shorter
 * reading line even on a wide window — `BareChatShell` puts the control for
 * this directly in the popped-out header.
 */

export type ChatWidthMode = 'narrow' | 'wide' | 'full';

export const CHAT_WIDTH_KEY = 'openstoa:chat-width';

const WIDTH_PX: Record<ChatWidthMode, number | null> = {
  narrow: 640,
  // Matches the previous hardcoded cap (860px) so a reader who picks this
  // gets exactly the reading measure the shell used to force on everyone.
  wide: 860,
  full: null,
};

const VALID_MODES: readonly string[] = ['narrow', 'wide', 'full'];

/** Pixel cap for a mode, or `null` for "no cap" (fill the window). */
export function chatWidthPx(mode: ChatWidthMode): number | null {
  return WIDTH_PX[mode];
}

/**
 * Read the persisted width choice. A missing key, a corrupted/unrecognized
 * value, or storage being unavailable (private browsing, disabled storage)
 * all fall back to 'full' — the required default — rather than throwing.
 */
export function readChatWidthPreference(): ChatWidthMode {
  try {
    const v = window.localStorage.getItem(CHAT_WIDTH_KEY);
    return v != null && VALID_MODES.includes(v) ? (v as ChatWidthMode) : 'full';
  } catch {
    return 'full';
  }
}

/** Persist the width choice. Best-effort — a write failure just means the
 *  next load falls back to 'full' again. */
export function writeChatWidthPreference(mode: ChatWidthMode): void {
  try {
    window.localStorage.setItem(CHAT_WIDTH_KEY, mode);
  } catch {
    // storage unavailable — the preference simply does not persist
  }
}
