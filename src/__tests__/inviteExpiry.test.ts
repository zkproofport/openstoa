import { describe, it, expect } from 'vitest';
import {
  resolveInviteExpiry,
  DEFAULT_INVITE_HOURS,
  MIN_INVITE_HOURS,
  MAX_INVITE_HOURS,
} from '@/lib/inviteExpiry';

const NOW = new Date('2026-08-14T00:00:00.000Z');
const hoursAfter = (h: number) => new Date(NOW.getTime() + h * 3600_000);

describe('resolveInviteExpiry', () => {
  it('an admin-chosen lifetime is honoured', () => {
    const r = resolveInviteExpiry(48, NOW);
    expect(r).toEqual({ ok: true, expiresAt: hoursAfter(48) });
  });

  it('saying nothing keeps the previous seven days', () => {
    // The route used to hard-code this; callers that do not care must not see a
    // behaviour change.
    for (const nothing of [undefined, null]) {
      const r = resolveInviteExpiry(nothing, NOW);
      expect(r).toEqual({ ok: true, expiresAt: hoursAfter(DEFAULT_INVITE_HOURS) });
    }
  });

  it('BOUNDARY: the exact minimum and maximum are accepted', () => {
    expect(resolveInviteExpiry(MIN_INVITE_HOURS, NOW).ok).toBe(true);
    expect(resolveInviteExpiry(MAX_INVITE_HOURS, NOW).ok).toBe(true);
  });

  it('BOUNDARY: one step outside either end is refused', () => {
    expect(resolveInviteExpiry(MIN_INVITE_HOURS - 1, NOW).ok).toBe(false);
    expect(resolveInviteExpiry(MAX_INVITE_HOURS + 1, NOW).ok).toBe(false);
  });

  it('REGRESSION: zero is not "no expiry" — it is refused', () => {
    // A link that expires immediately is useless, and reading 0 as "forever"
    // would recreate the permanent-link hole this exists to close.
    expect(resolveInviteExpiry(0, NOW).ok).toBe(false);
  });

  it('HOSTILE: a negative lifetime cannot produce an already-expired link', () => {
    expect(resolveInviteExpiry(-1, NOW).ok).toBe(false);
    expect(resolveInviteExpiry(-100000, NOW).ok).toBe(false);
  });

  it('HOSTILE: a numeric STRING is not a number', () => {
    // Accepting it would mean '24abc' quietly becoming 24 further down.
    const r = resolveInviteExpiry('24', NOW);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('must be a number');
  });

  it('HOSTILE: NaN and Infinity are refused, not turned into a date', () => {
    // `new Date(NaN)` is an Invalid Date, which a database will happily reject
    // at 3am rather than here.
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(resolveInviteExpiry(bad, NOW).ok, String(bad)).toBe(false);
    }
  });

  it('HOSTILE: a fractional lifetime is refused rather than rounded', () => {
    expect(resolveInviteExpiry(1.5, NOW).ok).toBe(false);
  });

  it('HOSTILE: objects, arrays and booleans are refused', () => {
    for (const bad of [{}, [], true, false, () => 1]) {
      expect(resolveInviteExpiry(bad, NOW).ok).toBe(false);
    }
  });

  it('HOSTILE: a huge value cannot overflow into a valid date', () => {
    expect(resolveInviteExpiry(Number.MAX_SAFE_INTEGER, NOW).ok).toBe(false);
  });

  it('the expiry is computed from the `now` it is GIVEN', () => {
    // No hidden clock: the caller decides, which is what makes this testable.
    const later = new Date('2027-01-01T00:00:00.000Z');
    const r = resolveInviteExpiry(1, later);
    expect(r.ok === true && r.expiresAt).toEqual(new Date(later.getTime() + 3600_000));
  });

  it('every refusal explains itself', () => {
    for (const bad of [0, -1, 1.5, '24', NaN, {}]) {
      const r = resolveInviteExpiry(bad, NOW);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.error.length, String(bad)).toBeGreaterThan(0);
    }
  });
});
