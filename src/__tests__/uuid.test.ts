import { describe, it, expect } from 'vitest';
import { isValidUUID } from '@/lib/uuid';

/**
 * Edge-case matrix for `isValidUUID` — the guard that turns a malformed
 * `[topicId]`/`[postId]`/`[commentId]`/`[keyId]` path param into a 400
 * instead of letting it reach Postgres and 500. See src/lib/uuid.ts for the
 * full rationale, including why this is deliberately narrower than what
 * Postgres's own `uuid` column accepts.
 */
describe('isValidUUID', () => {
  const REAL_UUID = '12345678-1234-1234-1234-123456789012';

  it('accepts a canonical lowercase UUID (the shape Postgres actually emits)', () => {
    expect(isValidUUID(REAL_UUID)).toBe(true);
  });

  it('accepts uppercase and mixed-case (Postgres itself is case-insensitive)', () => {
    expect(isValidUUID(REAL_UUID.toUpperCase())).toBe(true);
    expect(isValidUUID('12345678-1234-1234-1234-ABCdef012345')).toBe(true);
  });

  it('accepts any version/variant nibble — Postgres does not enforce RFC 4122 version bits', () => {
    // version nibble '9' is not a defined RFC 4122 version, but Postgres's
    // uuid column accepts it anyway (verified against the real column type).
    expect(isValidUUID('12345678-1234-9234-1234-123456789012')).toBe(true);
  });

  // --- boundary ---------------------------------------------------------
  it('rejects an empty string', () => {
    expect(isValidUUID('')).toBe(false);
  });

  it('rejects whitespace-only', () => {
    expect(isValidUUID('   ')).toBe(false);
  });

  it('rejects one character short of a valid uuid', () => {
    expect(isValidUUID(REAL_UUID.slice(0, -1))).toBe(false);
  });

  it('rejects one character too long (extra char appended to an otherwise valid uuid)', () => {
    expect(isValidUUID(REAL_UUID + '0')).toBe(false);
  });

  it('rejects a valid uuid with trailing garbage (anchors must be exact, not prefix-match)', () => {
    expect(isValidUUID(REAL_UUID + '/../../etc/passwd')).toBe(false);
  });

  it('rejects a valid uuid with leading garbage', () => {
    expect(isValidUUID('x' + REAL_UUID)).toBe(false);
  });

  // --- hostile / adversarial ---------------------------------------------
  it('rejects a no-dash 32-hex-char string, even though Postgres itself would accept it', () => {
    // Deliberate: no real caller ever sends this shape (see file header).
    expect(isValidUUID('12345678123412341234123456789012')).toBe(false);
  });

  it('rejects a brace-wrapped uuid, even though Postgres itself would accept it', () => {
    expect(isValidUUID(`{${REAL_UUID}}`)).toBe(false);
  });

  it('rejects path-traversal-shaped input', () => {
    expect(isValidUUID('../../etc/passwd')).toBe(false);
    expect(isValidUUID('..%2F..%2Fetc%2Fpasswd')).toBe(false);
  });

  it('rejects SQL-shaped input', () => {
    expect(isValidUUID("' OR '1'='1")).toBe(false);
    expect(isValidUUID('1; DROP TABLE topics;--')).toBe(false);
  });

  it('rejects a very long string without pathological slowdown', () => {
    const huge = 'a'.repeat(1_000_000);
    const start = performance.now();
    expect(isValidUUID(huge)).toBe(false);
    expect(performance.now() - start).toBeLessThan(100);
  });

  // --- UTF-8 --------------------------------------------------------------
  it('rejects Korean and emoji input', () => {
    expect(isValidUUID('토픽아이디')).toBe(false);
    expect(isValidUUID('🎉🎉🎉🎉-🎉🎉🎉🎉-🎉🎉🎉🎉-🎉🎉🎉🎉-🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉')).toBe(false);
  });

  // --- empty/whitespace/null/undefined distinctness (TS keeps null/undefined
  // out of the string-typed param at compile time; runtime-adjacent cases are
  // covered by the route-level tests, which call this only after `await
  // params` has already produced a string).
});
