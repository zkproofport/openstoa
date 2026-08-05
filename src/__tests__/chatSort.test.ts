import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sortConversationsByActivity } from '@/lib/chatSort';

/**
 * Web listed rooms in creation order while the mini-app sorted by latest
 * message, so one account saw two different conversation lists depending on the
 * device — and on web the room you were just talking in sat wherever it happened
 * to fall. One rule, two clients.
 */
const room = (id: string, createdAt = '2026-01-01T00:00:00Z') => ({ id, createdAt });

describe('sortConversationsByActivity', () => {
  it('newest activity first', () => {
    const rooms = [room('a'), room('b'), room('c')];
    const last: Record<string, string> = {
      a: '2026-08-01T10:00:00Z',
      b: '2026-08-05T10:00:00Z',
      c: '2026-08-03T10:00:00Z',
    };
    expect(sortConversationsByActivity(rooms, (r) => last[r.id]).map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('a room nobody has spoken in sorts BELOW every room that has activity', () => {
    // Even when it was created much more recently — a brand-new empty room
    // jumping above a live conversation is the surprising outcome.
    const rooms = [room('silent-but-new', '2026-08-05T23:00:00Z'), room('busy', '2020-01-01T00:00:00Z')];
    const last: Record<string, string> = { busy: '2026-08-01T00:00:00Z' };
    expect(sortConversationsByActivity(rooms, (r) => last[r.id]).map((r) => r.id)).toEqual([
      'busy',
      'silent-but-new',
    ]);
  });

  it('silent rooms fall back to creation time, newest first', () => {
    const rooms = [room('old', '2026-01-01T00:00:00Z'), room('new', '2026-08-01T00:00:00Z')];
    expect(sortConversationsByActivity(rooms, () => null).map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('BOUNDARY: empty and single-item lists are returned intact', () => {
    expect(sortConversationsByActivity([], () => null)).toEqual([]);
    expect(sortConversationsByActivity([room('only')], () => null).map((r) => r.id)).toEqual(['only']);
  });

  it('HOSTILE: an unparseable timestamp is treated as no activity, never as a throw', () => {
    const rooms = [room('broken'), room('fine')];
    const last: Record<string, string> = { broken: 'not-a-date', fine: '2026-08-05T00:00:00Z' };
    // One bad row must not blank or reorder the whole list unpredictably.
    expect(sortConversationsByActivity(rooms, (r) => last[r.id]).map((r) => r.id)).toEqual(['fine', 'broken']);
  });

  it('HOSTILE: a room with no usable timestamp at all still sorts, last', () => {
    const rooms = [{ id: 'nulls', createdAt: '' }, room('fine')];
    const last: Record<string, string> = { fine: '2026-08-05T00:00:00Z' };
    expect(sortConversationsByActivity(rooms, (r) => last[r.id]).map((r) => r.id)).toEqual(['fine', 'nulls']);
  });

  it('does not mutate the input', () => {
    const rooms = [room('a'), room('b')];
    const last: Record<string, string> = { b: '2026-08-05T00:00:00Z' };
    sortConversationsByActivity(rooms, (r) => last[r.id]);
    expect(rooms.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('is BYTE-IDENTICAL to the mini-app copy, so both clients order the same way', () => {
    const web = readFileSync(join(process.cwd(), 'src/lib/chatSort.ts'), 'utf8');
    const mobile = readFileSync(join(process.cwd(), 'packages/mobile/src/lib/chatSort.ts'), 'utf8');
    expect(mobile).toBe(web);
  });
});
