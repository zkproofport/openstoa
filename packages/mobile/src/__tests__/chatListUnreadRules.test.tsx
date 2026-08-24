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
 *   hostile    — a `lastSeenId` matching NOTHING in the window (a marker from
 *                a purged message) counts the whole window rather than
 *                throwing or silently returning zero
 *   boundary   — a null viewerId (session mid-restore) must not make every
 *                message count as the viewer's own
 *   authz/UTF-8/very large/race — N/A: pure functions over ids and enums, no
 *                text handling, no I/O, no shared state.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@openstoa/api-types';
import { countUnread, unreadPollInterval } from '../screens/chat/ChatListScreen';

const ME = 'me';
const OTHER = 'other';

function msg(id: string, userId: string, type: ChatMessage['type'] = 'message'): ChatMessage {
  return { id, userId, type } as ChatMessage;
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

  it('INTEGRITY: the walk stops at the last-seen marker', () => {
    const window = [msg('m3', OTHER), msg('m2', OTHER), msg('m1', OTHER)];
    expect(countUnread(window, 'm1', ME)).toBe(2);
    expect(countUnread(window, 'm2', ME)).toBe(1);
    expect(countUnread(window, 'm3', ME)).toBe(0);
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

  it('HOSTILE: a marker matching nothing in the window counts the whole window', () => {
    // The marked message has aged out of the fetch window (or was purged).
    // Counting everything is the safe direction: it over-reports a badge the
    // user can clear by opening the room, where silently returning 0 would
    // hide real messages forever.
    const window = [msg('m3', OTHER), msg('m2', OTHER), msg('m1', OTHER)];
    expect(countUnread(window, 'a-message-that-is-gone', ME)).toBe(3);
  });

  it('BOUNDARY: a null viewerId does not make every message count as mine', () => {
    // Mid-restore the session has no userId yet. `userId === null` must not
    // match a message whose author id is genuinely absent, or the walk would
    // stop on the first row and the badge would be permanently zero.
    const window = [msg('m2', OTHER), msg('m1', OTHER)];
    expect(countUnread(window, undefined, null)).toBe(2);
  });
});
