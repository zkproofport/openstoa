/**
 * The invite link as a whole: the keys, the topic they belong to, and the
 * sentence shown to the inviter before they send it.
 *
 * `inviteHistoryLink.test.ts` covers the key codec. This covers what is built
 * AROUND it — which is where a link can be right about its keys and still be
 * wrong: assembled for another room, or described to the sender in numbers that
 * do not match what it opens.
 *
 * Edge-case matrix rows (test names carry the row):
 *   contract  — a built link round-trips back to the same keys for that topic
 *   contract  — the keys are in the FRAGMENT and nowhere else in the URL
 *   boundary  — 0 / 1 / MAX epochs; a tagged fragment at the character ceiling
 *   hostile   — a fragment tagged for a DIFFERENT topic is refused, not imported
 *   hostile   — a malformed percent-escape in the tag reads as untagged
 *   empty     — null / undefined / '' / '#' / keyless fragment, each separately
 *   utf8      — a Korean/emoji topic id survives tagging and reading back
 *   large     — an over-long key set produces a link with NO fragment at all
 *   integrity — the summary counts only the epochs being shared, and its
 *               `since` is the OLDEST of those rows, monotonic as epochs grow
 */
import { describe, it, expect } from 'vitest';
import {
  buildInviteFragment,
  buildInviteUrl,
  readInviteHistory,
  inviteFragmentTopicId,
  summarizeInviteHistory,
  parseInviteLink,
} from '@/lib/inviteLink';
import { INVITE_FRAGMENT_MAX_CHARS } from '@/lib/inviteHistoryLink';
import { INVITE_HISTORY_EPOCHS_MAX } from '@/lib/chatTierPolicy';

const K = (n: number) => Buffer.alloc(32, n).toString('base64');
const TOPIC = 'aaaaaaaa-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-2222-4222-8222-222222222222';

describe('building a link', () => {
  it('CONTRACT: round-trips the keys back out for the same topic', () => {
    const url = buildInviteUrl('https://x/topics/join/tok', { 4: K(1), 5: K(2) }, TOPIC);
    const hash = url.slice(url.indexOf('#'));
    expect(readInviteHistory(hash, TOPIC)).toEqual({ status: 'ok', taks: { 4: K(1), 5: K(2) } });
  });

  it('CONTRACT: the keys live in the FRAGMENT, never in the path or query', () => {
    /*
     * The whole security property in one assertion: everything before the '#'
     * is what reaches the server, so no key material may appear in it.
     */
    const url = buildInviteUrl('https://x/topics/join/tok?ref=email', { 1: K(3) }, TOPIC);
    const [beforeHash, fragment] = url.split('#');
    expect(beforeHash).toBe('https://x/topics/join/tok?ref=email');
    expect(beforeHash).not.toContain(K(3));
    expect(fragment).toContain(K(3));
  });

  it('BOUNDARY: no keys produces a link with no fragment at all', () => {
    expect(buildInviteFragment({}, TOPIC)).toBeNull();
    expect(buildInviteUrl('https://x/topics/join/tok', {}, TOPIC)).toBe('https://x/topics/join/tok');
  });

  it('BOUNDARY: one epoch and the tier ceiling both fit, tag included', () => {
    expect(buildInviteFragment({ 0: K(1) }, TOPIC)).not.toBeNull();
    const many: Record<number, string> = {};
    for (let i = 0; i < INVITE_HISTORY_EPOCHS_MAX; i++) many[i] = K(i);
    const frag = buildInviteFragment(many, TOPIC)!;
    expect(frag.length).toBeLessThan(INVITE_FRAGMENT_MAX_CHARS);
    expect(readInviteHistory(frag, TOPIC)).toMatchObject({ status: 'ok' });
  });

  it('LARGE: a key set past the ceiling yields NO fragment rather than a cut one', () => {
    // A truncated key is worse than an absent one: it is stored, opens nothing,
    // and is indistinguishable from history that was never shared.
    const tooMany: Record<number, string> = {};
    for (let i = 0; i < 200; i++) tooMany[i] = K(i);
    expect(buildInviteFragment(tooMany, TOPIC)).toBeNull();
    expect(buildInviteUrl('https://x/j/t', tooMany, TOPIC)).toBe('https://x/j/t');
  });

  it('BOUNDARY: a tag that would push the fragment past the ceiling drops it all', () => {
    const nearMax: Record<number, string> = {};
    for (let i = 0; i < INVITE_HISTORY_EPOCHS_MAX; i++) nearMax[i] = K(i);
    const hugeTopicId = 'z'.repeat(INVITE_FRAGMENT_MAX_CHARS);
    expect(buildInviteFragment(nearMax, hugeTopicId)).toBeNull();
  });

  it('UTF-8: a topic id with Korean and emoji survives tagging', () => {
    const weird = '토픽-🌟-id';
    const frag = buildInviteFragment({ 2: K(5) }, weird)!;
    expect(inviteFragmentTopicId(frag)).toBe(weird);
    expect(readInviteHistory(frag, weird)).toEqual({ status: 'ok', taks: { 2: K(5) } });
  });
});

