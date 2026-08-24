/**
 * The server's read-state projection: the badge cap, and the guard that keeps a
 * user with no rooms from producing `IN ()`.
 *
 * WHAT IS DELIBERATELY NOT HERE: the counting RULES (newer-than-cursor, never
 * my own messages, never system rows). They live in one SQL statement, and a
 * unit test would have to stub `db.execute` — which means asserting against a
 * fake that cannot refuse a wrong query, the exact "lenient mock certifies the
 * broken thing" failure this repo has hit four times. They are covered against
 * a real Postgres in `src/__tests__/e2e/chat-read.test.ts`, and each one was
 * mutation-checked there.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   boundary        → cap-1 / cap / cap+1; 0 and 1
 *   hostile         → a non-numeric, negative, NaN or Infinity count
 *   empty/null      → an empty topic list issues NO query (`IN ()` is a syntax
 *                     error, so this is a real 500 for anyone with no rooms)
 *   contract        → every requested topic gets a row back, never a hole
 *   UTF-8 / large / authz / race → N/A: this module takes ids and returns
 *                     numbers; authorization is the caller's and is covered in
 *                     the e2e suite
 */
import { describe, it, expect, vi } from 'vitest';
import {
  capUnread,
  emptyReadState,
  readStatesForTopics,
  UNREAD_COUNT_CAP,
} from '@/lib/chatUnread';

describe('capUnread', () => {
  it('passes a real count through under the cap', () => {
    expect(capUnread(0)).toBe(0);
    expect(capUnread(1)).toBe(1);
    expect(capUnread(UNREAD_COUNT_CAP - 1)).toBe(UNREAD_COUNT_CAP - 1);
    expect(capUnread(UNREAD_COUNT_CAP)).toBe(UNREAD_COUNT_CAP);
  });

  it('clamps above the cap — a badge cannot render more', () => {
    expect(capUnread(UNREAD_COUNT_CAP + 1)).toBe(UNREAD_COUNT_CAP);
    expect(capUnread(10_000)).toBe(UNREAD_COUNT_CAP);
  });

  it('lands on 0 for anything that is not a countable number', () => {
    // A driver handing back a string is the realistic case; `NaN` would render
    // as an empty pill on the web rather than as no badge at all.
    expect(capUnread('7')).toBe(7);
    expect(capUnread('nonsense')).toBe(0);
    expect(capUnread(null)).toBe(0);
    expect(capUnread(undefined)).toBe(0);
    expect(capUnread(-1)).toBe(0);
    expect(capUnread(NaN)).toBe(0);
    // Infinity is 0, not the cap: a nonsense value should show NO badge rather
    // than invent the largest one a badge can display.
    expect(capUnread(Infinity)).toBe(0);
    expect(capUnread(2.9)).toBe(2);
  });
});

describe('emptyReadState', () => {
  it('is never-read, not zero-read: nulls plus a zero count', () => {
    expect(emptyReadState()).toEqual({
      lastReadAt: null,
      lastReadMessageId: null,
      unreadCount: 0,
    });
  });

  it('returns a fresh object each call, so one caller cannot mutate another\'s', () => {
    const a = emptyReadState();
    a.unreadCount = 5;
    expect(emptyReadState().unreadCount).toBe(0);
  });
});

describe('readStatesForTopics — the empty-list guard', () => {
  it('issues NO query for an empty topic list', async () => {
    /*
     * `topic_id IN ()` is a Postgres SYNTAX ERROR, not an empty result. Without
     * the early return, every user who has joined no rooms — which is every
     * user on their first visit — gets a 500 from `GET /api/topics`.
     *
     * The stub REFUSES rather than resolving: a fake that quietly returned []
     * would let the guard be deleted and this test still pass, which is the
     * failure mode a mock is supposed to prevent.
     */
    const db = {
      select: vi.fn(() => {
        throw new Error('readStatesForTopics queried with no topic ids');
      }),
      execute: vi.fn(() => {
        throw new Error('readStatesForTopics queried with no topic ids');
      }),
    } as never;

    await expect(readStatesForTopics(db, 'user-1', [])).resolves.toEqual({});
    expect((db as unknown as { select: ReturnType<typeof vi.fn> }).select).not.toHaveBeenCalled();
    expect((db as unknown as { execute: ReturnType<typeof vi.fn> }).execute).not.toHaveBeenCalled();
  });
});
