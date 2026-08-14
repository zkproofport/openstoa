/**
 * The invite link an inviter actually sends, and the sentence shown before
 * they send it.
 *
 * `inviteHistoryLink.ts` owns the wire format of the keys. This owns the two
 * things a caller needs around it:
 *
 *  - **Which topic the keys are for.** The fragment carries epoch numbers and
 *    key bytes and nothing that names a room, so a link assembled for one topic
 *    is indistinguishable from a link for another once the token is swapped.
 *    That is not a cosmetic mix-up: an epoch key is written into the keychain
 *    slot for `(topic, epoch)`, `importInviteHistory` will not overwrite a slot
 *    that is already filled, and the device stops deriving its OWN key for an
 *    epoch it thinks it already holds — so a foreign key landing in a slot the
 *    device later occupies makes it seal archive rows under a key no other
 *    member has. The topic id rides alongside as its own fragment param
 *    (`decodeInviteHistory` already ignores params that are not its own) so the
 *    recipient can refuse rather than guess.
 *
 *  - **What the link comes to, in messages.** The bound is counted in epochs —
 *    see `chatTierPolicy.inviteHistoryEpochs` for why it cannot honestly be
 *    counted in messages — but "3 epochs" means nothing to the person deciding
 *    whether to send it. The archive rows carry `takVersion` (= epoch) and a
 *    timestamp, so the count and the start date are read back off the same
 *    epochs that are actually being shared.
 *
 * Two copies exist — `src/lib/inviteLink.ts` (web) and
 * `packages/mobile/src/lib/inviteLink.ts` (mini-app) — and a test asserts they
 * stay BYTE-IDENTICAL, so keep this file dependency-free apart from its
 * sibling `inviteHistoryLink`.
 */
import {
  decodeInviteHistory,
  encodeInviteHistory,
  withInviteHistory,
  INVITE_FRAGMENT_MAX_CHARS,
} from './inviteHistoryLink';

/** Fragment param naming the topic the keys belong to. */
const TOPIC_PARAM = 't';

/**
 * Build the fragment for an invite: the keys, plus the topic they open.
 *
 * Null when there is nothing to carry — no keys, or a key set that will not
 * survive the trip (`encodeInviteHistory` refuses rather than truncating). The
 * topic tag is never sent on its own: a fragment with no keys in it is noise.
 */
export function buildInviteFragment(taks: Record<number, string>, topicId: string): string | null {
  const keys = encodeInviteHistory({ taks });
  if (!keys) return null;
  const tagged = `${keys}&${TOPIC_PARAM}=${encodeURIComponent(topicId)}`;
  // The ceiling belongs to the whole fragment, and the tag is part of it.
  // Dropping the keys is better than shipping a link a messaging app will cut.
  if (tagged.length > INVITE_FRAGMENT_MAX_CHARS) return null;
  return tagged;
}

/** The full invite URL: token in the path, keys in the fragment. */
export function buildInviteUrl(baseUrl: string, taks: Record<number, string>, topicId: string): string {
  return withInviteHistory(baseUrl, buildInviteFragment(taks, topicId));
}

/**
 * What a recipient found in the fragment.
 *
 * `wrong-topic` is deliberately its own answer rather than an empty one: the
 * recipient joined a room and was handed keys for a different one, and silently
 * importing nothing would look identical to a link that never carried history.
 * The user should be told the link was assembled wrong.
 */
export type InviteHistoryRead =
  | { status: 'none' }
  | { status: 'wrong-topic' }
  | { status: 'ok'; taks: Record<number, string> };

/**
 * Read the history keys out of a fragment, for THIS topic.
 *
 * An untagged fragment is accepted. The tag is a guard against a link that was
 * assembled for another room, not a proof of anything — a tail lost in transit
 * would take it with it, and refusing then would withhold history from a link
 * that is perfectly good. A tag that is present and DISAGREES is the case worth
 * refusing, because only a mismatch is evidence.
 */
export function readInviteHistory(hash: string | null | undefined, topicId: string): InviteHistoryRead {
  const decoded = decodeInviteHistory(hash);
  if (!decoded) return { status: 'none' };
  const tagged = inviteFragmentTopicId(hash);
  if (tagged !== null && tagged !== topicId) return { status: 'wrong-topic' };
  return { status: 'ok', taks: decoded.taks };
}

