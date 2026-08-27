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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  askStatus,
  askLabelKey,
  askIsPressable,
  nobodyToAsk,
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
  it('CONTRACT: locked rows and no request yet → the ask is offered', () => {
    /*
     * INVERTED 2026-08-27 rather than deleted. `base` carries no member count, so
     * this case was always the UNKNOWN one — it asserted `offer`, whose label
     * claims "ask a member", for a room nobody had counted. The remedy is still
     * offered; the claim is what went away.
     */
    expect(askStatus({ ...base })).toBe('offerUnsure');
    expect(askLabelKey(askStatus({ ...base }), 'secret')).not.toBeNull();
    // A counted room of two is where the original wording belongs.
    expect(askStatus({ ...base, memberCount: 2 })).toBe('offer');
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
    // The count, not the row, decides the WORDING — so both shapes are pinned.
    expect(askStatus({ ...base, lockedCount: 1 })).toBe('offerUnsure');
    expect(askStatus({ ...base, lockedCount: 1, memberCount: 2 })).toBe('offer');
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
    // The flag must not leak into rooms that DO have someone to ask. With a real
    // count it is the claiming wording; without one it is still an offer.
    expect(askStatus({ ...base, lockedCount: 3, personal: false, memberCount: 5 })).toBe('offer');
    expect(askStatus({ ...base, lockedCount: 3, personal: false })).toBe('offerUnsure');
    expect(askStatus({ ...base, lockedCount: 3 })).toBe('offerUnsure');
  });

  it('RACE: a send in flight still reads as sending', () => {
    // `sending` is about a request this device just made; it wins, or the
    // spinner vanishes mid-flight and the person taps again.
    expect(askStatus({ ...base, lockedCount: 3, personal: true, sending: true })).toBe('sending');
  });
});

