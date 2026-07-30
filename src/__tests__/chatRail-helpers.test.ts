// @vitest-environment jsdom
/**
 * `src/lib/chatRail.ts` — pure helpers behind the chat rail redesign.
 *
 * Edge-case matrix rows covered here:
 *   boundary   — open/closed persistence round-trips both directions
 *   ext-failure — localStorage throwing (private browsing / disabled storage)
 *                 degrades to "closed" rather than crashing
 *   contract   — newTabHref picks /chat/{id} for a topic room, /dm/{id} for a
 *                DM room (same topicId, different kind)
 *   dedupe     — isSameRoomAsPath: the exact-match guard that stops the rail
 *                from double-mounting ChatPanel alongside its own standalone
 *                page (see ChatRail.tsx's `suppressPanel`)
 *   boundary   — null room, unrelated pathname, trailing-slash mismatch
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  CHAT_RAIL_OPEN_KEY,
  readRailOpenPreference,
  writeRailOpenPreference,
  newTabHref,
  isSameRoomAsPath,
  type RailRoom,
} from '@/lib/chatRail';

beforeEach(() => {
  window.localStorage.clear();
});

describe('rail open/closed persistence', () => {
  it('BOUNDARY: defaults to closed when nothing was ever written', () => {
    expect(readRailOpenPreference()).toBe(false);
  });

  it('round-trips open → true, close → false', () => {
    writeRailOpenPreference(true);
    expect(readRailOpenPreference()).toBe(true);
    expect(window.localStorage.getItem(CHAT_RAIL_OPEN_KEY)).toBe('1');

    writeRailOpenPreference(false);
    expect(readRailOpenPreference()).toBe(false);
    expect(window.localStorage.getItem(CHAT_RAIL_OPEN_KEY)).toBeNull();
  });

  it('a corrupted stored value reads as closed, not as a crash', () => {
    window.localStorage.setItem(CHAT_RAIL_OPEN_KEY, 'yes-please');
    expect(readRailOpenPreference()).toBe(false);
  });

  it('EXT-FAILURE: a throwing localStorage.getItem degrades to closed', () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error('storage disabled');
    };
    try {
      expect(readRailOpenPreference()).toBe(false);
    } finally {
      Storage.prototype.getItem = original;
    }
  });

  it('EXT-FAILURE: a throwing localStorage.setItem does not throw out of the writer', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota exceeded');
    };
    try {
      expect(() => writeRailOpenPreference(true)).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});

describe('newTabHref', () => {
  it('CONTRACT: a topic room opens /chat/{topicId}', () => {
    const room: RailRoom = { kind: 'topic', topicId: 't-1', title: 'Zoning' };
    expect(newTabHref(room)).toBe('/chat/t-1');
  });

  it('CONTRACT: a dm room opens /dm/{topicId} (same primitive, different chrome)', () => {
    const room: RailRoom = { kind: 'dm', topicId: 'd-1', title: 'bob' };
    expect(newTabHref(room)).toBe('/dm/d-1');
  });
});

describe('isSameRoomAsPath — the mount-uniqueness guard', () => {
  it('BOUNDARY: null room never matches any path', () => {
    expect(isSameRoomAsPath('/chat/t-1', null)).toBe(false);
    expect(isSameRoomAsPath('/', null)).toBe(false);
  });

  it('DEDUPE: matches the exact standalone page for a topic room', () => {
    const room: RailRoom = { kind: 'topic', topicId: 't-1', title: 'Zoning' };
    expect(isSameRoomAsPath('/chat/t-1', room)).toBe(true);
  });

  it('DEDUPE: matches the exact standalone page for a dm room', () => {
    const room: RailRoom = { kind: 'dm', topicId: 'd-1', title: 'bob' };
    expect(isSameRoomAsPath('/dm/d-1', room)).toBe(true);
  });

  it('a topic room does NOT match the /dm/ path even with the same id', () => {
    const room: RailRoom = { kind: 'topic', topicId: 'same-id', title: 'x' };
    expect(isSameRoomAsPath('/dm/same-id', room)).toBe(false);
  });

  it('an unrelated pathname (feed, another room) never matches', () => {
    const room: RailRoom = { kind: 'topic', topicId: 't-1', title: 'x' };
    expect(isSameRoomAsPath('/topics', room)).toBe(false);
    expect(isSameRoomAsPath('/chat/t-2', room)).toBe(false);
  });

  it('a trailing slash is a different string and does not match', () => {
    const room: RailRoom = { kind: 'topic', topicId: 't-1', title: 'x' };
    expect(isSameRoomAsPath('/chat/t-1/', room)).toBe(false);
  });
});
