import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { relativeTime, formatDate, truncateId } from '@/lib/utils';

describe('relativeTime', () => {
  const NOW = new Date('2024-06-15T12:00:00.000Z').getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for timestamps less than 60 seconds ago', () => {
    const iso = new Date(NOW - 30 * 1000).toISOString();
    expect(relativeTime(iso)).toBe('just now');
  });

  it('returns "just now" for exactly 0 seconds ago', () => {
    expect(relativeTime(new Date(NOW).toISOString())).toBe('just now');
  });

  it('returns minutes for timestamps 1–59 minutes ago', () => {
    const iso = new Date(NOW - 5 * 60 * 1000).toISOString();
    expect(relativeTime(iso)).toBe('5m');
  });

  it('returns hours for timestamps 1–23 hours ago', () => {
    const iso = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(iso)).toBe('3h');
  });

  it('returns days for timestamps 1–6 days ago', () => {
    const iso = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(relativeTime(iso)).toBe('2d');
  });

  it('returns absolute date for timestamps older than 7 days', () => {
    const past = new Date('2024-06-01T12:00:00.000Z');
    const result = relativeTime(past.toISOString());
    expect(result).toBe(past.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  });
});

describe('formatDate', () => {
  it('formats with default options (month short, day numeric, year numeric)', () => {
    const result = formatDate('2024-01-15T00:00:00.000Z');
    expect(result).toMatch(/Jan/);
    expect(result).toMatch(/2024/);
  });

  it('formats with custom options', () => {
    const result = formatDate('2024-01-15T00:00:00.000Z', { month: 'long', year: 'numeric' });
    expect(result).toMatch(/January/);
    expect(result).toMatch(/2024/);
  });
});

describe('truncateId', () => {
  it('returns the id unchanged when it is short enough', () => {
    const id = 'abc123';
    expect(truncateId(id)).toBe(id);
  });

  it('returns the id unchanged when it equals the threshold (startLen + endLen + 3)', () => {
    const id = 'a'.repeat(8 + 6 + 3);
    expect(truncateId(id)).toBe(id);
  });

  it('truncates a long id with default lengths', () => {
    const id = 'abcdefgh_MIDDLE_uvwxyz';
    const result = truncateId(id);
    expect(result).toBe('abcdefgh...uvwxyz');
  });

  it('truncates with custom startLen and endLen', () => {
    const id = '1234567890abcdef';
    const result = truncateId(id, 4, 4);
    expect(result).toBe('1234...cdef');
  });
});
