/**
 * When a room offers to ask a member for the keys, and what it says.
 *
 * WHY THE DECISION IS A SEPARATE FILE. The room already has six pieces of state
 * competing over what to draw; the question "should this room offer to ask" has
 * one right answer per situation and is worth being able to check without a
 * renderer, a network call, or a device.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → locked + askable tier + no request → offer; asked → waiting;
 *               granted → granted; in flight → sending
 *   authz     → `public` never offers: the server holds the archive root, so a
 *               locked row there means something else and this button would
 *               send the person down the wrong path
 *   boundary  → lockedCount 0 / 1 / many; a negative count is not an offer
 *   integrity → DM says "them", not "a member" — there is no group to appeal to
 *   integrity → only `offer` is pressable, so a waiting room cannot be re-asked
 *               by tapping the line that says it is waiting
 *   boundary  → `oldestReadableEpoch` keeps 0, which is a real answer
 *   hostile   → nonsense epochs are ignored rather than becoming the minimum
 *   empty     → no epochs at all → null, meaning "send everything"
 */
import { describe, it, expect } from 'vitest';
import {
  askStatus,
  askLabelKey,
  askIsPressable,
  tierCanAsk,
  oldestReadableEpoch,
} from '../lib/keyRequest';

const base = { lockedCount: 3, tier: 'private', mine: null, sending: false } as const;

describe('which tiers can be asked', () => {
  it('AUTHZ: private, secret and dm can; public cannot', () => {
    expect(tierCanAsk('private')).toBe(true);
    expect(tierCanAsk('secret')).toBe(true);
    expect(tierCanAsk('dm')).toBe(true);
    // The server holds the archive root for a public room and hands it to any
    // member, so an "ask a member" button would be answering the wrong question.
    expect(tierCanAsk('public')).toBe(false);
  });

  it('HOSTILE: an unknown tier is not askable', () => {
    for (const t of ['', 'PRIVATE', 'dm ', 'secret-ish', 'undefined']) {
      expect(tierCanAsk(t), t).toBe(false);
    }
  });
});

describe('what the room shows', () => {
  it('CONTRACT: locked rows and no request yet → offer', () => {
    expect(askStatus({ ...base })).toBe('offer');
  });

  it('CONTRACT: asked → waiting; granted → granted; in flight → sending', () => {
    expect(askStatus({ ...base, mine: { granted: false } })).toBe('waiting');
    expect(askStatus({ ...base, mine: { granted: true } })).toBe('granted');
    expect(askStatus({ ...base, sending: true })).toBe('sending');
  });

  it('CONTRACT: sending wins over everything — one thing at a time', () => {
    expect(askStatus({ ...base, mine: { granted: true }, sending: true })).toBe('sending');
  });

  it('BOUNDARY: nothing locked → hidden, whatever else is true', () => {
    expect(askStatus({ ...base, lockedCount: 0 })).toBe('hidden');
    expect(askStatus({ ...base, lockedCount: 0, mine: { granted: false } })).toBe('hidden');
    // A negative count is not a reason to offer anything.
    expect(askStatus({ ...base, lockedCount: -1 })).toBe('hidden');
  });

  it('BOUNDARY: one locked row is enough to offer', () => {
    expect(askStatus({ ...base, lockedCount: 1 })).toBe('offer');
  });

  it('AUTHZ: a public room never offers, even with locked rows', () => {
    expect(askStatus({ ...base, tier: 'public' })).toBe('hidden');
    expect(askStatus({ ...base, tier: 'public', mine: { granted: false } })).toBe('hidden');
  });
});