/** The topic id a fragment claims, or null when it claims none. */
export function inviteFragmentTopicId(hash: string | null | undefined): string | null {
  if (typeof hash !== 'string' || hash.length === 0) return null;
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (body.length > INVITE_FRAGMENT_MAX_CHARS) return null;
  const field = body.split('&').find((p) => p.startsWith(`${TOPIC_PARAM}=`));
  if (!field) return null;
  const raw = field.slice(TOPIC_PARAM.length + 1);
  if (raw.length === 0) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed escape names no topic. Treated as untagged rather than as a
    // mismatch: refusing on a value we could not even read would be a guess.
    return null;
  }
}

/** An invite pulled back apart: the token the server knows, and the keys it does not. */
export interface ParsedInvite {
  /** The invite token — the last path segment of a link, or the whole input. */
  code: string;
  /** The fragment, WITHOUT its leading '#'. Empty when the link carried none. */
  fragment: string;
}

/**
 * Read an invite out of whatever the user actually pasted.
 *
 * The mini-app asks people to paste an invite, and what arrives is a full URL
 * about as often as it is a bare code. Accepting only the code would be the
 * quiet failure: the paste succeeds, the join succeeds, and the fragment — the
 * only copy of the history keys — is discarded on the way in, with nothing to
 * say a link that carried history was handed over and thrown away.
 *
 * Returns null when there is no code to be found, so the caller can say "that
 * does not look like an invite" instead of posting an empty one.
 */
export function parseInviteLink(input: string | null | undefined): ParsedInvite | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const hash = trimmed.indexOf('#');
  const fragment = hash === -1 ? '' : trimmed.slice(hash + 1);
  // The query belongs to the link, not to the token.
  const withoutFragment = (hash === -1 ? trimmed : trimmed.slice(0, hash)).split('?')[0];

  const segments = withoutFragment.split('/').filter((s) => s.length > 0);
  const last = segments.length > 0 ? segments[segments.length - 1] : '';
  if (last.length === 0) return null;

  let code = last;
  try {
    code = decodeURIComponent(last);
  } catch {
    // Not an escape sequence; the raw segment is the token.
  }
  // Whitespace means this is prose, not a token. Checked AFTER decoding,
  // because `%20` is whitespace that a pre-decode check does not see.
  if (code.length === 0 || /\s/.test(code)) return null;
  return { code, fragment };
}

/** One archive row, reduced to what deciding an invite needs. */
export interface InviteArchiveRow {
  /** The epoch the row was sealed under (0 = a public topic's shared root). */
  takVersion: number;
  createdAt: string;
}

/** What the epochs being shared come to, in the units a person thinks in. */
export interface InviteHistoryOffer {
  /** How many archived messages those epochs contain. */
  messages: number;
  /** ISO timestamp of the oldest one, or null when the offer is empty. */
  since: string | null;
}

/**
 * Count what a set of epochs actually opens.
 *
 * Reads the archive index rather than any key, so it is honest about the one
 * thing the inviter is deciding: an epoch key opens EVERY message in its epoch,
 * so this is the real number, not a window we cannot enforce.
 *
 * An unparseable timestamp still counts as a message — the row exists and will
 * be readable — but cannot start the window, so `since` skips it instead of
 * reporting an Invalid Date.
 */
export function summarizeInviteHistory(
  rows: readonly InviteArchiveRow[] | null | undefined,
  epochs: readonly number[],
): InviteHistoryOffer {
  if (!rows || rows.length === 0 || epochs.length === 0) return { messages: 0, since: null };
  const shared = new Set(epochs);
  let messages = 0;
  let oldest: number | null = null;
  for (const row of rows) {
    if (!shared.has(row.takVersion)) continue;
    messages++;
    const at = Date.parse(row.createdAt);
    if (Number.isNaN(at)) continue;
    if (oldest === null || at < oldest) oldest = at;
  }
  return { messages, since: oldest === null ? null : new Date(oldest).toISOString() };
}
