import { describe, it, expect } from 'vitest';
import { normaliseSearchQuery, MAX_QUERY_LENGTH } from '@/lib/search';

describe('normaliseSearchQuery', () => {
  it('returns null for null / undefined / empty input', () => {
    expect(normaliseSearchQuery(null)).toBeNull();
    expect(normaliseSearchQuery(undefined)).toBeNull();
    expect(normaliseSearchQuery('')).toBeNull();
  });

  it('returns null for whitespace-only input (no filter, not %% match-all)', () => {
    expect(normaliseSearchQuery('   ')).toBeNull();
    expect(normaliseSearchQuery('\t\n\r ')).toBeNull();
  });

  it('trims surrounding whitespace before wrapping', () => {
    expect(normaliseSearchQuery('  hello  ')).toBe('%hello%');
  });

  it('escapes the ilike wildcard `%` (otherwise user input would match everything)', () => {
    // The literal % in the user input must be escaped so PostgreSQL ilike
    // matches a literal % character instead of any-substring.
    expect(normaliseSearchQuery('50% off')).toBe('%50\\% off%');
  });

  it('escapes the ilike wildcard `_` (otherwise it matches any single char)', () => {
    expect(normaliseSearchQuery('foo_bar')).toBe('%foo\\_bar%');
  });

  it('escapes the backslash escape character itself (must come before % and _ escapes)', () => {
    expect(normaliseSearchQuery('a\\b')).toBe('%a\\\\b%');
  });

  it('escapes a mixed pattern (\\, %, _) without double-escaping the inserted slashes', () => {
    // Order matters: \ first, then %, then _. The slashes we INSERT must
    // not themselves be re-escaped.
    expect(normaliseSearchQuery('100% \\_test')).toBe('%100\\% \\\\\\_test%');
  });

  it('clips overly long input to MAX_QUERY_LENGTH chars (DoS guard)', () => {
    const long = 'a'.repeat(MAX_QUERY_LENGTH + 50);
    const out = normaliseSearchQuery(long);
    expect(out).not.toBeNull();
    // Two wrapping % plus MAX_QUERY_LENGTH a's = MAX_QUERY_LENGTH + 2
    expect(out!.length).toBe(MAX_QUERY_LENGTH + 2);
  });

  it('preserves UTF-8 (Korean) without mangling', () => {
    expect(normaliseSearchQuery('한글검색')).toBe('%한글검색%');
  });

  it('preserves emoji', () => {
    expect(normaliseSearchQuery('hello 🔥 world')).toBe('%hello 🔥 world%');
  });

  it('preserves SQL-injection-like strings (parameterised queries are safe; we only escape ilike metachars)', () => {
    // We do NOT need to escape ' or ; — drizzle uses parameterised queries.
    // The only thing this function defends is ilike pattern semantics.
    const evil = `'; DROP TABLE posts; --`;
    const out = normaliseSearchQuery(evil)!;
    // Quote and semicolon survive untouched; no % or _ to escape.
    expect(out).toBe(`%'; DROP TABLE posts; --%`);
  });

  it('preserves newlines / tabs (they can appear in post content)', () => {
    expect(normaliseSearchQuery('line1\nline2')).toBe('%line1\nline2%');
  });
});
