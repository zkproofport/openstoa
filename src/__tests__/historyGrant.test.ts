import { describe, it, expect } from 'vitest';
import {
  parseHistoryGrant,
  resolveEnforcedHistoryGrant,
  historyGrantDenial,
  grantTimeFloor,
  grantEpochFloor,
  grantMessageCount,
  takScopeWithinGrant,
  type HistoryGrant,
} from '@/lib/historyGrant';
import { isValidTakScope } from '@/lib/mls/http';

/**
 * `history_grant` ENFORCEMENT — pure-layer unit tests.
 *
 * The security property under test: a scope string that was only ever VALIDATED
 * and STORED now decides what an agent credential can retrieve. Everything that
 * is not provably inside the grant must be excluded, and every unparseable or
 * absent grant must collapse to DENY — never to "unrestricted".
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   boundary            → 'Nd floor is exact…', 'day boundary is inclusive…',
 *                         'containment compares magnitudes at the exact edge'
 *   hostile input       → 'malformed grants are DENIED, never treated as full'
 *   empty / null /      → same case (empty string, whitespace, null, undefined,
 *     undefined            number, object are separate assertions)
 *   very large input    → 'malformed grants…' (65-char scope, 10-digit N)
 *   authorization       → 'a human session is never history-gated',
 *                         'an isAI session with no grant fails CLOSED'
 *   contract invocation → 'every shape isValidTakScope accepts is also parseable'
 *                         (pins the two definitions together so they cannot drift)
 *   result integrity    → 'containment is a partial order…' + the cross-family rows
 *   race / external dep → N/A: this layer is pure, no db, no clock but the one passed in.
 */

const days = (n: number): HistoryGrant => ({ kind: 'days', days: n });
const count = (n: number): HistoryGrant => ({ kind: 'count', count: n });
const epoch = (n: number): HistoryGrant => ({ kind: 'sinceEpoch', epoch: n });

describe('parseHistoryGrant', () => {
  it('destructures each of the five accepted shapes', () => {
    expect(parseHistoryGrant('full')).toEqual({ kind: 'full' });
    expect(parseHistoryGrant('none')).toEqual({ kind: 'none' });
    expect(parseHistoryGrant('7d')).toEqual({ kind: 'days', days: 7 });
    expect(parseHistoryGrant('since_epoch:42')).toEqual({ kind: 'sinceEpoch', epoch: 42 });
    expect(parseHistoryGrant('100')).toEqual({ kind: 'count', count: 100 });
  });

  it('does not confuse the three numeric shapes with each other', () => {
    // `7d` must not parse as the count 7, and `since_epoch:7` must not parse as
    // either — a mix-up here silently widens or narrows every bounded key.
    expect(parseHistoryGrant('7d')).toEqual(days(7));
    expect(parseHistoryGrant('7')).toEqual(count(7));
    expect(parseHistoryGrant('since_epoch:7')).toEqual(epoch(7));
  });

  it('malformed grants are DENIED (null), never treated as full', () => {
    const hostile = [
      '',
      '   ',
      'whenever',
      'FULL',
      'None',
      '0d', // zero days is rejected by the validator
      '0', // zero messages likewise
      'since_epoch:', // no number
      'since_epoch:-1',
      '-7d',
      '7 d',
      '7D',
      'full; DROP TABLE chat_messages',
      "100' OR '1'='1",
      '%',
      '_',
      '\\',
      '7d\n',
      'full full',
      '한국어',
      '📅30d',
      'd'.repeat(65),
      '9'.repeat(10) + 'd', // over the 9-digit day cap
      null,
      undefined,
      7,
      7.5,
      true,
      {},
      [],
      ['full'],
    ];
    for (const h of hostile) {
      expect(parseHistoryGrant(h), `${JSON.stringify(h)} must not parse`).toBeNull();
    }
  });

  it('CONTRACT: every shape isValidTakScope accepts is also parseable, and vice versa', () => {
    // The two definitions must stay welded together: a scope the validator
    // accepts but the parser cannot destructure would fail closed at runtime
    // (a key that validates at creation and then denies every read), and the
    // reverse would enforce a shape nobody can issue. Probing both directions
    // over a corpus is what catches a one-sided edit to either regex.
    const corpus = [
      'full', 'none', '1d', '7d', '30d', '365d', '999999999d',
      'since_epoch:0', 'since_epoch:1', 'since_epoch:999999999999999',
      '1', '50', '999999999',
      '', ' ', '0', '0d', 'x', 'since_epoch:x', 'since_epoch:1.5', 'fullish',
      'd'.repeat(65),
    ];
    for (const s of corpus) {
      expect(parseHistoryGrant(s) !== null, `disagreement on ${JSON.stringify(s)}`).toBe(
        isValidTakScope(s),
      );
    }
  });
});

