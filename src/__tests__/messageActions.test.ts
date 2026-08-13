import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { copyTargets, extractUrls } from '@/lib/messageActions';

/**
 * Copy hands back what was SENT. The tests that matter are the ones where a
 * plausible implementation would hand back something else: a trimmed URL, a
 * de-duplicated one, or one of several picked at random.
 */
describe('copyTargets', () => {
  it('copies the message verbatim', () => {
    expect(copyTargets('hello there').message).toBe('hello there');
  });

  it('a bare URL is both the message and the link', () => {
    const url = 'https://example.com/a';
    expect(copyTargets(url)).toEqual({ message: url, link: url });
  });

  it('REGRESSION: the query string and fragment survive', () => {
    // A link to a timestamp or an anchor stops meaning the same thing without
    // them, and "tidying" a URL on the way to the clipboard is exactly the kind
    // of helpfulness that loses the thing being copied.
    const url = 'https://www.reddit.com/r/logitech/comments/vutnh1/x_y_z/?tl=ko#comment-1';
    expect(copyTargets(`look: ${url}`).link).toBe(url);
  });

  it('text around a link: the message is whole, the link is just the link', () => {
    const t = copyTargets('see https://example.com/a for details');
    expect(t.message).toBe('see https://example.com/a for details');
    expect(t.link).toBe('https://example.com/a');
  });

  it('SEVERAL links offer no "copy link" — picking one would be a guess', () => {
    expect(copyTargets('https://a.example https://b.example').link).toBeNull();
  });

  it('the SAME link twice is still one link', () => {
    expect(copyTargets('https://a.example and again https://a.example').link).toBe('https://a.example');
  });

  it('BOUNDARY: an empty message copies empty and offers no link', () => {
    expect(copyTargets('')).toEqual({ message: '', link: null });
  });

  it('BOUNDARY: whitespace only is copied as-is, not trimmed', () => {
    expect(copyTargets('   ').message).toBe('   ');
  });

  it('no link at all', () => {
    expect(copyTargets('just words').link).toBeNull();
  });
});

describe('extractUrls', () => {
  it('drops the punctuation that ends the SENTENCE, not the URL', () => {
    expect(extractUrls('go to https://example.com/a.')).toEqual(['https://example.com/a']);
    expect(extractUrls('(see https://example.com/a)')).toEqual(['https://example.com/a']);
    expect(extractUrls('"https://example.com/a",')).toEqual(['https://example.com/a']);
  });

  it('keeps a path that legitimately ends in a bracket', () => {
    // Wikipedia-style paths contain them, and a URL that no longer resolves is
    // worse than one with a stray character.
    expect(extractUrls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
  });

  it('HOSTILE: schemes we cannot hand to a browser are not links', () => {
    // Guessing a scheme would put a URL on the clipboard the sender never wrote.
    expect(extractUrls('mailto:a@b.com')).toEqual([]);
    expect(extractUrls('www.example.com')).toEqual([]);
    expect(extractUrls('ftp://example.com/x')).toEqual([]);
  });

  it('HOSTILE: a UTF-8 message with no link returns nothing and does not throw', () => {
    expect(extractUrls('안녕하세요 🙂 링크는 없습니다')).toEqual([]);
  });

  it('finds links in order, across newlines', () => {
    expect(extractUrls('https://a.example\nthen https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('is BYTE-IDENTICAL to the mini-app copy, so both clients copy the same thing', () => {
    const web = readFileSync(join(process.cwd(), 'src/lib/messageActions.ts'), 'utf8');
    const mobile = readFileSync(join(process.cwd(), 'packages/mobile/src/lib/messageActions.ts'), 'utf8');
    expect(mobile).toBe(web);
  });
});
