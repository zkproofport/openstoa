/**
 * Asking a member to unlock the stretch of history this device cannot read.
 *
 * WHEN IT APPLIES. After a recovery on a new phone, `public` rooms come back in
 * full — the server holds the archive root. `private`, `secret` and `dm` come
 * back only as far as the OLD phone's last backup: epochs that advanced while
 * that phone was off never reached its keychain, so they were never in the
 * blob. Backing up more often does not help; a key that was never received
 * cannot be uploaded.
 *
 * The keys still exist, on the devices of members who were online. So what is
 * missing is not cryptography but an ASK — and the ask has to outlive the
 * moment, because whoever can grant is rarely looking at their phone right then.
 *
 * WHAT THIS FILE DOES: decides whether the ask makes sense, and what to say
 * about it. The network call and the screen are elsewhere, so the decision can
 * be tested without either.
 */

/** The tiers whose history a member has to hand over. */
export type AskableTier = 'private' | 'secret' | 'dm';

export interface AskState {
  /** Rows on screen this device cannot open. */
  lockedCount: number;
  /**
   * The room is the caller's OWN space — the topic the account is created with.
   *
   * The tier says `secret`, so without this the room would offer "ask a member
   * to unlock this history" in a room that HAS no other member. The person taps
   * it, the request is filed correctly, and nobody ever answers, because there
   * is nobody. A button that cannot work is worse than no button: it replaces
   * the true answer — only your recovery code brings this back — with a wait.
   */
  personal?: boolean;
  /**
   * How many members the room has, INCLUDING this account. `null` while the
   * lookup has not answered.
   *
   * WHY THIS EXISTS BESIDE `personal`. `personal` is a flag on ONE room per
   * account, and it reached this decision through a single optional field of a
   * best-effort fetch — one `catch {}` away from false, and false is the answer
   * that shows the button. But "am I the only one here" is a fact about
   * MEMBERSHIP, it arrives in the same response as `memberCount`, and it is
   * also true in rooms the flag says nothing about: the last member of a secret
   * topic everyone else left, or a DM whose peer deleted their account. Both of
   * those showed "ask a member" with nobody to ask.
   */
  memberCount?: number | null;
  /** The room's tier. `public` never needs an ask — the server has the root. */
  tier: string;
  /** What the server said about this device's own request, if anything. */
  mine: { granted: boolean } | null;
  /** True while a request is being sent. */
  sending: boolean;
}

export type AskStatus =
  /** Nothing is locked, or the tier cannot be asked about. */
  | 'hidden'
  /** Locked rows in a room with nobody else in it — say so, offer nothing. */
  | 'alone'
  /** Locked rows and no request yet — offer the button. */
  | 'offer'
  /**
   * Locked rows, no request yet, and we do not KNOW whether anyone else is here.
   *
   * Same remedy as `offer`, different sentence. "Ask a member" is a claim about
   * the room, and a room whose detail never loaded has not made that claim
   * true — see `askStatus`.
   */
  | 'offerUnsure'
  /** Asked, waiting for a member. */
  | 'waiting'
  /** A member granted; the keys are on their way or already applied. */
  | 'granted'
  /** The request is in flight. */
  | 'sending';

/**
 * `public` is excluded because the ask would be pointless there: the server
 * holds the archive root and hands it to any member, so a locked row in a
 * public room means something else is wrong and a "ask a member" button would
 * send the person down the wrong path.
 */
export function tierCanAsk(tier: string): tier is AskableTier {
  return tier === 'private' || tier === 'secret' || tier === 'dm';
}

/**
 * Whether this room has anyone in it who could answer an ask.
 *
 * TWO SIGNALS, EITHER OF WHICH IS ENOUGH, because each covers what the other
 * misses. The flag is right about the account's own space even before the
 * member count lands; the count is right about every OTHER room that ended up
 * with one person in it, which the flag can never say anything about.
 *
 * AN UNKNOWN COUNT IS NOT "ALONE". `null`, `undefined` and anything that is not
 * a finite number mean the lookup has not answered yet, and the room keeps the
 * behaviour it had — offering the ask. Reading absence as loneliness would take
 * the one real remedy away from every room during its first frames.
 */
/**
 * Do we actually KNOW how many people are here?
 *
 * ONLY the count, deliberately. A first version also answered `true` for the
 * personal flag — it reads as reasonable, and it was DEAD: `askStatus` calls
 * `nobodyToAsk` first, which returns `alone` for a personal room, so nothing
 * ever reaches here with the flag set. A mutation removing that line killed no
 * test, which is how it was found; the line is gone rather than kept behind a
 * comment claiming it matters.
 */
export function membersKnown(s: Pick<AskState, 'memberCount'>): boolean {
  const n = s.memberCount;
  return typeof n === 'number' && Number.isFinite(n);
}