describe('what it says', () => {
  it('INTEGRITY: a DM asks THEM, not "a member"', () => {
    /*
     * "Ask a member" in a conversation with exactly one other person reads as
     * though there is a group to appeal to, and leaves the person wondering who.
     */
    expect(askLabelKey('offer', 'dm')).toBe('openstoa.keyRequest.askPeer');
    expect(askLabelKey('offer', 'private')).toBe('openstoa.keyRequest.askMember');
    expect(askLabelKey('waiting', 'dm')).toBe('openstoa.keyRequest.waitingPeer');
    expect(askLabelKey('waiting', 'secret')).toBe('openstoa.keyRequest.waiting');
  });

  it('hidden has nothing to say', () => {
    expect(askLabelKey('hidden', 'private')).toBeNull();
  });

  it('INTEGRITY: only the offer is pressable', () => {
    // Otherwise tapping the line that says "asked" sends a second request, and
    // the person learns that tapping does nothing visible.
    expect(askIsPressable('offer')).toBe(true);
    for (const s of ['hidden', 'waiting', 'granted', 'sending'] as const) {
      expect(askIsPressable(s), s).toBe(false);
    }
  });
});

describe('how much to ask for', () => {
  it('BOUNDARY: epoch 0 is kept — it is a real answer', () => {
    /*
     * "I can read from the very first epoch". The falsy check that turns it into
     * null would ask a member to re-send the entire history every time.
     */
    expect(oldestReadableEpoch([0, 5, 9])).toBe(0);
    expect(oldestReadableEpoch([0])).toBe(0);
  });

  it('picks the oldest, not the newest or the first seen', () => {
    expect(oldestReadableEpoch([9, 3, 7])).toBe(3);
  });

  it('EMPTY: nothing readable → null, meaning "send everything"', () => {
    expect(oldestReadableEpoch([])).toBeNull();
  });

  it('HOSTILE: nonsense is ignored rather than becoming the minimum', () => {
    // A -1 or a NaN sneaking in as the minimum would ask for a range that does
    // not exist, and the grant would come back empty.
    expect(oldestReadableEpoch([-1, 4, 8])).toBe(4);
    expect(oldestReadableEpoch([Number.NaN, 2])).toBe(2);
    expect(oldestReadableEpoch([1.5, 6])).toBe(6);
    expect(oldestReadableEpoch([Number.POSITIVE_INFINITY])).toBeNull();
    expect(oldestReadableEpoch([-3, -1])).toBeNull();
  });
});

describe('a room with nobody else in it', () => {
  /*
   * THE TRAP. A personal space is a secret topic, so the tier says `secret` and
   * every rule about asking a member applies to it — except the one that
   * matters: there is no member to ask. Without this the room offers "ask a
   * member to unlock this history", the person taps it, the request is filed
   * perfectly, and nothing ever answers. A control that cannot work is worse
   * than none: it replaces the true answer — only your recovery code brings
   * this back — with an indefinite wait.
   *
   * EDGE-CASE MATRIX (CLAUDE.md) → coverage
   *   contract  → locked rows in a personal space say so, and offer nothing
   *   integrity → the answer is not pressable; there is nothing to press
   *   boundary  → nothing locked means nothing shown, personal or not
   *   integrity → a NORMAL secret room still offers the ask
   *   race      → an in-flight send still reads as sending, not as alone
   */
  const base = { tier: 'secret', mine: null, sending: false };

  it('CONTRACT: locked rows in your own space explain, rather than offer', () => {
    expect(askStatus({ ...base, lockedCount: 3, personal: true })).toBe('alone');
    expect(askLabelKey('alone', 'secret')).toBe('openstoa.keyRequest.aloneHere');
  });

  it('INTEGRITY: there is nothing to press', () => {
    expect(askIsPressable('alone')).toBe(false);
  });

  it('BOUNDARY: nothing locked shows nothing, personal or not', () => {
    expect(askStatus({ ...base, lockedCount: 0, personal: true })).toBe('hidden');
  });

  it('INTEGRITY: an ordinary secret room still offers the ask', () => {
    // The flag must not leak into rooms that DO have someone to ask.
    expect(askStatus({ ...base, lockedCount: 3, personal: false })).toBe('offer');
    expect(askStatus({ ...base, lockedCount: 3 })).toBe('offer');
  });

  it('RACE: a send in flight still reads as sending', () => {
    // `sending` is about a request this device just made; it wins, or the
    // spinner vanishes mid-flight and the person taps again.
    expect(askStatus({ ...base, lockedCount: 3, personal: true, sending: true })).toBe('sending');
  });
});
