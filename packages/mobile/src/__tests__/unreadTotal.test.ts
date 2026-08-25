/**
 * One number, three badges.
 *
 * WHAT WAS MISSING. There were no badges at all. The app icon carried none — the
 * host could set it to ZERO and nothing ever set it to anything else — so a push
 * that arrived while the app was closed left nothing behind once its
 * notification was swiped away. The host's OpenStoa tab carried none, so opening
 * the app said nothing. And the mini-app's own Chat tab carried none, so even
 * inside OpenStoa the only way to find a waiting message was to open the Chat
 * tab and look. The room ROWS had shown a per-room count for a while, which is
 * what made the gap easy to miss: the number existed, it just never travelled up.
 *
 * WHY ONE FUNCTION. Three badges that disagree are worse than none — an icon
 * saying 3 over a tab saying 1 is a bug the reader can see and cannot explain.
 * The three surfaces differ only in where they draw; the total and the label
 * come from here.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → rooms add up; the label matches the shared cap
 *   empty      → no rooms, an empty list, null, undefined → no badge
 *   boundary   → 1, 99 and 100 across the display cap
 *   hostile    → NaN, Infinity, negative, fractional, string, null rows
 *   integrity  → a bad row contributes zero rather than poisoning the sum
 *   integrity  → the label is `undefined`, never '0' or '', when there is none
 */
import { describe, it, expect } from 'vitest';
import { unreadTotal, unreadTabBadge } from '../lib/unreadTotal';

const r = (unreadCount: unknown) => ({ unreadCount }) as { unreadCount?: number };

describe('one number, three badges', () => {
  it('CONTRACT: rooms add up', () => {
    expect(unreadTotal([r(3), r(1), r(10)])).toBe(14);
  });

  it('CONTRACT: the label uses the shared cap, so a tab and a row agree', () => {
    expect(unreadTabBadge([r(3)])).toBe('3');
    expect(unreadTabBadge([r(50), r(60)])).toBe('99+');
  });

  it.each([
    ['an empty list', []],
    ['null', null],
    ['undefined', undefined],
    ['rooms with nothing unread', [r(0), r(0)]],
  ])('EMPTY: %s is zero, and draws NO badge', (_label, rooms) => {
    expect(unreadTotal(rooms)).toBe(0);
    /*
     * `undefined`, not '0' and not ''. React Navigation renders a literal "0"
     * for the first and a bare dot for the second — a badge with nothing behind
     * it draws the eye to a tab that has nothing to show.
     */
    expect(unreadTabBadge(rooms)).toBeUndefined();
  });

  it.each([
    ['one', 1, '1'],
    ['ninety-nine, the last exact figure', 99, '99'],
    ['one hundred, the first capped one', 100, '99+'],
  ])('BOUNDARY: %s', (_label, n, expected) => {
    expect(unreadTabBadge([r(n)])).toBe(expected);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative', -5],
    ['a numeric string', '7'],
    ['null', null],
    ['undefined', undefined],
    ['an object', { n: 1 }],
  ])('HOSTILE: a room whose count is %s contributes zero', (_label, value) => {
    // This number reaches a native badge API. `setBadgeCount(NaN)` either
    // throws inside a platform module or paints something absurd on the home
    // screen, so a bad row is dropped rather than allowed into the sum.
    expect(unreadTotal([r(value)])).toBe(0);
  });

  it('INTEGRITY: one bad row does not poison the good ones', () => {
    expect(unreadTotal([r(3), r(Number.NaN), r(2)])).toBe(5);
  });

  it('INTEGRITY: a fractional count is floored, never rounded up', () => {
    // 0.9 unread messages is not one waiting message.
    expect(unreadTotal([r(0.9)])).toBe(0);
    expect(unreadTotal([r(3.7)])).toBe(3);
  });

  it('HOSTILE: rows that are not objects at all are skipped', () => {
    const junk = [null, undefined, 42, 'x', r(4)] as unknown as { unreadCount?: number }[];
    expect(unreadTotal(junk)).toBe(4);
  });

  it('HOSTILE: a non-array is zero rather than a throw', () => {
    expect(unreadTotal({ topics: [r(3)] } as unknown as { unreadCount?: number }[])).toBe(0);
  });
});