describe('reading a link', () => {
  it('HOSTILE: a fragment tagged for a DIFFERENT topic is refused', () => {
    /*
     * Not cosmetic. An epoch key lands in the keychain slot for (topic, epoch),
     * the import refuses to overwrite a filled slot, and the device stops
     * deriving its own key for an epoch it believes it holds — so a foreign key
     * in a slot this device later occupies makes it seal archive rows under a
     * key no other member has.
     */
    const frag = buildInviteFragment({ 3: K(9) }, OTHER)!;
    expect(readInviteHistory(frag, TOPIC)).toEqual({ status: 'wrong-topic' });
  });

  it('an UNTAGGED fragment is accepted — a lost tail is not evidence of a mix-up', () => {
    expect(readInviteHistory(`h1=3.${K(9)}`, TOPIC)).toEqual({ status: 'ok', taks: { 3: K(9) } });
  });

  it('HOSTILE: a malformed percent-escape in the tag reads as untagged, not as a mismatch', () => {
    expect(inviteFragmentTopicId(`h1=1.${K(1)}&t=%E0%A4%A`)).toBeNull();
    expect(readInviteHistory(`h1=1.${K(1)}&t=%E0%A4%A`, TOPIC)).toMatchObject({ status: 'ok' });
  });

  it('EMPTY: null, undefined, empty string and a bare # are each nothing', () => {
    for (const empty of [null, undefined, '', '#']) {
      expect(readInviteHistory(empty, TOPIC)).toEqual({ status: 'none' });
      expect(inviteFragmentTopicId(empty)).toBeNull();
    }
  });

  it('EMPTY: a fragment carrying only a tag is nothing, not a mismatch', () => {
    // Nothing was shared, so there is nothing to complain about.
    expect(readInviteHistory(`t=${OTHER}`, TOPIC)).toEqual({ status: 'none' });
  });

  it('accepts a leading # so callers can pass location.hash unchanged', () => {
    const frag = buildInviteFragment({ 6: K(2) }, TOPIC)!;
    expect(readInviteHistory(`#${frag}`, TOPIC)).toEqual({ status: 'ok', taks: { 6: K(2) } });
    expect(inviteFragmentTopicId(`#${frag}`)).toBe(TOPIC);
  });

  it('LARGE: an over-long fragment is refused on the way in', () => {
    expect(inviteFragmentTopicId(`t=${'x'.repeat(INVITE_FRAGMENT_MAX_CHARS)}`)).toBeNull();
  });
});