describe('resolveEnforcedHistoryGrant', () => {
  it('a human session is never history-gated, whatever grant string is attached', () => {
    // The isAI flag is the only switch. A human carrying a stray grant field
    // (or none at all) must take the byte-identical pre-gate code path.
    expect(resolveEnforcedHistoryGrant({ userId: 'h', isAI: false })).toBeNull();
    expect(resolveEnforcedHistoryGrant({ userId: 'h' })).toBeNull();
    expect(resolveEnforcedHistoryGrant({ userId: 'h', isAI: false, apiKeyHistoryGrant: 'none' })).toBeNull();
    expect(resolveEnforcedHistoryGrant({ userId: 'h', isAI: false, apiKeyHistoryGrant: 'garbage' })).toBeNull();
  });

  it('a full grant resolves to null — unrestricted takes the same path as a human', () => {
    expect(resolveEnforcedHistoryGrant({ userId: 'b', isAI: true, apiKeyHistoryGrant: 'full' })).toBeNull();
  });

  it('bounded grants resolve to their bound', () => {
    expect(resolveEnforcedHistoryGrant({ userId: 'b', isAI: true, apiKeyHistoryGrant: '7d' })).toEqual(days(7));
    expect(resolveEnforcedHistoryGrant({ userId: 'b', isAI: true, apiKeyHistoryGrant: '100' })).toEqual(count(100));
    expect(resolveEnforcedHistoryGrant({ userId: 'b', isAI: true, apiKeyHistoryGrant: 'since_epoch:3' })).toEqual(epoch(3));
    expect(resolveEnforcedHistoryGrant({ userId: 'b', isAI: true, apiKeyHistoryGrant: 'none' })).toEqual({ kind: 'none' });
  });

  it('FAIL-CLOSED: an isAI session with a missing or unparseable grant is denied, never widened', () => {
    // The bare-JWT shape (dev-login): isAI true, no key, no grant.
    expect(resolveEnforcedHistoryGrant({ userId: 'b', isAI: true })).toEqual({ kind: 'none' });
    for (const bad of ['', 'whatever', 'FULL', '0d', undefined]) {
      expect(
        resolveEnforcedHistoryGrant({ userId: 'b', isAI: true, apiKeyHistoryGrant: bad as string }),
        `grant ${JSON.stringify(bad)} must fail closed`,
      ).toEqual({ kind: 'none' });
    }
  });
});

describe('historyGrantDenial', () => {
  it('403s a none grant and names the reason', async () => {
    const res = historyGrantDenial({ kind: 'none' });
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.error).toContain('historyGrant');
    expect(body.error).toContain('none');
  });

  it('lets every other grant through, including null (human / full)', () => {
    expect(historyGrantDenial(null)).toBeNull();
    expect(historyGrantDenial(days(7))).toBeNull();
    expect(historyGrantDenial(count(1))).toBeNull();
    expect(historyGrantDenial(epoch(0))).toBeNull();
    expect(historyGrantDenial({ kind: 'full' })).toBeNull();
  });
});