describe('nobody to ask, counted rather than flagged', () => {
  /*
   * THE REPORT. A phone opened its owner's own space — one member, nobody else
   * — and the room offered "ask a member to unlock this history". The flag that
   * was supposed to prevent exactly this was already in place and already
   * tested, which is the interesting part: the RULE was right and the INPUT
   * never arrived. It reaches the screen through one optional field of one
   * best-effort fetch wrapped in `catch {}`, and every way that fetch can
   * disappoint — an older client build with no such field, an error swallowed
   * by the catch, a response served from cache — ends at `false`, which is the
   * answer that shows the button.
   *
   * SO THE QUESTION IS ASKED OF THE MEMBERSHIP INSTEAD. `memberCount` rides in
   * the same response the flag does, and it says the thing the room actually
   * needs to know. It is also true in rooms the flag can never speak for: the
   * last member of a secret topic everyone else left, and a DM whose peer
   * deleted their account. Both of those offered the same dead button.
   *
   * THE THIRD CASE — members exist, but every device that holds the keys is a
   * dead leaf of one phone — is NOT decided here. Nothing the client can read
   * distinguishes a member who will answer from one who cannot: the members
   * endpoint returns user ids, the key-request endpoint returns only this
   * device's own row, and a leaf existing says nothing about whether the phone
   * behind it still has the epoch. Guessing it from elapsed time would replace
   * one confident wrong answer with another.
   *
   * EDGE-CASE MATRIX (CLAUDE.md) → coverage
   *   contract  → one member and no flag at all → alone (the reported bug)
   *   contract  → two members → the ask, which is the right control there
   *   contract  → a DM with its peer still in it keeps the peer wording
   *   boundary  → 0, 1, 2, and a very large count
   *   empty     → null, undefined and a missing key all mean UNKNOWN, and
   *               unknown keeps the ask rather than inventing loneliness
   *   hostile   → NaN, ±Infinity, a numeric STRING and a negative count
   *   integrity → alone outranks a request already filed and even one marked
   *               granted: in a room with nobody in it, a row saying otherwise
   *               is stale, and "waiting" is the exact lie being removed
   *   integrity → the two signals are independent — either alone is enough
   *   race      → before the lookup answers, the tier is still `public`, so
   *               nothing is offered at all and the button cannot flicker in
   *   cumulative→ the same room entered fifty times gives the same verdict
   */
  const base = { lockedCount: 3, tier: 'secret' as const, mine: null, sending: false };

  it('CONTRACT: one member and no flag at all → alone', () => {
    // The reported screen, exactly: `personal` never arrived.
    expect(askStatus({ ...base, memberCount: 1 })).toBe('alone');
    expect(askLabelKey('alone', 'secret')).toBe('openstoa.keyRequest.aloneHere');
    expect(askIsPressable('alone')).toBe(false);
  });

  it('CONTRACT: two members → the ask, in both wordings', () => {
    expect(askStatus({ ...base, memberCount: 2 })).toBe('offer');
    expect(askLabelKey('offer', 'secret')).toBe('openstoa.keyRequest.askMember');
    expect(askStatus({ ...base, tier: 'dm', memberCount: 2 })).toBe('offer');
    expect(askLabelKey('offer', 'dm')).toBe('openstoa.keyRequest.askPeer');
  });

  it('CONTRACT: a DM whose peer is gone is alone, not waiting on them', () => {
    // The peer deleted their account, so the membership row went with it.
    expect(askStatus({ ...base, tier: 'dm', memberCount: 1 })).toBe('alone');
  });

  it('BOUNDARY: 0 and 1 are alone; 2 and a crowd are not', () => {
    expect(askStatus({ ...base, memberCount: 0 })).toBe('alone');
    expect(askStatus({ ...base, memberCount: 1 })).toBe('alone');
    expect(askStatus({ ...base, memberCount: 2 })).toBe('offer');
    expect(askStatus({ ...base, memberCount: 1_000_000_000 })).toBe('offer');
  });

  it('EMPTY: an unknown count still offers, and still does not claim', () => {
    /*
     * Three separate absences, checked separately: three different ways for the
     * lookup not to have answered, and collapsing them is how one of them ends
     * up meaning "alone".
     *
     * INVERTED 2026-08-27. The old expectation was `offer`, which reads "ask a
     * member" — a claim about a room nobody counted, and false in the room this
     * defect was reported from. Unknown keeps the button and loses the sentence.
     */
    for (const mc of [null, undefined]) {
      expect(askStatus({ ...base, memberCount: mc })).toBe('offerUnsure');
    }
    expect(askStatus({ ...base })).toBe('offerUnsure');
    expect(askLabelKey('offerUnsure', 'secret')).not.toBe('openstoa.keyRequest.askMember');
  });

  it('HOSTILE: nonsense is unknown, not lonely', () => {
    for (const n of [NaN, Infinity, -Infinity, '1' as unknown as number, '' as unknown as number]) {
      expect(askStatus({ ...base, memberCount: n }), String(n)).toBe('offerUnsure');
    }
    // A negative count is not nonsense in the same way — it is still fewer
    // people than two — but it should never appear, so it is pinned here.
    expect(askStatus({ ...base, memberCount: -1 })).toBe('alone');
  });

  it('INTEGRITY: alone outranks a request that was already filed', () => {
    // This IS the lie being removed: the ask went out and the row exists, but
    // in a room of one nothing can ever answer it.
    expect(askStatus({ ...base, memberCount: 1, mine: { granted: false } })).toBe('alone');
    expect(askStatus({ ...base, memberCount: 1, mine: { granted: true } })).toBe('alone');
    // And a room that HAS members still reports both of those normally.
    expect(askStatus({ ...base, memberCount: 2, mine: { granted: false } })).toBe('waiting');
    expect(askStatus({ ...base, memberCount: 2, mine: { granted: true } })).toBe('granted');
  });

  it('INTEGRITY: either signal alone is enough, and neither cancels the other', () => {
    expect(nobodyToAsk({ personal: true })).toBe(true);
    expect(nobodyToAsk({ memberCount: 1 })).toBe(true);
    expect(nobodyToAsk({ personal: true, memberCount: 9 })).toBe(true);
    expect(nobodyToAsk({ personal: false, memberCount: 1 })).toBe(true);
    expect(nobodyToAsk({ personal: false, memberCount: 2 })).toBe(false);
    expect(nobodyToAsk({})).toBe(false);
  });

  it('INTEGRITY: nothing locked still shows nothing, however alone the room is', () => {
    expect(askStatus({ ...base, lockedCount: 0, memberCount: 1 })).toBe('hidden');
    expect(askStatus({ ...base, lockedCount: 0, memberCount: 1, personal: true })).toBe('hidden');
  });

  it('INTEGRITY: a public room is still not asked about, alone or not', () => {
    expect(askStatus({ ...base, tier: 'public', memberCount: 1 })).toBe('hidden');
  });

  it('RACE: the button cannot flicker in before the lookup answers', () => {
    /*
     * Tier, flag and count all come out of the SAME response, and the room
     * starts at `public` — which is the tier that offers nothing. So the first
     * frames show no control at all rather than the ask, and the answer that
     * replaces them is already the settled one.
     */
    expect(askStatus({ ...base, tier: 'public', memberCount: null, personal: false })).toBe('hidden');
    expect(askStatus({ ...base, memberCount: 1, personal: false })).toBe('alone');
  });

  it('CUMULATIVE: fifty entries into the same room give the same verdict', () => {
    // Re-entering a room re-runs the lookup, and the decision is a pure
    // function of what it returns — no counter, no accumulation, nothing that
    // could drift on the fiftieth visit the way it did not on the first.
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(askStatus({ ...base, tier: 'public', memberCount: null }));
      seen.add(askStatus({ ...base, memberCount: 1 }));
    }
    expect([...seen].sort()).toEqual(['alone', 'hidden']);
  });
});

