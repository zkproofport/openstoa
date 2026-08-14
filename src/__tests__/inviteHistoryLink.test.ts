import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  encodeInviteHistory,
  decodeInviteHistory,
  withInviteHistory,
  stripInviteHistory,
  INVITE_FRAGMENT_MAX_CHARS,
} from '@/lib/inviteHistoryLink';
import { INVITE_HISTORY_EPOCHS_MAX } from '@/lib/chatTierPolicy';

/**
 * The invite fragment is how a private or secret topic hands over history
 * without the server learning anything. Everything here defends one of two
 * properties: the keys SURVIVE the trip intact, or they are not written into a
 * keychain at all.
 *
 * Edge-case matrix rows (test names carry the row):
 *   contract  — round-trips; the fragment is the only channel
 *   boundary  — 0 / 1 / MAX epochs; exactly at and past the character ceiling
 *   hostile   — non-base64, negative and fractional epochs, duplicate epochs,
 *               a foreign fragment, a fragment carrying other params
 *   empty     — null / undefined / '' / '#' verified separately
 *   integrity — a truncated link opens what it still can, never a partial key
 *   utf8      — multi-byte characters cannot smuggle themselves into a key
 */

const K = (n: number) => Buffer.alloc(32, n).toString('base64');

describe('encode / decode', () => {
  it('CONTRACT: round-trips the epochs it was given', () => {
    const keys = { taks: { 3: K(1), 4: K(2), 5: K(3) } };
    const frag = encodeInviteHistory(keys);
    expect(frag).not.toBeNull();
    expect(decodeInviteHistory(frag)).toEqual(keys);
  });

  it('accepts a leading # so callers can pass location.hash unchanged', () => {
    const frag = encodeInviteHistory({ taks: { 7: K(9) } })!;
    expect(decodeInviteHistory(`#${frag}`)).toEqual({ taks: { 7: K(9) } });
  });

  it('finds its own field among other fragment params', () => {
    const frag = encodeInviteHistory({ taks: { 2: K(4) } })!;
    expect(decodeInviteHistory(`from=email&${frag}&ref=x`)).toEqual({ taks: { 2: K(4) } });
  });

  it('BOUNDARY: no epochs produces NO fragment, not an empty one', () => {
    // A bare '#' on an invite link is noise a user will ask about, and "sharing
    // nothing" is better said by carrying nothing.
    expect(encodeInviteHistory({ taks: {} })).toBeNull();
  });

  it('BOUNDARY: one epoch, and the tier ceiling, both fit', () => {
    expect(encodeInviteHistory({ taks: { 0: K(1) } })).not.toBeNull();
    const many: Record<number, string> = {};
    for (let i = 0; i < INVITE_HISTORY_EPOCHS_MAX; i++) many[i] = K(i);
    const frag = encodeInviteHistory({ taks: many });
    expect(frag).not.toBeNull();
    expect(frag!.length).toBeLessThan(INVITE_FRAGMENT_MAX_CHARS);
    expect(Object.keys(decodeInviteHistory(frag)!.taks)).toHaveLength(INVITE_HISTORY_EPOCHS_MAX);
  });

  it('BOUNDARY: past the character ceiling it refuses rather than truncating', () => {
    /*
     * A silently truncated link is worse than no link: the recipient joins, the
     * history looks broken, and nothing says why. Refusing is loud.
     */
    const tooMany: Record<number, string> = {};
    for (let i = 0; i < 200; i++) tooMany[i] = K(i);
    expect(encodeInviteHistory({ taks: tooMany })).toBeNull();
  });

  it('BOUNDARY: an over-long fragment is refused on the way IN too', () => {
    // The sender is not the only one who can hand us an oversized fragment.
    expect(decodeInviteHistory('h1=' + '0.' + 'A'.repeat(INVITE_FRAGMENT_MAX_CHARS))).toBeNull();
  });
});

