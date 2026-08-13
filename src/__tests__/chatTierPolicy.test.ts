import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  tierPolicy,
  serverMayHoldKey,
  isEndToEndEncrypted,
  inviteHistoryCount,
  chatTierOf,
  INVITE_HISTORY_DEFAULT,
  INVITE_HISTORY_MAX,
  type ChatTier,
} from '@/lib/chatTierPolicy';

const ALL_TIERS: ChatTier[] = ['public', 'private', 'secret', 'dm'];

/**
 * These rules are a security boundary, not a preference, so the tests assert
 * the boundary itself rather than the table that expresses it. A change that
 * lets the server hold a key it must not hold has to fail here.
 */
describe('serverMayHoldKey', () => {
  it('CONTRACT: only `public` lets the server hold the key', () => {
    expect(serverMayHoldKey('public')).toBe(true);
    for (const tier of ['private', 'secret', 'dm'] as const) {
      expect(serverMayHoldKey(tier), tier).toBe(false);
    }
  });

  it('REGRESSION: private is NOT the simpler topic-root tier', () => {
    /*
     * It nearly was. Posts in a private topic are readable by anyone signed in,
     * so "private chat can be loose too" looked reasonable — until the chat
     * route turned out to answer 403 to every non-member in every tier. The
     * conversation is members-only, so removal has to bite, so the keys are per
     * epoch.
     */
    expect(tierPolicy('private').keyModel).toBe('per-epoch');
    expect(tierPolicy('private')).toEqual(tierPolicy('secret'));
  });
});

describe('isEndToEndEncrypted', () => {
  it('is exactly the negation of the server holding the key', () => {
    // Derived, never stored twice: a banner that promises encryption over a
    // tier the server can read is the worst thing this module can prevent.
    for (const tier of ALL_TIERS) {
      expect(isEndToEndEncrypted(tier), tier).toBe(!serverMayHoldKey(tier));
    }
  });

  it('public is NOT end-to-end encrypted, and the others are', () => {
    expect(isEndToEndEncrypted('public')).toBe(false);
    expect(isEndToEndEncrypted('private')).toBe(true);
    expect(isEndToEndEncrypted('secret')).toBe(true);
    expect(isEndToEndEncrypted('dm')).toBe(true);
  });
});

describe('tierPolicy', () => {
  it('every tier is described — none falls through', () => {
    for (const tier of ALL_TIERS) {
      const p = tierPolicy(tier);
      expect(p, tier).toBeDefined();
      expect(['topic-root', 'per-epoch']).toContain(p.keyModel);
      expect(['server', 'invite-link', 'on-accept']).toContain(p.keyDelivery);
    }
  });

  it('CONTRACT: a key is delivered by the server ONLY where the server may hold one', () => {
    for (const tier of ALL_TIERS) {
      if (tierPolicy(tier).keyDelivery === 'server') {
        expect(serverMayHoldKey(tier), tier).toBe(true);
      }
    }
  });

  it('CONTRACT: a bounded window implies per-epoch keys', () => {
    // A single root cannot express a window — hand it over and everything opens,
    // now and after the holder is removed.
    for (const tier of ALL_TIERS) {
      if (tierPolicy(tier).historyForLaterJoiner === 'window') {
        expect(tierPolicy(tier).keyModel, tier).toBe('per-epoch');
      }
    }
  });
});

describe('inviteHistoryCount', () => {
  it('defaults to the WhatsApp-shaped window', () => {
    expect(inviteHistoryCount('private', undefined)).toBe(INVITE_HISTORY_DEFAULT);
    expect(inviteHistoryCount('secret', undefined)).toBe(INVITE_HISTORY_DEFAULT);
  });

  it('an inviter may share nothing — 0 is a real answer, not a missing one', () => {
    expect(inviteHistoryCount('secret', 0)).toBe(0);
  });

  it('BOUNDARY: the ceiling holds', () => {
    expect(inviteHistoryCount('secret', INVITE_HISTORY_MAX)).toBe(INVITE_HISTORY_MAX);
    expect(inviteHistoryCount('secret', INVITE_HISTORY_MAX + 1)).toBe(INVITE_HISTORY_MAX);
    expect(inviteHistoryCount('secret', 1_000_000)).toBe(INVITE_HISTORY_MAX);
  });

  it('HOSTILE: a negative or fractional count shares nothing rather than guessing', () => {
    for (const bad of [-1, -1000, 1.5, NaN, Infinity]) {
      expect(inviteHistoryCount('secret', bad as number), String(bad)).toBe(0);
    }
  });

  it('tiers whose key opens everything have no window to bound', () => {
    // Asking for 50 messages of a topic-root tier is meaningless: the key that
    // travels with the invite already opens all of it.
    expect(inviteHistoryCount('public', 50)).toBe(0);
    expect(inviteHistoryCount('dm', 50)).toBe(0);
  });
});

describe('chatTierOf', () => {
  it('a DM is a DM whatever visibility the row happens to carry', () => {
    for (const v of ['public', 'private', 'secret', null, undefined, 'nonsense']) {
      expect(chatTierOf(v, true), String(v)).toBe('dm');
    }
  });

  it('maps the visibilities it knows', () => {
    expect(chatTierOf('public', false)).toBe('public');
    expect(chatTierOf('private', false)).toBe('private');
    expect(chatTierOf('secret', false)).toBe('secret');
  });

  it('HOSTILE: an unknown visibility falls back to the LEAST-promising tier', () => {
    /*
     * Public promises the least — it is the one tier that does not claim the
     * server cannot read. A bad value can therefore only make us under-promise,
     * never claim an encryption guarantee we are not providing.
     */
    for (const v of [null, undefined, '', 'PRIVATE', 'sekret', '{}']) {
      expect(chatTierOf(v, false), String(v)).toBe('public');
      expect(isEndToEndEncrypted(chatTierOf(v, false))).toBe(false);
    }
  });
});

describe('shared rule', () => {
  it('is BYTE-IDENTICAL to the mini-app copy, so both clients apply one policy', () => {
    const web = readFileSync(join(process.cwd(), 'src/lib/chatTierPolicy.ts'), 'utf8');
    const mobile = readFileSync(join(process.cwd(), 'packages/mobile/src/lib/chatTierPolicy.ts'), 'utf8');
    expect(mobile).toBe(web);
  });
});
