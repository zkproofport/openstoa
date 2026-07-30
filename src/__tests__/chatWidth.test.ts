// @vitest-environment jsdom
/**
 * `src/lib/chatWidth.ts` — the popped-out chat width preference (narrow /
 * wide / full). Pure logic, same style as `chatRail.test.ts`'s coverage of
 * the sibling open/closed preference.
 *
 * Edge-case matrix rows covered here:
 *   boundary  — each of the three valid modes round-trips
 *   default   — the required default is 'full', not the previous hardcoded cap
 *   hostile   — a corrupted/unrecognized stored value falls back to 'full'
 *               rather than throwing or passing the raw string through
 *   empty     — no stored key at all falls back to 'full'
 *   ext-failure — storage unavailable (throws on get/set) degrades to the
 *               default / a silent no-op, never throws into the caller
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  CHAT_WIDTH_KEY,
  chatWidthPx,
  readChatWidthPreference,
  writeChatWidthPreference,
  type ChatWidthMode,
} from '@/lib/chatWidth';

beforeEach(() => {
  window.localStorage.clear();
});

describe('chatWidthPx', () => {
  it('BOUNDARY: full has no cap (null); narrow/wide each have a distinct positive cap', () => {
    expect(chatWidthPx('full')).toBeNull();
    expect(chatWidthPx('narrow')).toBeGreaterThan(0);
    expect(chatWidthPx('wide')).toBeGreaterThan(0);
    expect(chatWidthPx('narrow')).toBeLessThan(chatWidthPx('wide')!);
  });
});

describe('readChatWidthPreference', () => {
  it('EMPTY: no stored key defaults to full', () => {
    expect(readChatWidthPreference()).toBe('full');
  });

  it('BOUNDARY: each valid mode round-trips through read/write', () => {
    const modes: ChatWidthMode[] = ['narrow', 'wide', 'full'];
    for (const mode of modes) {
      writeChatWidthPreference(mode);
      expect(readChatWidthPreference()).toBe(mode);
    }
  });

  it('HOSTILE: a corrupted stored value falls back to full, not a throw or a passthrough', () => {
    window.localStorage.setItem(CHAT_WIDTH_KEY, '<script>alert(1)</script>');
    expect(readChatWidthPreference()).toBe('full');
  });

  it('EXT-FAILURE: a storage read that throws (private browsing) falls back to full', () => {
    const orig = window.localStorage.getItem;
    window.localStorage.getItem = () => {
      throw new Error('storage disabled');
    };
    expect(() => readChatWidthPreference()).not.toThrow();
    expect(readChatWidthPreference()).toBe('full');
    window.localStorage.getItem = orig;
  });
});

describe('writeChatWidthPreference', () => {
  it('EXT-FAILURE: a storage write that throws is swallowed, not propagated', () => {
    const orig = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error('quota exceeded');
    };
    expect(() => writeChatWidthPreference('narrow')).not.toThrow();
    window.localStorage.setItem = orig;
  });
});