describe('parsing what somebody pasted', () => {
  it('CONTRACT: a full link yields the token AND keeps the fragment', () => {
    // Dropping the fragment here is the quiet failure: the join works and the
    // keys — the only copy — are discarded with nothing said.
    const url = buildInviteUrl('https://openstoa.xyz/topics/join/tok123', { 2: K(1) }, TOPIC);
    const parsed = parseInviteLink(url)!;
    expect(parsed.code).toBe('tok123');
    expect(readInviteHistory(parsed.fragment, TOPIC)).toEqual({ status: 'ok', taks: { 2: K(1) } });
  });

  it('a bare code is an invite too, and carries no fragment', () => {
    expect(parseInviteLink('tok123')).toEqual({ code: 'tok123', fragment: '' });
  });

  it('BOUNDARY: surrounding whitespace and a query string are stripped', () => {
    expect(parseInviteLink('  https://x/topics/join/tok123?utm=1#h1=2.' + K(1))).toMatchObject({
      code: 'tok123',
    });
    expect(parseInviteLink('  tok123  ')).toEqual({ code: 'tok123', fragment: '' });
  });

  it('EMPTY: null, undefined, empty and whitespace-only are each nothing', () => {
    for (const empty of [null, undefined, '', '   ', '/', '///']) {
      expect(parseInviteLink(empty), String(empty)).toBeNull();
    }
  });

  it('HOSTILE: a pasted sentence is refused rather than posted as a code', () => {
    expect(parseInviteLink('join my topic please')).toBeNull();
  });

  it('a percent-escaped segment is decoded back to the token', () => {
    expect(parseInviteLink('https://x/topics/join/tok%20123')).toBeNull(); // decodes to a space — not a token
    expect(parseInviteLink('https://x/topics/join/t%C3%B6k')).toEqual({ code: 'tök', fragment: '' });
  });
});

describe('what the link comes to, in messages', () => {
  const rows = [
    { takVersion: 4, createdAt: '2026-08-10T00:00:00.000Z' },
    { takVersion: 5, createdAt: '2026-08-12T09:00:00.000Z' },
    { takVersion: 5, createdAt: '2026-08-12T10:00:00.000Z' },
    { takVersion: 6, createdAt: '2026-08-13T00:00:00.000Z' },
  ];

  it('INTEGRITY: counts only the epochs actually being shared', () => {
    expect(summarizeInviteHistory(rows, [5, 6])).toEqual({
      messages: 3,
      since: '2026-08-12T09:00:00.000Z',
    });
  });

  it('INTEGRITY: `since` is the OLDEST shared row, and widening the offer only moves it back', () => {
    const narrow = summarizeInviteHistory(rows, [6]);
    const wide = summarizeInviteHistory(rows, [4, 5, 6]);
    expect(wide.messages).toBeGreaterThan(narrow.messages);
    expect(Date.parse(wide.since!)).toBeLessThan(Date.parse(narrow.since!));
    expect(wide.since).toBe('2026-08-10T00:00:00.000Z');
  });

  it('BOUNDARY: sharing no epochs comes to nothing', () => {
    expect(summarizeInviteHistory(rows, [])).toEqual({ messages: 0, since: null });
  });

  it('EMPTY: no archive, an empty archive, and a null archive are each nothing', () => {
    expect(summarizeInviteHistory([], [1])).toEqual({ messages: 0, since: null });
    expect(summarizeInviteHistory(null, [1])).toEqual({ messages: 0, since: null });
    expect(summarizeInviteHistory(undefined, [1])).toEqual({ messages: 0, since: null });
  });

  it('an epoch with no archived messages is a real answer: 0, not a missing one', () => {
    // The inviter is entitled to know the window they chose is empty.
    expect(summarizeInviteHistory(rows, [99])).toEqual({ messages: 0, since: null });
  });

  it('HOSTILE: an unparseable timestamp still counts, but cannot start the window', () => {
    const withJunk = [{ takVersion: 7, createdAt: 'not-a-date' }, { takVersion: 7, createdAt: '2026-08-14T00:00:00.000Z' }];
    expect(summarizeInviteHistory(withJunk, [7])).toEqual({
      messages: 2,
      since: '2026-08-14T00:00:00.000Z',
    });
    expect(summarizeInviteHistory([{ takVersion: 7, createdAt: 'nope' }], [7])).toEqual({
      messages: 1,
      since: null,
    });
  });
});

describe('shared rule', () => {
  it('is BYTE-IDENTICAL to the mini-app copy, so a link made on one opens on the other', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const web = readFileSync(join(process.cwd(), 'src/lib/inviteLink.ts'), 'utf8');
    const mobile = readFileSync(join(process.cwd(), 'packages/mobile/src/lib/inviteLink.ts'), 'utf8');
    expect(mobile).toBe(web);
  });
});