describe('grant → bound extraction', () => {
  const NOW = new Date('2026-08-04T12:00:00.000Z');

  it('Nd floor is exactly N*24h before the supplied clock', () => {
    expect(grantTimeFloor(days(1), NOW)!.toISOString()).toBe('2026-08-03T12:00:00.000Z');
    expect(grantTimeFloor(days(7), NOW)!.toISOString()).toBe('2026-07-28T12:00:00.000Z');
    expect(grantTimeFloor(days(365), NOW)!.toISOString()).toBe('2025-08-04T12:00:00.000Z');
  });

  it('only the day form yields a time floor; only the epoch form an epoch floor; only the count form a count', () => {
    const all: HistoryGrant[] = [{ kind: 'full' }, { kind: 'none' }, days(7), count(5), epoch(3)];
    expect(all.map((g) => grantTimeFloor(g, NOW) !== null)).toEqual([false, false, true, false, false]);
    expect(all.map((g) => grantEpochFloor(g))).toEqual([null, null, null, null, 3]);
    expect(all.map((g) => grantMessageCount(g))).toEqual([null, null, null, 5, null]);
  });

  it('epoch floor 0 is a real bound, not a falsy no-op', () => {
    // `since_epoch:0` must not be swallowed by a truthiness check anywhere:
    // it still excludes rows with a NULL epoch.
    expect(grantEpochFloor(epoch(0))).toBe(0);
    expect(grantEpochFloor(epoch(0))).not.toBeNull();
  });
});

describe('takScopeWithinGrant', () => {
  it('an unbounded caller (human or full) receives every bundle, including garbage-scoped ones', () => {
    for (const s of ['full', 'none', '7d', 'since_epoch:1', '5', 'garbage']) {
      expect(takScopeWithinGrant(s, null)).toBe(true);
    }
  });

  it('a none grant receives nothing except a none bundle (which unlocks nothing)', () => {
    expect(takScopeWithinGrant('none', { kind: 'none' })).toBe(true);
    for (const s of ['full', '1d', 'since_epoch:999', '1']) {
      expect(takScopeWithinGrant(s, { kind: 'none' }), `${s} must be withheld`).toBe(false);
    }
  });

  it('a bounded grant never receives a full bundle — the widest key defeats the bound', () => {
    expect(takScopeWithinGrant('full', days(30))).toBe(false);
    expect(takScopeWithinGrant('full', count(1000))).toBe(false);
    expect(takScopeWithinGrant('full', epoch(0))).toBe(false);
  });

  it('containment compares magnitudes at the exact edge (same shape)', () => {
    // days: fewer days is narrower; equal is allowed; one more is not.
    expect(takScopeWithinGrant('29d', days(30))).toBe(true);
    expect(takScopeWithinGrant('30d', days(30))).toBe(true);
    expect(takScopeWithinGrant('31d', days(30))).toBe(false);
    // count: same rule.
    expect(takScopeWithinGrant('99', count(100))).toBe(true);
    expect(takScopeWithinGrant('100', count(100))).toBe(true);
    expect(takScopeWithinGrant('101', count(100))).toBe(false);
    // since_epoch: a HIGHER start is narrower (it begins later).
    expect(takScopeWithinGrant('since_epoch:6', epoch(5))).toBe(true);
    expect(takScopeWithinGrant('since_epoch:5', epoch(5))).toBe(true);
    expect(takScopeWithinGrant('since_epoch:4', epoch(5))).toBe(false);
  });

  it('cross-shape comparisons are REFUSED rather than guessed', () => {
    // `7d` vs `since_epoch:3` cannot be ordered without a per-epoch clock the
    // server does not keep. Fail closed: unprovable is not contained.
    expect(takScopeWithinGrant('since_epoch:3', days(7))).toBe(false);
    expect(takScopeWithinGrant('7d', epoch(3))).toBe(false);
    expect(takScopeWithinGrant('5', days(7))).toBe(false);
    expect(takScopeWithinGrant('7d', count(5))).toBe(false);
  });

  it('an unparseable bundle scope is withheld', () => {
    for (const s of ['', 'garbage', null, undefined, 42, {}]) {
      expect(takScopeWithinGrant(s, days(30)), `${JSON.stringify(s)} must be withheld`).toBe(false);
    }
  });
});