describe('the room actually asks the question', () => {
  /*
   * The decision above is worthless if the screen never hands it the count —
   * which is precisely the shape of the reported bug: a correct rule starved of
   * its input. Read from source, because the failure mode is an ABSENCE and no
   * other test in this package mounts `ChatRoomScreen`.
   *
   * COMMENTS ARE STRIPPED FIRST. This file's own subject matter guarantees the
   * word `memberCount` appears in the screen's prose whether or not the code
   * uses it, so a raw `includes` would pass on a comment alone.
   *
   * EDGE-CASE MATRIX (CLAUDE.md) → coverage
   *   contract  → the count is read out of the response and put into state
   *   contract  → the count is passed to `askStatus`
   *   integrity → a non-number is stored as null, so absence stays unknown
   *   integrity → the flag is still passed too; this replaces nothing
   *   hostile   → the stripper leaves string contents (`https://`) alone
   */
  const SCREEN = stripComments(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'screens/chat/ChatRoomScreen.tsx'),
      'utf8',
    ),
  );

  it('HOSTILE: the stripper removes comments without eating code', () => {
    expect(stripComments('a(); // b\nc();')).toBe('a(); \nc();');
    expect(stripComments('a(); /* b */ c();')).toBe('a();  c();');
    // A `//` inside a string is not a comment, and neither is one in a
    // template literal — both appear in this screen as URLs and paths.
    expect(stripComments("f('https://x'); // g")).toBe("f('https://x'); ");
    expect(stripComments('f(`a//b`);')).toBe('f(`a//b`);');
    // And a comment marker cannot hide a call from the assertions below.
    expect(stripComments('// askStatus({ memberCount })')).toBe('');
  });

  it('CONTRACT: the count reaches askStatus', () => {
    const at = SCREEN.indexOf('askStatus({');
    expect(at, 'the screen no longer calls askStatus').toBeGreaterThan(-1);
    const call = SCREEN.slice(at, SCREEN.indexOf('})', at));
    expect(call).toContain('memberCount');
    // The flag is an independent signal, not a replaced one.
    expect(call).toContain('personal');
  });

  it('CONTRACT: the count is read out of the topic response', () => {
    expect(SCREEN).toMatch(/setMemberCount\(/);
    expect(SCREEN).toMatch(/topic\?\.memberCount/);
  });

  it('INTEGRITY: anything that is not a finite number is stored as unknown', () => {
    // Otherwise `undefined` becomes `NaN` becomes some verdict nobody chose.
    const at = SCREEN.indexOf('setMemberCount(');
    const call = SCREEN.slice(at, SCREEN.indexOf(';', at));
    expect(call).toContain('Number.isFinite');
    expect(call).toContain('null');
  });
});

