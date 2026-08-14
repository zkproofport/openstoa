/**
 * The claims each tier is allowed to make — derived, never typed twice.
 *
 * What is defended here is one sentence: **the interface must not promise
 * encryption over a tier whose key the server holds.** `public` is exactly that
 * tier — its archive root lives on the server so a later joiner reads history
 * without waiting for another member — and the single banner string this
 * replaces said "the server cannot read this" in every room, which was false in
 * the tier most people are in.
 *
 * Everything below therefore compares copy selection against
 * `chatTierPolicy.ts` rather than against a second table. A change to the
 * policy either carries the interface with it or fails here.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   contract          → 'the E2EE claim is exactly isEndToEndEncrypted',
 *                       'public NEVER claims end-to-end encryption',
 *                       'the operator column and the banner answer the same
 *                       question', 'every tier is covered by TIER_ORDER'
 *   boundary          → every tier asserted individually, including dm
 *   hostile input     → 'an unrecognised visibility falls back to the tier that
 *                       promises least' (via chatTierOf), incl. 'PRIVATE',
 *                       '{}', a 10 000-character string
 *   empty/null/undef  → null, undefined and '' asserted separately
 *   result integrity  → 'a bounded-window tier is never described as showing
 *                       everything', 'access facts match the routes that
 *                       enforce them'
 *   UTF-8             → copy assertions live in chatTierUi.test.tsx (both
 *                       locales); this module holds no strings.
 *   authorization / race / large payload → N/A: pure functions over a tier.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TIER_ORDER,
  chatClaimKey,
  historyClaimKey,
  operatorCanReadChat,
  tierAccess,
} from '@/lib/chatTierExplainer';
import {
  chatTierOf,
  isEndToEndEncrypted,
  serverMayHoldKey,
  tierPolicy,
  type ChatTier,
} from '@/lib/chatTierPolicy';

describe('the encryption claim', () => {
  it('CONTRACT: public NEVER claims end-to-end encryption', () => {
    /*
     * The single assertion this whole file exists for. The server holds the
     * public archive root; a banner that says otherwise is the product lying
     * about the one property it sells.
     */
    expect(chatClaimKey('public')).toBe('serverReadable');
    expect(serverMayHoldKey('public')).toBe(true);
  });

  it('CONTRACT: the claim is exactly the policy, tier by tier', () => {
    for (const tier of TIER_ORDER) {
      expect(chatClaimKey(tier), tier).toBe(isEndToEndEncrypted(tier) ? 'e2ee' : 'serverReadable');
    }
  });

  it('CONTRACT: no tier claims e2ee while the server may hold its key', () => {
    // The invariant stated in the other direction, so a future tier added to
    // the policy cannot slip through by matching neither branch above.
    for (const tier of TIER_ORDER) {
      if (chatClaimKey(tier) === 'e2ee') {
        expect(serverMayHoldKey(tier), tier).toBe(false);
      }
    }
  });

  it('private, secret and DM do claim it — the promise is real where it is real', () => {
    for (const tier of ['private', 'secret', 'dm'] as const) {
      expect(chatClaimKey(tier), tier).toBe('e2ee');
    }
  });

  it('CONTRACT: the docs table answers the operator question the same way the banner does', () => {
    for (const tier of TIER_ORDER) {
      expect(operatorCanReadChat(tier), tier).toBe(chatClaimKey(tier) === 'serverReadable');
    }
  });
});

describe('the history claim', () => {
  it('CONTRACT: it follows historyForLaterJoiner, except where there is no later joiner', () => {
    for (const tier of TIER_ORDER) {
      if (tier === 'dm') continue;
      const expected = tierPolicy(tier).historyForLaterJoiner === 'all' ? 'all' : 'window';
      expect(historyClaimKey(tier), tier).toBe(expected);
    }
  });

  it('a DM says the question does not arise, rather than "everything"', () => {
    /*
     * The policy answers 'all' for a DM — true about the key, misleading as a
     * sentence, because nobody joins a DM later. Saying "a later member sees
     * everything" about a two-person room invents a member who cannot exist.
     */
    expect(tierPolicy('dm').historyForLaterJoiner).toBe('all');
    expect(historyClaimKey('dm')).toBe('dm');
  });

  it('INTEGRITY: a bounded-window tier is never described as showing everything', () => {
    for (const tier of TIER_ORDER) {
      if (tierPolicy(tier).historyForLaterJoiner === 'window') {
        expect(historyClaimKey(tier), tier).toBe('window');
      }
    }
  });
});

