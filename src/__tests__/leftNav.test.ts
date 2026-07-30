// @vitest-environment jsdom
/**
 * `src/lib/leftNav.ts` — pure logic backing `LeftSidebar.tsx`'s collapsible
 * groups (persistence) and its two right-aligned figure treatments (count /
 * unread badge). Same style as `chatWidth.test.ts`'s coverage of the sibling
 * open/closed preference.
 *
 * Edge-case matrix rows covered here:
 *   boundary    — each group id round-trips through read/write; badge caps
 *                 exactly at "99+" past 99 (99 passes through, 100 caps)
 *   hostile     — corrupted JSON, a non-object payload, and a payload with
 *                 non-boolean values for known keys all fall back safely
 *                 (whole-default or per-key default) rather than throwing
 *                 or passing a bad value through
 *   empty       — no stored key at all falls back to the all-open default;
 *                 a partial payload (only one key recorded) does not blank
 *                 out the other two group's default
 *   ext-failure — storage unavailable (throws on get/set) degrades to the
 *                 default / a silent no-op, never throws into the caller
 *   contract    — a count of 0 renders "0" (distinct from no count at all,
 *                 which callers represent by never rendering the span);
 *                 a badge count of 0 renders no badge (unread=0 means
 *                 nothing to flag, a different signal from "no count
 *                 feature on this row")
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_LEFT_NAV_GROUP_STATE,
  LEFT_NAV_GROUPS_KEY,
  formatNavBadgeCount,
  formatNavCount,
  readLeftNavGroupState,
  writeLeftNavGroupState,
  type LeftNavGroupState,
} from '@/lib/leftNav';

beforeEach(() => {
  window.localStorage.clear();
});

describe('readLeftNavGroupState', () => {
  it('EMPTY: no stored key defaults to all-open', () => {
    expect(readLeftNavGroupState()).toEqual(DEFAULT_LEFT_NAV_GROUP_STATE);
  });

  it('BOUNDARY: each group round-trips through read/write independently', () => {
    const states: LeftNavGroupState[] = [
      { browse: false, conversations: true, categories: true },
      { browse: true, conversations: false, categories: true },
      { browse: true, conversations: true, categories: false },
    ];
    for (const state of states) {
      writeLeftNavGroupState(state);
      expect(readLeftNavGroupState()).toEqual(state);
    }
  });

  it('EMPTY: a partial stored payload fills in the default for the missing keys, not false', () => {
    window.localStorage.setItem(LEFT_NAV_GROUPS_KEY, JSON.stringify({ browse: false }));
    expect(readLeftNavGroupState()).toEqual({ browse: false, conversations: true, categories: true });
  });

  it('HOSTILE: corrupted (non-JSON) stored value falls back to the all-open default, not a throw', () => {
    window.localStorage.setItem(LEFT_NAV_GROUPS_KEY, '<script>alert(1)</script>');
    expect(readLeftNavGroupState()).toEqual(DEFAULT_LEFT_NAV_GROUP_STATE);
  });

  it('HOSTILE: a JSON array (valid JSON, not an object of booleans) falls back to the default', () => {
    window.localStorage.setItem(LEFT_NAV_GROUPS_KEY, JSON.stringify(['browse', 'categories']));
    expect(readLeftNavGroupState()).toEqual(DEFAULT_LEFT_NAV_GROUP_STATE);
  });

  it('HOSTILE: non-boolean values for a known key fall back to that key\'s default, ignoring the bad value', () => {
    window.localStorage.setItem(LEFT_NAV_GROUPS_KEY, JSON.stringify({ browse: 'yes', conversations: 1, categories: null }));
    expect(readLeftNavGroupState()).toEqual(DEFAULT_LEFT_NAV_GROUP_STATE);
  });

  it('EXT-FAILURE: a storage read that throws (private browsing) falls back to the default, never throws', () => {
    const orig = window.localStorage.getItem;
    window.localStorage.getItem = () => {
      throw new Error('storage disabled');
    };
    expect(() => readLeftNavGroupState()).not.toThrow();
    expect(readLeftNavGroupState()).toEqual(DEFAULT_LEFT_NAV_GROUP_STATE);
    window.localStorage.getItem = orig;
  });
});

describe('writeLeftNavGroupState', () => {
  it('EXT-FAILURE: a storage write that throws is swallowed, not propagated', () => {
    const orig = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error('quota exceeded');
    };
    expect(() => writeLeftNavGroupState({ browse: false, conversations: false, categories: false })).not.toThrow();
    window.localStorage.setItem = orig;
  });
});

describe('formatNavCount', () => {
  it('CONTRACT: 0 renders as the string "0" — a real, distinct value, not "no count"', () => {
    expect(formatNavCount(0)).toBe('0');
  });

  it('EMPTY: undefined (the caller has no count data for this row) renders null', () => {
    expect(formatNavCount(undefined)).toBeNull();
  });

  it('BOUNDARY: a large real count round-trips as its own decimal string', () => {
    expect(formatNavCount(1204)).toBe('1204');
  });

  it('HOSTILE: a negative or NaN input degrades to "0" rather than a nonsensical negative figure', () => {
    expect(formatNavCount(-5)).toBe('0');
    expect(formatNavCount(NaN)).toBeNull();
  });
});

describe('formatNavBadgeCount', () => {
  it('EMPTY: undefined renders no badge', () => {
    expect(formatNavBadgeCount(undefined)).toBeNull();
  });

  it('CONTRACT: 0 unread renders no badge — a different signal from "no count data"', () => {
    expect(formatNavBadgeCount(0)).toBeNull();
  });

  it('BOUNDARY: 1 renders "1"; 99 renders "99" (the cap boundary itself still passes through)', () => {
    expect(formatNavBadgeCount(1)).toBe('1');
    expect(formatNavBadgeCount(99)).toBe('99');
  });

  it('BOUNDARY: 100 (cap+1) renders "99+", and so does a much larger count', () => {
    expect(formatNavBadgeCount(100)).toBe('99+');
    expect(formatNavBadgeCount(9999)).toBe('99+');
  });

  it('HOSTILE: a negative or NaN input renders no badge', () => {
    expect(formatNavBadgeCount(-3)).toBeNull();
    expect(formatNavBadgeCount(NaN)).toBeNull();
  });
});
