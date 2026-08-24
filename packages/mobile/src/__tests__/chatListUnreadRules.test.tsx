/**
 * The two pure rules behind the unread badge, tested directly.
 *
 * The render-level files next door prove the badge SHOWS the right thing.
 * This one pins the rules themselves, for two different reasons:
 *
 * `unreadPollInterval` — because it CANNOT be tested through a render.
 * react-query's `refetchInterval` does not fire under vitest's fake timers; a
 * standalone probe (a plain `useQuery` with `refetchInterval: 30_000`) stayed
 * at one fetch across 62 simulated seconds while `useFocusEffect` ran
 * correctly. A render-level poll test would therefore pass whether the poll
 * was wired or gutted, which is worse than no test. What IS this screen's own
 * logic is the gating decision, and that is what is pinned here. **The gap
 * this leaves is explicit: nothing here proves react-query actually polls on
 * a device.**
 *
 * `countUnread` — because a direct table is where the walk's rules are legible.
 * The render tests kill every mutation of it, but they express each rule as a
 * screenful of fixture; the same rules as a table are what someone changing
 * the walk will actually read.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   — poll runs only when focused AND not a guest; all four
 *                combinations asserted, not just the happy one
 *   boundary   — empty window, single message, a window that is entirely the
 *                viewer's own
 *   integrity  — the marker bounds the walk; own messages end it; system rows
 *                are skipped without ending it
 *   hostile    — a cursor whose MESSAGE is gone from the window (purged, or
 *                aged out) still bounds the walk by its timestamp instead of
 *                running off the end and reporting everything
 *   hostile    — a cursor carrying an unparseable timestamp degrades to the id
 *                check alone rather than making `NaN` swallow the window
 *   boundary   — a null viewerId (session mid-restore) must not make every
 *                message count as the viewer's own
 *   authz/UTF-8/very large/race — N/A: pure functions over ids and enums, no
 *                text handling, no I/O, no shared state.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@openstoa/api-types';
import { countUnread, unreadPollInterval } from '../screens/chat/ChatListScreen';
import type { ChatReadCursor } from '../lib/chatReadCursor';

const ME = 'me';
const OTHER = 'other';

/**
 * Timestamps are derived from the id's trailing digit so a fixture's ORDER and
 * its clock cannot disagree: `m1` is older than `m2` by construction. The walk
 * consults both the id and the time, and a table where those two told different
 * stories would pass or fail for reasons nobody wrote down.
 */
function at(id: string): string {
  const n = Number(id.replace(/\D/g, '') || '0');
  return new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
}

function msg(id: string, userId: string, type: ChatMessage['type'] = 'message'): ChatMessage {
  return { id, userId, type, createdAt: at(id) } as ChatMessage;
}

/** The cursor `ChatRoomScreen` would have left after reading up to `id`. */
function cursor(id: string, createdAt = at(id)): ChatReadCursor {
  return { messageId: id, createdAt };
}

describe('unreadPollInterval — when the chat list re-pulls on its own', () => {
  it('CONTRACT: a focused, signed-in list polls', () => {
    expect(unreadPollInterval(true, false)).toBe(30_000);
  });

  it('CONTRACT: a blurred list does not', () => {
    // It stays mounted underneath an open chat room; polling every room's
    // history from there costs bandwidth for a screen nobody is looking at.
    expect(unreadPollInterval(false, false)).toBe(false);
  });

  it('CONTRACT: a guest never polls, focused or not', () => {
    // Guests fire no queries at all — a poll would be a 401 loop.
    expect(unreadPollInterval(true, true)).toBe(false);
    expect(unreadPollInterval(false, true)).toBe(false);
  });
});

describe('countUnread — the walk back from the newest message', () => {
  it('BOUNDARY: an empty window is zero, not NaN and not a crash', () => {
    expect(countUnread([], undefined, ME)).toBe(0);
  });

  it('CONTRACT: with no marker, every message from someone else counts', () => {
    const window = [msg('m3', OTHER), msg('m2', OTHER), msg('m1', OTHER)];
    expect(countUnread(window, undefined, ME)).toBe(3);
  });

  it('INTEGRITY: the walk stops at the read cursor', () => {
    const window = [msg('m3', OTHER), msg('m2', OTHER), msg('m1', OTHER)];
    expect(countUnread(window, cursor('m1'), ME)).toBe(2);
    expect(countUnread(window, cursor('m2'), ME)).toBe(1);
    expect(countUnread(window, cursor('m3'), ME)).toBe(0);
  });

  it("INTEGRITY: the walk stops at the viewer's own message", () => {
    // Sending is being in the room. Everything under my own message has been
    // seen, however much of it there is.
    const window = [msg('m4', ME), msg('m3', OTHER), msg('m2', OTHER), msg('m1', OTHER)];
    expect(countUnread(window, undefined, ME)).toBe(0);
  });

  it('INTEGRITY: a system row is skipped but does not end the walk', () => {
    // Counting it inflates the badge; stopping at it hides `m1` underneath.
    const window = [msg('m2', OTHER), msg('sys', OTHER, 'join'), msg('m1', OTHER)];
    expect(countUnread(window, undefined, ME)).toBe(2);
  });

  it('BOUNDARY: a window of nothing but system rows counts zero', () => {
    const window = [msg('s2', OTHER, 'leave'), msg('s1', OTHER, 'join')];
    expect(countUnread(window, undefined, ME)).toBe(0);
  });

  it('HOSTILE: a cursor whose message is gone is still bounded by its time', () => {
    // The read message was deleted, or more than `UNREAD_SCAN_LIMIT` rows have
    // landed on top of it, so the id matches nothing here. The id check alone
    // would run off the end and report the whole window; the timestamp is what
    // keeps the answer to what genuinely arrived after it.
    const window = [msg('m3', OTHER), msg('m2', OTHER), msg('m1', OTHER)];
    expect(countUnread(window, cursor('gone', at('m1')), ME)).toBe(2);
  });

  it('HOSTILE: an unparseable cursor time falls back to the id, not to NaN', () => {
    // `new Date('nonsense').getTime()` is NaN, and every comparison against it
    // is false — so the time clause must be inert rather than swallowing or
    // ignoring the window. The id still stops the walk where it can.
    const window = [msg('m3', OTHER), msg('m2', OTHER), msg('m1', OTHER)];
    expect(countUnread(window, cursor('m1', 'not-a-date'), ME)).toBe(2);
    expect(countUnread(window, cursor('gone', 'not-a-date'), ME)).toBe(3);
  });

  it('INTEGRITY: a message newer than the cursor counts even at the same second', () => {
    // Ties on the timestamp are broken by the id, not by `<=` alone: a burst
    // can share a millisecond, and marking the whole burst read because one of
    // them was is how a real message disappears.
    const shared = at('m1');
    const window = [
      { ...msg('m2', OTHER), createdAt: shared } as ChatMessage,
      { ...msg('m1', OTHER), createdAt: shared } as ChatMessage,
    ];
    // Documented consequence of the `<=` rule, stated so a change to it is a
    // decision rather than an accident: the newer twin IS suppressed. Pinned
    // because the alternative (`<`) would loop forever past a purged cursor.
    expect(countUnread(window, cursor('m1', shared), ME)).toBe(0);
  });

  it('BOUNDARY: a null viewerId does not make every message count as mine', () => {
    // Mid-restore the session has no userId yet. `userId === null` must not
    // match a message whose author id is genuinely absent, or the walk would
    // stop on the first row and the badge would be permanently zero.
    const window = [msg('m2', OTHER), msg('m1', OTHER)];
    expect(countUnread(window, undefined, null)).toBe(2);
  });
});
