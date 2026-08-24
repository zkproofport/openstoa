/**
 * The read cursor itself: what advances it, what must not, and what it hands
 * the two screens that read it.
 *
 * THE DEFECT THIS EXISTS FOR: entering a room recorded nothing. The chat list
 * owned the only marker and wrote it from a row's `onPress`, so arriving in a
 * room by tapping a push notification — which goes straight to
 * `navigation.navigate` — left the marker untouched, and backing out re-badged
 * every message the user had just read. The fix moves the writer to
 * `ChatRoomScreen`; this file pins the store's own rules, and
 * `chatRoomMarksRead.test.tsx` pins that the room actually calls it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract     — a mark is readable back, by cursor and by iso; subscribers
 *                  are told; the version snapshot moves
 *   integrity    — MONOTONIC: an older message never moves the cursor back
 *   hostile      — a provisional (`pending-`) id is refused outright, because
 *                  its timestamp is the DEVICE clock and its id is one the
 *                  list will never see
 *   empty/null   — empty topic id, missing message, missing id, missing
 *                  `createdAt`, unparseable `createdAt`, each rejected
 *                  separately rather than collapsed
 *   boundary     — the same message twice is not a change (no wasted render);
 *                  a same-millisecond message with a DIFFERENT id does advance
 *   race         — a subscriber that throws does not stop the others, and one
 *                  that unsubscribes from inside its own callback is safe
 *   authz/UTF-8/very large — N/A: an in-process map of ids and timestamps, no
 *                  user text, no I/O, no authorization surface.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getChatReadCursor,
  getChatReadCursorIso,
  getChatReadCursorVersion,
  markChatRead,
  newestReadable,
  resetChatReadCursors,
  subscribeChatReadCursors,
} from '../lib/chatReadCursor';

const TOPIC = '11111111-2222-4333-8444-555555555555';

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

function row(id: string, seconds: number) {
  return { id, createdAt: at(seconds) };
}

beforeEach(() => {
  resetChatReadCursors();
});

describe('markChatRead — what moves the cursor', () => {
  it('CONTRACT: a mark is readable back as a cursor and as an iso', () => {
    expect(markChatRead(TOPIC, row('m2', 20))).toBe(true);
    expect(getChatReadCursor(TOPIC)).toEqual({ messageId: 'm2', createdAt: at(20) });
    // The iso accessor is the room's `?since=` anchor — same fact, one field.
    expect(getChatReadCursorIso(TOPIC)).toBe(at(20));
  });

  it('CONTRACT: an unmarked topic has no cursor, rather than a falsy one', () => {
    expect(getChatReadCursor(TOPIC)).toBeUndefined();
    expect(getChatReadCursorIso(TOPIC)).toBeUndefined();
  });

  it('CONTRACT: cursors are per topic and do not leak into each other', () => {
    const other = '22222222-3333-4444-8555-666666666666';
    markChatRead(TOPIC, row('m1', 10));
    expect(getChatReadCursor(other)).toBeUndefined();
  });

  it('INTEGRITY: an older message does not move the cursor back', () => {
    // History paging and delta-sync merges can briefly put an older row last.
    // Letting that win would resurrect a badge the user had already cleared.
    markChatRead(TOPIC, row('m5', 50));
    expect(markChatRead(TOPIC, row('m1', 10))).toBe(false);
    expect(getChatReadCursor(TOPIC)?.messageId).toBe('m5');
  });

  it('BOUNDARY: re-marking the same message is not a change', () => {
    markChatRead(TOPIC, row('m2', 20));
    const before = getChatReadCursorVersion();
    expect(markChatRead(TOPIC, row('m2', 20))).toBe(false);
    expect(getChatReadCursorVersion(), 'an idle re-mark must not force a render').toBe(before);
  });

  it('BOUNDARY: a different message in the same millisecond still advances', () => {
    // A burst shares a timestamp. Refusing here would strand the cursor on
    // whichever of them the room happened to see first.
    markChatRead(TOPIC, row('m2', 20));
    expect(markChatRead(TOPIC, row('m3', 20))).toBe(true);
    expect(getChatReadCursor(TOPIC)?.messageId).toBe('m3');
  });

  it('HOSTILE: a provisional id is refused', () => {
    // `pending-…` rows are on screen before the server has stored them. Their
    // id is one the list will never receive, and their `createdAt` is the
    // DEVICE clock — a phone running an hour fast would park the cursor an hour
    // ahead and silently mark an hour of real messages read.
    expect(markChatRead(TOPIC, { id: 'pending-0000000001', createdAt: at(90) })).toBe(false);
    expect(getChatReadCursor(TOPIC)).toBeUndefined();
  });

  it('EMPTY: an absent topic id, message, id or timestamp is each rejected', () => {
    expect(markChatRead('', row('m1', 10))).toBe(false);
    expect(markChatRead('   ', row('m1', 10))).toBe(false);
    expect(markChatRead(undefined, row('m1', 10))).toBe(false);
    expect(markChatRead(TOPIC, null)).toBe(false);
    expect(markChatRead(TOPIC, undefined)).toBe(false);
    expect(markChatRead(TOPIC, { createdAt: at(10) })).toBe(false);
    expect(markChatRead(TOPIC, { id: '', createdAt: at(10) })).toBe(false);
    expect(markChatRead(TOPIC, { id: 'm1' })).toBe(false);
    expect(markChatRead(TOPIC, { id: 'm1', createdAt: '' })).toBe(false);
    expect(markChatRead(TOPIC, { id: 'm1', createdAt: 'not-a-date' })).toBe(false);
    expect(markChatRead(TOPIC, { id: 'm1', createdAt: 1700000000000 })).toBe(false);
    expect(getChatReadCursor(TOPIC)).toBeUndefined();
  });
});

describe('subscribeChatReadCursors — telling the list a room was read', () => {
  it('CONTRACT: a subscriber is told, and the version snapshot moves', () => {
    const seen: number[] = [];
    const unsubscribe = subscribeChatReadCursors(() => seen.push(getChatReadCursorVersion()));
    markChatRead(TOPIC, row('m1', 10));
    markChatRead(TOPIC, row('m2', 20));
    expect(seen.length).toBe(2);
    expect(seen[1]).toBeGreaterThan(seen[0]);
    unsubscribe();
    markChatRead(TOPIC, row('m3', 30));
    expect(seen.length, 'an unsubscribed listener must stop hearing').toBe(2);
  });

  it('CONTRACT: a rejected mark tells nobody', () => {
    const listener = vi.fn();
    subscribeChatReadCursors(listener);
    markChatRead(TOPIC, { id: 'pending-0000000001', createdAt: at(90) });
    expect(listener).not.toHaveBeenCalled();
  });

  it('RACE: a throwing subscriber does not stop the others', () => {
    const good = vi.fn();
    subscribeChatReadCursors(() => {
      throw new Error('subscriber blew up');
    });
    subscribeChatReadCursors(good);
    expect(() => markChatRead(TOPIC, row('m1', 10))).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('RACE: a subscriber may unsubscribe from inside its own callback', () => {
    const other = vi.fn();
    const unsubscribe = subscribeChatReadCursors(() => unsubscribe());
    subscribeChatReadCursors(other);
    expect(() => markChatRead(TOPIC, row('m1', 10))).not.toThrow();
    expect(other).toHaveBeenCalledTimes(1);
  });
});

describe('newestReadable — which row a screen should record', () => {
  it('CONTRACT: oldest-first (the room order) returns the last row', () => {
    const messages = [row('m1', 10), row('m2', 20), row('m3', 30)];
    expect(newestReadable(messages)?.id).toBe('m3');
  });

  it('CONTRACT: newest-first (the list order) returns the first row', () => {
    const messages = [row('m3', 30), row('m2', 20), row('m1', 10)];
    expect(newestReadable(messages, true)?.id).toBe('m3');
  });

  it('INTEGRITY: provisional rows are stepped over, not stopped at', () => {
    // Sending three photos leaves three pending rows on top of real history.
    // The cursor should still reach the real row underneath them.
    const messages = [
      row('m1', 10),
      { id: 'pending-0000000001', createdAt: at(90) },
      { id: 'pending-0000000002', createdAt: at(91) },
    ];
    expect(newestReadable(messages)?.id).toBe('m1');
  });

  it('BOUNDARY: a window with nothing recordable in it returns undefined', () => {
    expect(newestReadable([])).toBeUndefined();
    expect(newestReadable([{ id: 'pending-0000000001', createdAt: at(90) }])).toBeUndefined();
    expect(newestReadable([{ id: 'm1' }])).toBeUndefined();
  });
});