describe('hostile input', () => {
  it('a key that is not base64 is DROPPED, never written to a keychain', () => {
    // Anything that did not come from the encoder would be stored as if it were
    // a key, and then fail to open anything with no explanation.
    const bad = decodeInviteHistory('h1=1.not base64!~2.' + K(5));
    expect(bad).toEqual({ taks: { 2: K(5) } });
  });

  it('negative and fractional epochs are dropped', () => {
    expect(decodeInviteHistory(`h1=-1.${K(1)}~1.5.${K(2)}~9.${K(3)}`)).toEqual({ taks: { 9: K(3) } });
  });

  it('a DUPLICATED epoch keeps the first — a later one cannot override it', () => {
    // Otherwise appending to a link would let someone swap a key under it.
    expect(decodeInviteHistory(`h1=4.${K(1)}~4.${K(2)}`)).toEqual({ taks: { 4: K(1) } });
  });

  it('UTF-8 cannot smuggle itself into a key', () => {
    expect(decodeInviteHistory(`h1=1.한글키~2.🌟~3.${K(7)}`)).toEqual({ taks: { 3: K(7) } });
  });

  it('a fragment that is not ours yields nothing', () => {
    expect(decodeInviteHistory('utm_source=x&t=123')).toBeNull();
    expect(decodeInviteHistory('h2=1.' + K(1))).toBeNull();
  });

  it('malformed parts yield nothing rather than throwing', () => {
    for (const bad of ['h1=', 'h1=.', 'h1=1.', 'h1=.abc', 'h1=~~~', 'h1=abc']) {
      expect(() => decodeInviteHistory(bad)).not.toThrow();
      expect(decodeInviteHistory(bad), bad).toBeNull();
    }
  });

  it('EMPTY: null, undefined, empty string and a bare # are each nothing', () => {
    expect(decodeInviteHistory(null)).toBeNull();
    expect(decodeInviteHistory(undefined)).toBeNull();
    expect(decodeInviteHistory('')).toBeNull();
    expect(decodeInviteHistory('#')).toBeNull();
  });

  it('INTEGRITY: a truncated link opens what survived, and no partial key', () => {
    const frag = encodeInviteHistory({ taks: { 1: K(1), 2: K(2), 3: K(3) } })!;
    // Cut mid-key, as a messaging app would.
    const cut = frag.slice(0, frag.length - 20);
    const got = decodeInviteHistory(cut);
    // Whatever came back is whole keys only — never a fragment of one.
    for (const v of Object.values(got?.taks ?? {})) {
      expect(v.length).toBe(K(1).length);
    }
  });
});

describe('url helpers', () => {
  it('attaches, and REPLACES an existing fragment rather than appending', () => {
    const frag = encodeInviteHistory({ taks: { 1: K(1) } })!;
    expect(withInviteHistory('https://x/join/abc', frag)).toBe(`https://x/join/abc#${frag}`);
    // Two '#' in one URL is not a thing; a caller passing one is expressing a
    // mistake, not an intent.
    expect(withInviteHistory('https://x/join/abc#old', frag)).toBe(`https://x/join/abc#${frag}`);
  });

  it('a null fragment leaves a clean url', () => {
    expect(withInviteHistory('https://x/join/abc', null)).toBe('https://x/join/abc');
    expect(withInviteHistory('https://x/join/abc#old', null)).toBe('https://x/join/abc');
  });

  it('CONTRACT: stripping leaves the token and removes the keys', () => {
    /*
     * The difference this exists for: an invite token can be revoked, a key
     * cannot. So a link that ends up in a screenshot or a support ticket should
     * be strippable to the half that is recoverable.
     */
    const frag = encodeInviteHistory({ taks: { 1: K(1) } })!;
    const full = withInviteHistory('https://x/topics/join/tok123', frag);
    expect(stripInviteHistory(full)).toBe('https://x/topics/join/tok123');
    expect(stripInviteHistory(full)).not.toContain(K(1));
  });
});

describe('shared rule', () => {
  it('is BYTE-IDENTICAL to the mini-app copy, so a link made on one opens on the other', () => {
    const web = readFileSync(join(process.cwd(), 'src/lib/inviteHistoryLink.ts'), 'utf8');
    const mobile = readFileSync(join(process.cwd(), 'packages/mobile/src/lib/inviteHistoryLink.ts'), 'utf8');
    expect(mobile).toBe(web);
  });
});