describe('access facts', () => {
  it('every tier has a complete row', () => {
    for (const tier of TIER_ORDER) {
      const a = tierAccess(tier);
      expect(['anyone', 'listed', 'hidden', 'participants'], tier).toContain(a.find);
      expect(['open', 'invite', 'accept'], tier).toContain(a.join);
      expect(['anyone', 'signedIn', 'members', 'none'], tier).toContain(a.posts);
    }
  });

  it('INTEGRITY: a private topic hides its CONVERSATION, not its posts', () => {
    /*
     * The decision this table follows: private posts are readable by any
     * signed-in account, member or not, and what membership buys is the chat.
     * `src/app/api/topics/[topicId]/posts/route.ts` and
     * `src/app/api/posts/[postId]/route.ts` both admit a signed-in non-member
     * to a private topic; `secret` stays members-only in both.
     */
    expect(tierAccess('private').posts).toBe('signedIn');
    expect(tierAccess('secret').posts).toBe('members');
    expect(tierAccess('public').posts).toBe('anyone');
  });

  it('INTEGRITY: private and secret are BOTH invite-only — there is no approval flow', () => {
    /*
     * `POST /api/topics/{id}/join` answers 403 for anything that is not public.
     * The approval path (202 + a pending request) was removed: a private
     * topic's invite link carries the chat-history keys in its fragment, so an
     * approved member would arrive with no way to read anything.
     */
    expect(tierAccess('private').join).toBe('invite');
    expect(tierAccess('secret').join).toBe('invite');
    expect(tierAccess('public').join).toBe('open');
  });

  it('INTEGRITY: private and secret differ in visibility, not in how you get in', () => {
    // Both invite-only; the difference is that a secret topic is not listed and
    // its posts are members-only.
    expect(tierAccess('private').join).toBe(tierAccess('secret').join);
    expect(tierAccess('private').find).not.toBe(tierAccess('secret').find);
    expect(tierAccess('private').posts).not.toBe(tierAccess('secret').posts);
  });

  it('secret is the only tier hidden from listings', () => {
    expect(tierAccess('secret').find).toBe('hidden');
    expect(tierAccess('public').find).toBe('anyone');
    expect(tierAccess('private').find).toBe('listed');
  });

  it('a DM has no posts at all', () => {
    expect(tierAccess('dm').posts).toBe('none');
    expect(tierAccess('dm').join).toBe('accept');
  });
});

describe('TIER_ORDER', () => {
  it('CONTRACT: covers every tier the policy knows, weakest first', () => {
    // A tier missing here is a row missing from the docs table — silently.
    const ALL: ChatTier[] = ['public', 'private', 'secret', 'dm'];
    expect([...TIER_ORDER].sort()).toEqual([...ALL].sort());
    expect(TIER_ORDER[0]).toBe('public');
  });

  it('every tier resolves through the whole chain without throwing', () => {
    for (const tier of TIER_ORDER) {
      expect(() => {
        chatClaimKey(tier);
        historyClaimKey(tier);
        tierAccess(tier);
        operatorCanReadChat(tier);
      }, tier).not.toThrow();
    }
  });
});

describe('what the clients pass in', () => {
  /*
   * Both banners derive their tier with `chatTierOf(visibility, isDm)` from a
   * value fetched over the network. These cases are the shapes that arrive when
   * that fetch is slow, partial, or wrong.
   */
  it('EMPTY: undefined, null and empty-string visibility each fall back to public', () => {
    expect(chatClaimKey(chatTierOf(undefined, false))).toBe('serverReadable');
    expect(chatClaimKey(chatTierOf(null, false))).toBe('serverReadable');
    expect(chatClaimKey(chatTierOf('', false))).toBe('serverReadable');
  });

  it('HOSTILE: unrecognised visibility never buys an encryption promise', () => {
    for (const v of ['PRIVATE', 'Secret', 'sekret', '{}', '[]', 'null', '../private']) {
      expect(chatClaimKey(chatTierOf(v, false)), v).toBe('serverReadable');
    }
  });

  it('LARGE: a 10 000-character visibility falls back rather than throwing', () => {
    const huge = 'x'.repeat(10_000);
    expect(chatClaimKey(chatTierOf(huge, false))).toBe('serverReadable');
  });

  it('RACE: the pre-resolution default is the tier that promises least', () => {
    /*
     * Both panels initialise `visibility` to 'public' and only replace it once
     * the topic lookup lands. That direction is deliberate: a room may be
     * upgraded to "the service cannot read this" once that is known, but a
     * promise already shown must never be withdrawn.
     */
    expect(chatClaimKey(chatTierOf('public', false))).toBe('serverReadable');
    expect(isEndToEndEncrypted(chatTierOf(undefined, false))).toBe(false);
  });

  it('a DM is a DM whatever visibility its row carries', () => {
    for (const v of ['public', 'private', 'secret', null, undefined, 'nonsense']) {
      expect(chatClaimKey(chatTierOf(v, true)), String(v)).toBe('e2ee');
      expect(historyClaimKey(chatTierOf(v, true)), String(v)).toBe('dm');
    }
  });
});

describe('shared rule', () => {
  it('is BYTE-IDENTICAL to the mini-app copy, so both clients make one claim', () => {
    const web = readFileSync(join(process.cwd(), 'src/lib/chatTierExplainer.ts'), 'utf8');
    const mobile = readFileSync(
      join(process.cwd(), 'packages/mobile/src/lib/chatTierExplainer.ts'),
      'utf8',
    );
    expect(mobile).toBe(web);
  });
});
