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
 * ONE copy, in `@openstoa/mls` alongside the crypto that obeys it. The web app,
 * the mini-app and the agent SDK each hold a re-export; `mlsCryptoTwins.test.ts`
 * is what keeps it that way.
 *
 * It lives beside the crypto because it used to live away from it and they
 * disagreed. `takSession` chose its key model from a topic's VISIBILITY, and a
 * DM's row carries `visibility: 'secret'` — so every DM message was sealed under
 * a per-epoch key while this file declared DMs used one topic-wide root, and no
 * type, test or reader connected the two. `takSession` now asks
 * `usesTopicRootKey(tier)`, so the declaration below IS the implementation
 * rather than a description of one.
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

/**
 * Where a later joiner's key comes from, if anywhere.
 *
 * Every member of this union must name a mechanism that EXISTS. The value it
 * replaced, `'on-accept'`, named one that did not: it was written here, read by
 * four call sites as a reason to skip DMs entirely, and implemented nowhere —
 * a grep for it found the type, the policy entry and their mini-app twins, and
 * no code. DM messages were consequently sealed by a key that never left the
 * device that minted it. `chatTierPolicy.test.ts` now requires a call site for
 * each of these, which is the class-level guard rather than the one-off fix.
 */
export type KeyDelivery =
  /** The server keeps it and hands it to any member. Not end-to-end encrypted. */
  | 'server'
  /** It rides in the invite link's fragment, which never reaches the server. */
  | 'invite-link'
  /**
   * A device that already holds the key wraps it to each member's MLS leaf
   * (HPKE) and posts the sealed bundle. The server relays bytes it cannot open.
   */
  | 'peer-device';

/**
 * Every `KeyDelivery`, at RUNTIME — the type alone is erased, and a guard that
 * cannot enumerate the union can only check the values somebody remembered to
 * list.
 */
export const KEY_DELIVERIES = ['server', 'invite-link', 'peer-device'] as const;

/*
 * Adding a member to `KeyDelivery` without listing it above fails HERE, at
 * compile time, before any test runs.
 */
type UnlistedDelivery = Exclude<KeyDelivery, (typeof KEY_DELIVERIES)[number]>;
const _everyDeliveryIsListed: UnlistedDelivery extends never ? true : never = true;
void _everyDeliveryIsListed;

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
   * Two people, and nobody can ever be removed — so the one thing per-epoch keys
   * buy, cutting off a departed member's future reads, buys nothing here, while
   * its cost lands squarely on the case a DM is FOR.
   *
   * That cost, concretely: a per-epoch key can only be derived for the epoch a
   * device is currently sitting in. Every epoch it was absent for — the ones
   * before the recipient first opened the conversation, the ones a second phone
   * slept through — is unreadable to it unless another device explicitly hands
   * that epoch over, and a hole opened this way is silent. Applied to the room
   * whose promise is "your conversation follows you", that is the whole promise.
   *
   * So: one root for the conversation, minted once and handed device to device.
   * A device that receives it reads everything, including what was said before
   * it existed and what is said while it is switched off. The server never holds
   * it — `serverHoldsKey` is false and the deposit route refuses the tier — and
   * "nobody joins later" was never true of DEVICES, which is what the archive is
   * really for.
   */
  dm: {
    keyModel: 'topic-root',
    keyDelivery: 'peer-device',
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
 * Whether this tier seals its whole conversation under ONE key.
 *
 * The question the TAK layer asks, so that the key model is decided in one place
 * instead of being re-derived from a topic's visibility — which is where the two
 * came apart, since `dm` is not a visibility and a DM row says `'secret'`.
 */
export function usesTopicRootKey(tier: ChatTier): boolean {
  return POLICIES[tier].keyModel === 'topic-root';
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
 * The visibilities a topic row can legitimately carry.
 *
 * `POST /api/topics` validates against exactly this list, and nothing updates
 * the column afterwards — but it is a plain `varchar(10)` with no CHECK
 * constraint, so a migration, a seed script or a future route that forgets to
 * validate can still put something else there.
 */
export const TOPIC_VISIBILITIES = ['public', 'private', 'secret'] as const;

/**
 * Is this a visibility this policy can actually classify?
 *
 * The companion to `chatTierOf`'s deliberate leniency, and the reason both can
 * exist. `chatTierOf` answers `public` for anything it does not recognise, which
 * is the RIGHT answer for the banner — a bad value can then only under-promise
 * privacy, never claim encryption we are not providing.
 *
 * It is the WRONG answer for a gate that decides whether the SERVER MAY HOLD A
 * KEY, because there `public` is the permissive branch. A caller on that side
 * asks this FIRST and refuses an input it cannot classify, rather than letting
 * one default serve two consumers whose failure directions are opposite.
 */
export function isKnownVisibility(visibility: string | null | undefined): boolean {
  return (TOPIC_VISIBILITIES as readonly string[]).includes(visibility ?? '');
}

/**
 * May the SERVER hold this ROW's archive key?
 *
 * The composed question a deposit gate actually asks, as ONE interrogable
 * function rather than a chain re-assembled at each call site — the same reason
 * `isPurgeable` is a function and not four predicates inlined into a statement:
 * a chain cannot be asked why it said yes.
 *
 * STRICT on purpose, and the opposite of `chatTierOf`'s leniency. `chatTierOf`
 * answers `public` for a visibility it does not recognise, which is right for the
 * banner — the worst case there is under-promising privacy. Here `public` is the
 * PERMISSIVE branch: it is the one tier whose key the server may keep. So an
 * unclassifiable row is refused rather than resolved, because the two consumers
 * of that one default fail in opposite directions.
 */
export function serverMayHoldKeyForRow(
  visibility: string | null | undefined,
  isDm: boolean,
): boolean {
  if (!isKnownVisibility(visibility)) return false;
  return serverMayHoldKey(chatTierOf(visibility, isDm));
}

/**
 * Does this ROW have a topic-wide archive root to identify?
 *
 * Same strict-first rule as `serverMayHoldKeyForRow`, one step down in stakes —
 * this governs a one-way fingerprint, not a key. It exists so the two gates
 * cannot disagree about which rooms have a root: a client told "yes, publish a
 * fingerprint" by one and "no, you may not deposit" by the other would be stuck
 * with no way to settle on a root at all.
 */
export function hasTopicRootForRow(
  visibility: string | null | undefined,
  isDm: boolean,
): boolean {
  if (!isKnownVisibility(visibility)) return false;
  return usesTopicRootKey(chatTierOf(visibility, isDm));
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