export function nobodyToAsk(s: Pick<AskState, 'personal' | 'memberCount'>): boolean {
  if (s.personal) return true;
  const n = s.memberCount;
  // `<= 1` rather than `=== 1`: a count of 0 is a room this device is somehow
  // reading without a membership row, and it has no more people to ask than a
  // room of one. Non-finite values fall out here as unknown.
  return typeof n === 'number' && Number.isFinite(n) && n <= 1;
}

/** What the room should show about asking, if anything. */
export function askStatus(s: AskState): AskStatus {
  if (s.sending) return 'sending';
  if (s.lockedCount <= 0 || !tierCanAsk(s.tier)) return 'hidden';
  // Checked before every other outcome: in a room of one there is no request
  // to be waiting on and no grant that could arrive — including when one was
  // already filed, which is the state this replaces rather than reports.
  if (nobodyToAsk(s)) return 'alone';
  if (s.mine?.granted) return 'granted';
  if (s.mine) return 'waiting';
  /*
   * THE COUNT IS UNKNOWN, so the offer is made WITHOUT claiming anyone is there.
   *
   * The previous shape returned `offer` here, whose label reads "ask a member" —
   * a statement about the room. In a room of one it is simply false, and the
   * case is not the brief flash the old comment assumed: a topic whose detail
   * this device cannot fetch (no membership row, a 403, an offline start) has
   * its lookup swallowed by a `catch {}` in `ChatRoomScreen`, so the count stays
   * null for the whole visit and the false sentence stays with it.
   *
   * Hiding the control instead would take away the one remedy, which the old
   * comment was right to avoid. Keeping the button and dropping the claim costs
   * nothing and is true in both rooms.
   */
  if (!membersKnown(s)) return 'offerUnsure';
  return 'offer';
}

/**
 * The i18n key for the button or line, or null when nothing is shown.
 *
 * DM gets its own wording. "Ask a member" is wrong for a conversation with
 * exactly one other person — it reads as though there is a group to appeal to,
 * and the person is left wondering who.
 */
export function askLabelKey(status: AskStatus, tier: string): string | null {
  switch (status) {
    case 'alone':
      return 'openstoa.keyRequest.aloneHere';
    case 'offer':
      return tier === 'dm' ? 'openstoa.keyRequest.askPeer' : 'openstoa.keyRequest.askMember';
    case 'offerUnsure':
      // DM is exempt: a DM has exactly one other person by construction, so
      // "ask them" is true there without any count having arrived.
      return tier === 'dm' ? 'openstoa.keyRequest.askPeer' : 'openstoa.keyRequest.askUnsure';
    case 'sending':
      return 'openstoa.keyRequest.sending';
    case 'waiting':
      return tier === 'dm' ? 'openstoa.keyRequest.waitingPeer' : 'openstoa.keyRequest.waiting';
    case 'granted':
      return 'openstoa.keyRequest.granted';
    default:
      return null;
  }
}

/** Whether the control is a button a person can press. */
export function askIsPressable(status: AskStatus): boolean {
  return status === 'offer';
}

/**
 * The oldest epoch this device can already read, for `haveFromEpoch`.
 *
 * A grant only has to cover what sits BELOW this, so a member does not re-send
 * what the asker already holds. Returns null when nothing is readable, which
 * the server reads as "send everything".
 *
 * ZERO IS A REAL ANSWER — "I can read from the very first epoch" — so the
 * falsy check that would turn it into null is the bug this guards against: it
 * would ask a member to re-send the entire history every time.
 */
export function oldestReadableEpoch(epochs: readonly number[]): number | null {
  let min: number | null = null;
  for (const e of epochs) {
    if (!Number.isSafeInteger(e) || e < 0) continue;
    if (min === null || e < min) min = e;
  }
  return min;
}

/** One person waiting, as the server describes them. */
export interface PendingKeyRequest {
  id: string;
  requesterUserId: string;
  requesterDeviceId: string;
  haveFromEpoch: number | null;
  /**
   * When the ask was last made. Re-asking REPLACES the row rather than adding
   * one, so the id stays the same and this is the only thing that moves.
   */
  createdAt?: string | null;
}

/**
 * Identity for the purpose of "have I already answered this?".
 *
 * The id alone was wrong. Re-asking keeps the row — and so the id — while
 * changing what is being asked for, so a member who had answered "this device
 * does not have that stretch" kept seeing that answer for a NEW question they
 * might well be able to help with. Including the timestamp makes a re-ask what
 * it actually is: a different ask.
 *
 * It lives here rather than in the list component because it is a rule about
 * data, and a renderer is the one place it cannot be checked without a UI
 * toolkit — the web test config loads this file and cannot load React Native.
 */
export function askKey(r: PendingKeyRequest): string {
  /*
   * Length-prefixed, so an id containing the separator cannot be read as an id
   * plus a timestamp. Not reachable with server-generated UUIDs today — which
   * is exactly when key-collision bugs get written.
   */
  return `${r.id.length}:${r.id}@${r.createdAt ?? ''}`;
}
