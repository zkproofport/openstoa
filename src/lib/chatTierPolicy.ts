/**
 * What each topic tier does about chat keys and chat history — for BOTH clients
 * and the server.
 *
 * These rules were previously spread across a route, two chat screens and a
 * crypto session store, and they drifted: one surface believed history was on
 * its way while another had already given up, and a key that must never reach
 * the server had no single place saying so. Everything that decides a tier's
 * behaviour is decided here, once.
 *
 * Two copies exist — `src/lib/chatTierPolicy.ts` (web/server) and
 * `packages/mobile/src/lib/chatTierPolicy.ts` (mini-app) — and a test asserts
 * they stay BYTE-IDENTICAL, so keep this file dependency-free.
 *
 * The reasoning behind each rule is in
 * `docs/design/openstoa-chat-history-decision.md`.
 */

export type ChatTier = 'public' | 'private' | 'secret' | 'dm';

/** How a topic's archive key is derived and shared. */
export type KeyModel =
  /** One key for the whole topic. Everyone who holds it reads everything. */
  | 'topic-root'
  /** A key per MLS epoch, so removing a member removes their future access. */
  | 'per-epoch';

/** Where a later joiner's key comes from, if anywhere. */
export type KeyDelivery =
  /** The server keeps it and hands it to any member. Not end-to-end encrypted. */
  | 'server'
  /** It rides in the invite link's fragment, which never reaches the server. */
  | 'invite-link'
  /** Handed over when a DM request is accepted. */
  | 'on-accept';

export interface TierPolicy {
  keyModel: KeyModel;
  keyDelivery: KeyDelivery;
  /**
   * Whether the server may hold this tier's archive key.
   *
   * The one place that decides it. A client that uploads a key for a tier where
   * this is false has silently turned off end-to-end encryption, and the route
   * refuses it rather than trusting every caller to remember.
   */
  serverHoldsKey: boolean;
  /**
   * Whether a later joiner can be given history at all, and how much.
   *
   * `'all'` — the key opens everything, so they see everything.
   * `'window'` — the inviter may share the keys for a bounded number of recent
   *   epochs. See `inviteHistoryEpochs` for why the bound is epochs.
   */
  historyForLaterJoiner: 'all' | 'window';
}

const POLICIES: Record<ChatTier, TierPolicy> = {
  /*
   * Anyone may join a public topic, so its history is not secret from the
   * public — only from the operator. Making history depend on another member
   * being online was a bad trade for that, so the server keeps the key and a
   * later joiner reads everything at once.
   *
   * This is the one tier where the product must not claim the server cannot
   * read chat.
   */
  public: {
    keyModel: 'topic-root',
    keyDelivery: 'server',
    serverHoldsKey: true,
    historyForLaterJoiner: 'all',
  },
  /*
   * Chat is members-only in EVERY tier — the chat route answers 403 to a
   * non-member whatever the visibility — so a private topic's conversation is
   * not public even though its posts are. A member who is removed should stop
   * being able to read it, which is exactly what per-epoch keys buy, so private
   * takes the same rule as secret rather than the simpler topic-root route.
   */
  private: {
    keyModel: 'per-epoch',
    keyDelivery: 'invite-link',
    serverHoldsKey: false,
    historyForLaterJoiner: 'window',
  },
  /* Hidden room, controlled membership: the tier where removal must bite. */
  secret: {
    keyModel: 'per-epoch',
    keyDelivery: 'invite-link',
    serverHoldsKey: false,
    historyForLaterJoiner: 'window',
  },
  /*
   * Two people, both there from the start. Nobody joins later and nobody can be
   * removed, so both things per-epoch keys buy are worth nothing here. One root,
   * and the archive exists only so the conversation follows the reader to their
   * own other devices.
   */
  dm: {
    keyModel: 'topic-root',
    keyDelivery: 'on-accept',
    serverHoldsKey: false,
    historyForLaterJoiner: 'all',
  },
};

export function tierPolicy(tier: ChatTier): TierPolicy {
  return POLICIES[tier];
}

/**
 * Whether this tier's archive key may be stored on the server.
 *
 * Named as a question because it reads as one at the call site, and because the
 * answer is a security boundary rather than a preference.
 */
export function serverMayHoldKey(tier: ChatTier): boolean {
  return POLICIES[tier].serverHoldsKey;
}

/**
 * Whether the chat in this tier is end-to-end encrypted from the SERVICE.
 *
 * Drives the banner. It is the exact negation of "the server holds the key",
 * and deriving it rather than storing it separately is what stops the two from
 * ever disagreeing — a banner promising encryption over a tier the server can
 * read is the worst bug this file can prevent.
 */
export function isEndToEndEncrypted(tier: ChatTier): boolean {
  return !POLICIES[tier].serverHoldsKey;
}

/**
 * How much history an invite may carry, counted in EPOCHS.
 *
 * Not in messages, which is the unit WhatsApp uses and the one this nearly
 * copied. Two things break when you count messages here:
 *
 *  - **The link size stops being bounded.** One key is 32 bytes — 43 base64
 *    characters — and the keys are per epoch, so "the last 50 messages" is one
 *    key in a quiet room and fifty in a room people keep joining. Same promise,
 *    fifty times the link. A URL fragment gives out around 2 000 characters, so
 *    the message count cannot be the thing that keeps a link usable.
 *  - **The promise is unkeepable anyway.** Handing over the key for an epoch
 *    opens EVERY message in that epoch. Share "the last 50" out of an epoch
 *    holding five thousand and all five thousand are readable. The smallest
 *    unit this system can actually disclose is an epoch.
 *
 * So the bound is epochs, and the interface says what that came to: the caller
 * counts the messages those epochs contain and shows the reader a real number
 * ("the last 342 messages, since 12 August") rather than a figure we cannot
 * honour.
 */
export const INVITE_HISTORY_EPOCHS_DEFAULT = 3;
/** 20 keys ≈ 880 characters of fragment — comfortably inside any client. */
export const INVITE_HISTORY_EPOCHS_MAX = 20;

/**
 * How many recent epochs an invite will carry the keys for.
 *
 * `'all'` tiers do not use this: their single key opens everything, so there is
 * nothing to bound. For the rest, 0 is a real answer — an inviter who does not
 * want to share history says so by sharing none.
 */
export function inviteHistoryEpochs(tier: ChatTier, requested: number | undefined): number {
  if (POLICIES[tier].historyForLaterJoiner === 'all') return 0;
  if (requested === undefined) return INVITE_HISTORY_EPOCHS_DEFAULT;
  if (!Number.isInteger(requested) || requested < 0) return 0;
  return Math.min(requested, INVITE_HISTORY_EPOCHS_MAX);
}

/**
 * The tier of a conversation, from what the client knows about it.
 *
 * A DM is not a visibility — it is a different kind of room that happens to be
 * stored as a topic — so callers that have both a `visibility` and a "this is a
 * DM" flag need one place to reconcile them, or half of them will forget.
 */
export function chatTierOf(visibility: string | null | undefined, isDm: boolean): ChatTier {
  if (isDm) return 'dm';
  if (visibility === 'private' || visibility === 'secret') return visibility;
  // Anything unrecognised is treated as public — the tier with the FEWEST
  // guarantees, so a bad value cannot silently promise encryption we are not
  // providing. It can only under-promise.
  return 'public';
}
