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
   * The room is the caller's OWN space — a topic with exactly one member.
   *
   * The tier says `secret`, so without this the room would offer "ask a member
   * to unlock this history" in a room that HAS no other member. The person taps
   * it, the request is filed correctly, and nobody ever answers, because there
   * is nobody. A button that cannot work is worse than no button: it replaces
   * the true answer — only your recovery code brings this back — with a wait.
   */
  personal?: boolean;
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

/** What the room should show about asking, if anything. */
export function askStatus(s: AskState): AskStatus {
  if (s.sending) return 'sending';
  if (s.lockedCount <= 0 || !tierCanAsk(s.tier)) return 'hidden';
  // Checked before every other outcome: in a room of one there is no request
  // to be waiting on and no grant that could arrive.
  if (s.personal) return 'alone';
  if (s.mine?.granted) return 'granted';
  if (s.mine) return 'waiting';
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
