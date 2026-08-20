/**
 * What each tier's chat SAYS, derived from what each tier DOES.
 *
 * `chatTierPolicy.ts` is the machine-readable truth about keys; this module is
 * the single place that turns it into claims a person reads. Nothing here
 * restates a policy value — the encryption claim and the history claim are both
 * COMPUTED from `tierPolicy()`, so a tier whose key handling changes cannot keep
 * an interface that promises the old behaviour. That is the whole reason this
 * file exists rather than four strings in two components.
 *
 * The access facts (who finds a topic, who may join, who reads posts) are not
 * key policy and are not in `chatTierPolicy.ts`. They live here as one table,
 * each row carrying the route that enforces it, because they were previously
 * described in three places — the design doc, the creation screen and the
 * marketing copy — and two of the three were already wrong. Every value below
 * was read out of the route it cites, not out of the design document; where the
 * two disagreed, the ROUTE won.
 *
 * Two copies exist — `src/lib/chatTierExplainer.ts` (web/server) and
 * `packages/mobile/src/lib/chatTierExplainer.ts` (mini-app) — and a test asserts
 * they stay BYTE-IDENTICAL, so this file imports nothing but its sibling policy
 * module, which is itself twinned the same way.
 *
 * The reasoning is in `docs/design/openstoa-chat-history-decision.md`.
 */
import { type ChatTier, isEndToEndEncrypted, tierPolicy } from './chatTierPolicy';

/** The order both the docs table and any tier list present, weakest first. */
export const TIER_ORDER: readonly ChatTier[] = ['public', 'private', 'secret', 'dm'];

/**
 * Which sentence the chat banner shows.
 *
 * `'e2ee'` — the service cannot read the room.
 * `'serverReadable'` — it can, and the banner has to say so.
 *
 * DERIVED, never chosen: `isEndToEndEncrypted` is defined as the negation of
 * "the server may hold this tier's key", so the banner cannot promise
 * encryption over a tier whose key the server holds. `public` is exactly that
 * tier — the server keeps its archive root so a later joiner reads history
 * without waiting on another member — and this function is what stops the
 * interface from claiming otherwise.
 */
export type ChatClaimKey = 'e2ee' | 'serverReadable';

export function chatClaimKey(tier: ChatTier): ChatClaimKey {
  return isEndToEndEncrypted(tier) ? 'e2ee' : 'serverReadable';
}

/**
 * How long the claim's SENTENCE stays on screen after a room opens, in ms.
 *
 * It used to stay forever, which cost four lines above every conversation and
 * taught people to read past it — a permanent notice is furniture, and the one
 * tier where the sentence is a warning rather than a reassurance is the tier
 * most rooms are in. So the sentence now appears on entry and withdraws.
 *
 * What does NOT withdraw is the claim itself: the control that brings the
 * sentence back is always in the room, and it carries the tier in its icon and
 * its colour. Nothing here may be used to hide that control — a room whose
 * service can read it must look different from one where it cannot, at every
 * moment, whether or not anybody has read the sentence.
 *
 * Long enough to read the longer of the two sentences unhurried, short enough
 * that it is gone before the first reply.
 */
export const TIER_CLAIM_VISIBLE_MS = 6_000;

/**
 * What a member who joins LATER can read of what was said before they arrived.
 *
 * `'all'`    — the whole conversation (the key opens everything).
 * `'window'` — only what the person who invited them chose to share, bounded.
 * `'dm'`     — the question does not arise: nobody joins a DM later.
 *
 * Derived from `historyForLaterJoiner`, except for the DM case, which the
 * policy answers `'all'` — correct about the key, misleading as a sentence,
 * because there is no later joiner to read anything.
 */
export type HistoryClaimKey = 'all' | 'window' | 'dm';

export function historyClaimKey(tier: ChatTier): HistoryClaimKey {
  if (tier === 'dm') return 'dm';
  return tierPolicy(tier).historyForLaterJoiner === 'all' ? 'all' : 'window';
}

/** Who can see that the topic exists. */
export type FindClaim =
  /** Listed publicly; signed-out visitors see it too. */
  | 'anyone'
  /** Listed, so it can be found, but its contents are not open. */
  | 'listed'
  /** Not in any listing or search result. */
  | 'hidden'
  /** Only the two people in it. */
  | 'participants';

/** How someone becomes a member. */
export type JoinClaim =
  /** Anyone signed in, immediately. */
  | 'open'
  /** Only through an invite link. */
  | 'invite'
  /** When the other person accepts. */
  | 'accept';

/** Who can read the topic's posts (not its chat — chat is always members). */
export type PostsClaim =
  /** Anyone, signed in or not. */
  | 'anyone'
  /** Any signed-in account, member or not. */
  | 'signedIn'
  /** Members only. */
  | 'members'
  /** The tier has no posts at all. */
  | 'none';

export interface TierAccess {
  find: FindClaim;
  join: JoinClaim;
  posts: PostsClaim;
}

/*
 * Verified against the routes. Where an earlier version of this table followed
 * the code over the design doc on `private`, the code was the stale side and
 * has since been changed to match the decision: private is INVITE-ONLY (the
 * approval flow is gone) and its POSTS are readable by any signed-in user,
 * because the members-only part of a private topic is its chat, not its posts.
 * The routes now enforce exactly that, and the tests named in each comment
 * fail if either side drifts again.
 */
const ACCESS: Record<ChatTier, TierAccess> = {
  /*
   * find:  GET /api/topics lists everything except `secret` — public included,
   *        for guests too (src/app/api/topics/route.ts, guest branch).
   * join:  POST /api/topics/{id}/join → 201 immediately when visibility is
   *        neither secret nor private.
   * posts: the posts route serves a guest when `visibility === 'public'`
   *        (src/app/api/topics/{id}/posts/route.ts).
   */
  public: { find: 'anyone', join: 'open', posts: 'anyone' },
  /*
   * find:  listed like a public topic — only `secret` is filtered out.
   * join:  POST .../join → 403. The invite link
   *        (POST /api/topics/join/{inviteCode}) is the only door, and it is
   *        also what carries the chat-history keys in its fragment, which is
   *        why an approval flow could not survive: it would admit a member the
   *        inviter never handed keys to.
   * posts: readable by any SIGNED-IN user, member or not (list route and
   *        detail route both). Guests still get 401 — signing in is the price.
   *        The members-only part of a private topic is its CHAT.
   */
  private: { find: 'listed', join: 'invite', posts: 'signedIn' },
  /*
   * find:  filtered out of every listing for non-members.
   * join:  POST .../join → 403 outright; the invite code is the only door.
   * posts: members only, same 403 as private.
   */
  secret: { find: 'hidden', join: 'invite', posts: 'members' },
  /*
   * A DM is a two-member topic with `kind='dm'`, excluded from every listing
   * and from the feed, created/accepted through /api/dm. It has no posts at all.
   */
  dm: { find: 'participants', join: 'accept', posts: 'none' },
};

export function tierAccess(tier: ChatTier): TierAccess {
  return ACCESS[tier];
}

/**
 * Can the operator read this room's messages?
 *
 * The same fact as `chatClaimKey`, named as the question the docs table asks,
 * so the table cannot answer it independently of the banner. Both come from
 * `serverMayHoldKey`.
 */
export function operatorCanReadChat(tier: ChatTier): boolean {
  return !isEndToEndEncrypted(tier);
}