/**
 * Comments out, code kept, strings untouched.
 *
 * Hand-rolled rather than regex-based because the screen is full of `https://`
 * inside strings, and the naive pattern would cut a line in half at the first
 * URL and take the rest of the file's meaning with it.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      out += src[i] ?? '';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/*
 * WHAT WAS ACTUALLY WRONG WITH "ask a member" — added 2026-08-27.
 *
 * The reported defect was that a room of one showed "다른 멤버에게 요청하세요"
 * ("ask another member"), which is false. `askStatus` already had an `alone`
 * branch and it worked, so the bug was not there: it was that an UNKNOWN member
 * count fell through to `offer`, whose label makes a claim about the room.
 *
 * The old comment defended that as a brief flash — "reading absence as loneliness
 * would take the one real remedy away from every room during its first frames".
 * The flash reasoning was right and the case was not a flash. `ChatRoomScreen`
 * fetches the topic detail inside a `try { ... } catch {}`, so a room whose detail
 * cannot be fetched — no membership row, a 403, an offline start — leaves the
 * count null for the WHOLE visit, and the false sentence stays with it. That is
 * the room the defect was reported from.
 *
 * The fix keeps the remedy and drops the claim: `offerUnsure` offers the same
 * button under wording that does not assert anyone is there.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → unknown count offers the ask, but never the "a member" wording
 *   contract  → a known count of one is still `alone`
 *   integrity → a known count above one still gets the original wording
 *   boundary  → null / undefined / NaN / Infinity / a string count are all unknown
 *   authz     → DM keeps "ask them": one other person by construction
 *   race      → the label never claims members while the count is still unknown,
 *               across repeated re-evaluations
 */
describe('an unknown member count must not claim there are members', () => {
  const base = {
    sending: false,
    lockedCount: 3,
    tier: 'secret',
    mine: null,
    personal: false,
  } as unknown as Parameters<typeof askStatus>[0];

  it('CONTRACT: unknown offers the ask without the "a member" wording', () => {
    const s = askStatus({ ...base, memberCount: null } as never);
    expect(s).toBe('offerUnsure');
    expect(askLabelKey(s, 'secret')).toBe('openstoa.keyRequest.askUnsure');
    // The remedy is still offered — hiding it was the other way to be wrong.
    expect(askLabelKey(s, 'secret')).not.toBeNull();
  });

  it('CONTRACT: a known count of one is still alone', () => {
    expect(askStatus({ ...base, memberCount: 1 } as never)).toBe('alone');
  });

  it('INTEGRITY: a known count above one keeps the original wording', () => {
    const s = askStatus({ ...base, memberCount: 4 } as never);
    expect(s).toBe('offer');
    expect(askLabelKey(s, 'secret')).toBe('openstoa.keyRequest.askMember');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['a string', '2'],
  ])('BOUNDARY: %s is unknown, not a member count', (_label, mc) => {
    const s = askStatus({ ...base, memberCount: mc } as never);
    expect(s).toBe('offerUnsure');
    expect(askLabelKey(s, 'secret')).not.toBe('openstoa.keyRequest.askMember');
  });

  it('AUTHZ: a DM keeps "ask them" — one other person by construction', () => {
    // A DM has exactly one peer whether or not a count arrived, so the claim is
    // true there and softening it would make the wording vaguer for no reason.
    const s = askStatus({ ...base, tier: 'dm', memberCount: null } as never);
    expect(askLabelKey(s, 'dm')).toBe('openstoa.keyRequest.askPeer');
  });

  it('REPETITION: twenty evaluations with an unknown count never claim members', () => {
    /*
     * The accumulating axis. A single call proves the branch exists; the screen
     * re-evaluates this on every render for the whole visit, and the defect being
     * fixed is precisely one that PERSISTED across all of them.
     */
    const labels = new Set<string | null>();
    for (let i = 0; i < 20; i++) {
      labels.add(askLabelKey(askStatus({ ...base, memberCount: null } as never), 'secret'));
    }
    expect([...labels]).toEqual(['openstoa.keyRequest.askUnsure']);
  });

  it('CONTRACT: the personal flag settles it even with no count', () => {
    // The account's own space answers the question without the count landing.
    expect(askStatus({ ...base, personal: true, memberCount: null } as never)).toBe('alone');
  });
});
