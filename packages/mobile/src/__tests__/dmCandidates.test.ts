/**
 * `buildDmCandidatesPath` — the request-path builder for the "새 대화"
 * (new conversation) picker's `GET /api/dm/candidates` call.
 *
 * Edge-case matrix rows covered here:
 *   empty/whitespace — never sends `q=` for a blank or whitespace-only draft
 *   hostile input    — `%`, `_`, `\`, and an HTML-tag-shaped string survive
 *                       transport unaltered (server owns escaping/sanitizing)
 *   UTF-8            — Korean and emoji round-trip through encode/decode
 *   very large input — clipped to 200 code points without splitting a
 *                       surrogate pair (mirrors the server's own clip)
 */
import { describe, it, expect } from 'vitest';
import { buildDmCandidatesPath } from '../lib/dmCandidates';

function decodeQ(path: string): string | null {
  const [, qs] = path.split('?');
  if (!qs) return null;
  const params = new URLSearchParams(qs);
  return params.get('q');
}

describe('buildDmCandidatesPath', () => {
  it('omits q entirely for an empty draft', () => {
    expect(buildDmCandidatesPath('')).toBe('/api/dm/candidates');
  });

  it('omits q entirely for a whitespace-only draft (never q=%20)', () => {
    expect(buildDmCandidatesPath('   ')).toBe('/api/dm/candidates');
  });

  it('sends the trimmed text for a normal query', () => {
    const path = buildDmCandidatesPath('  kim  ');
    expect(decodeQ(path)).toBe('kim');
  });

  it('round-trips wildcard characters % and _ unaltered', () => {
    const path = buildDmCandidatesPath('50%_off');
    expect(decodeQ(path)).toBe('50%_off');
  });

  it('round-trips a backslash unaltered', () => {
    const path = buildDmCandidatesPath('back\\slash');
    expect(decodeQ(path)).toBe('back\\slash');
  });

  it('round-trips an HTML-tag-shaped string unaltered (server renders as text, not markup)', () => {
    const path = buildDmCandidatesPath('<script>alert(1)</script>');
    expect(decodeQ(path)).toBe('<script>alert(1)</script>');
  });

  it('round-trips a Korean nickname', () => {
    const path = buildDmCandidatesPath('김철수');
    expect(decodeQ(path)).toBe('김철수');
  });

  it('round-trips an emoji query', () => {
    const path = buildDmCandidatesPath('🔥unicorn🔥');
    expect(decodeQ(path)).toBe('🔥unicorn🔥');
  });

  it('clips to 200 code points without splitting a surrogate pair', () => {
    const emoji = '😀'.repeat(250); // 250 code points, 500 UTF-16 code units
    const path = buildDmCandidatesPath(emoji);
    const decoded = decodeQ(path)!;
    expect(Array.from(decoded).length).toBe(200);
    // No lone surrogate: every code point round-trips as the same emoji.
    expect(decoded).toBe('😀'.repeat(200));
  });

  it('leaves a query under the limit untouched', () => {
    const q = 'a'.repeat(199);
    const path = buildDmCandidatesPath(q);
    expect(decodeQ(path)).toBe(q);
  });
});
