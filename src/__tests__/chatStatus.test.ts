import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSyncingHistory, nextPendingId, isProvisionalId } from '@/lib/chatStatus';

/**
 * These two rules were re-derived inline on each surface and got wrong on each
 * of them, repeatedly. The point of the tests is the cases that actually
 * shipped broken, not the happy path.
 */
describe('isSyncingHistory', () => {
  it('spins while the probe has not answered yet', () => {
    expect(isSyncingHistory({ lockedCount: 3, rootState: null, rootProbed: false })).toBe(true);
  });

  it('REGRESSION: a probe that answered `null` STOPS the spinner', () => {
    // This is the bug that spun forever: a scoped tier with no topic-wide root
    // answers `null`, which looks exactly like "not asked yet" if you compare
    // rootState instead of tracking whether the question was answered.
    expect(isSyncingHistory({ lockedCount: 3, rootState: null, rootProbed: true })).toBe(false);
  });

  it('REGRESSION: keeps spinning while the key is still on its way', () => {
    // The other direction: the spinner used to clear the moment the root became
    // reachable, over a room still full of locked rows.
    expect(isSyncingHistory({ lockedCount: 3, rootState: 'waiting', rootProbed: true })).toBe(true);
  });

  it('stops once nothing on screen is locked, whatever the probe says', () => {
    for (const rootState of ['verified', 'waiting', 'orphan', 'unverified', null] as const) {
      for (const rootProbed of [true, false]) {
        expect(isSyncingHistory({ lockedCount: 0, rootState, rootProbed })).toBe(false);
      }
    }
  });

  it('a settled probe with an unusable root stops — the rows explain themselves', () => {
    expect(isSyncingHistory({ lockedCount: 1, rootState: 'orphan', rootProbed: true })).toBe(false);
    expect(isSyncingHistory({ lockedCount: 1, rootState: 'unverified', rootProbed: true })).toBe(false);
    expect(isSyncingHistory({ lockedCount: 1, rootState: 'verified', rootProbed: true })).toBe(false);
  });

  it('BOUNDARY: a negative count is treated as nothing locked, not as spinning', () => {
    expect(isSyncingHistory({ lockedCount: -1, rootState: 'waiting', rootProbed: true })).toBe(false);
  });
});

describe('nextPendingId', () => {
  it('REGRESSION: sorts in SEND order as a string, which is how ties break', () => {
    // Random uuids made three messages sent in one burst appear in random
    // order. The merge compares ids as strings, so the ids themselves have to
    // carry the ordering.
    const ids = [nextPendingId(), nextPendingId(), nextPendingId()];
    expect([...ids].sort()).toEqual(ids);
  });

  it('stays sorted past the point where digit count changes', () => {
    // Zero padding is what makes this true: unpadded, "10" sorts before "9".
    const many = Array.from({ length: 15 }, () => nextPendingId());
    expect([...many].sort()).toEqual(many);
  });

  it('never repeats an id', () => {
    const ids = Array.from({ length: 200 }, () => nextPendingId());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('isProvisionalId', () => {
  it('recognises its own ids', () => {
    expect(isProvisionalId(nextPendingId())).toBe(true);
  });

  it('REGRESSION: a server uuid is NOT provisional', () => {
    // Getting this backwards would stop real messages being archived; getting
    // the other direction wrong is what POSTed non-uuid ids to the archive and
    // collected a 400 per unsent message on every pass.
    expect(isProvisionalId('d130ec61-3748-47b7-957f-9b8e4fb3044c')).toBe(false);
  });

  it('HOSTILE: an empty id is not provisional, and does not throw', () => {
    expect(isProvisionalId('')).toBe(false);
  });

  it('HOSTILE: the prefix in the MIDDLE of an id does not count', () => {
    expect(isProvisionalId('msg-pending-000000000001')).toBe(false);
  });
});

describe('shared rule', () => {
  it('is BYTE-IDENTICAL to the mini-app copy, so both clients behave the same', () => {
    const web = readFileSync(join(process.cwd(), 'src/lib/chatStatus.ts'), 'utf8');
    const mobile = readFileSync(join(process.cwd(), 'packages/mobile/src/lib/chatStatus.ts'), 'utf8');
    expect(mobile).toBe(web);
  });
});
