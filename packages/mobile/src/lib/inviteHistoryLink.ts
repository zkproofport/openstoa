/**
 * Carrying a private or secret topic's history keys in an invite link.
 *
 * The keys ride in the URL FRAGMENT — everything after `#` — which browsers
 * never put on the wire. The server issues the invite token and never learns
 * what travelled beside it, which is what lets these tiers hand over history
 * without the operator being able to read a word of it.
 *
 * That property is the whole design, so it is worth stating what it rests on:
 * a fragment is not sent in the request line, not in `Referer`, and not in
 * server logs. It IS in the recipient's history and in whatever channel the
 * link was pasted into — so the link is as sensitive as the messages it opens,
 * which is why the invite token beside it is single-use and expires.
 *
 * What travels is the TAK for each of a bounded number of recent epochs. An
 * epoch key opens every message in that epoch and nothing outside it, so the
 * smallest thing this can honestly disclose is an epoch — see
 * `chatTierPolicy.ts` for why the bound is counted in epochs and not messages.
 *
 * Two copies exist — `src/lib/inviteHistoryLink.ts` (web) and
 * `packages/mobile/src/lib/inviteHistoryLink.ts` (mini-app) — and a test
 * asserts they stay BYTE-IDENTICAL, so keep this file dependency-free.
 */

/** Fragment key. Versioned so a future format can be told apart, not guessed. */
const PARAM = 'h1';

/**
 * Ceiling on the whole fragment, in characters.
 *
 * Not a security bound — a bound on whether the link SURVIVES. Browsers,
 * messaging apps and QR encoders all truncate somewhere, and a silently
 * truncated key is worse than no key: the recipient joins, the history looks
 * broken, and nothing says why. `INVITE_HISTORY_EPOCHS_MAX` is chosen to sit
 * inside this with room to spare; this is the backstop if that ever drifts.
 */
export const INVITE_FRAGMENT_MAX_CHARS = 1800;

/**
 * Base64 length of one TAK — 32 bytes, so 44 characters including padding.
 *
 * Checked on the way in, because "looks like base64" is not enough: a link cut
 * short by a messaging app leaves a PREFIX of a key, and a prefix is still
 * valid base64. Without this, a truncated key is written into the keychain,
 * decrypts nothing, and looks exactly like a key that was never shared. A test
 * caught this by cutting a real fragment mid-key.
 */
const TAK_B64_CHARS = 44;

export interface InviteHistoryKeys {
  /** epoch number → base64 TAK for that epoch. */
  taks: Record<number, string>;
}

/**
 * Encode epoch keys into a URL fragment, or null when there is nothing to say.
 *
 * Null rather than an empty fragment: a bare `#` on the end of an invite link
 * is noise the user will ask about, and "no history is being shared" is better
 * expressed by the link simply not carrying any.
 */
export function encodeInviteHistory(keys: InviteHistoryKeys): string | null {
  const epochs = Object.keys(keys.taks)
    .map(Number)
    .filter((e) => Number.isInteger(e) && e >= 0)
    .sort((a, b) => a - b);
  if (epochs.length === 0) return null;

  // `<epoch>.<b64key>` joined by `~`. Compact, and every character is already
  // fragment-safe, so nothing needs escaping and the length is predictable.
  const parts: string[] = [];
  for (const e of epochs) {
    const v = keys.taks[e];
    if (typeof v !== 'string' || v.length === 0) continue;
    parts.push(`${e}.${v}`);
  }
  if (parts.length === 0) return null;

  const fragment = `${PARAM}=${parts.join('~')}`;
  // Refuse to build a link that will not survive being sent. Silently dropping
  // the tail would hand over a keychain with holes in it.
  if (fragment.length > INVITE_FRAGMENT_MAX_CHARS) return null;
  return fragment;
}

/**
 * Read epoch keys back out of a fragment.
 *
 * Every malformed part is DROPPED rather than failing the whole parse. A link
 * that picked up a stray character in transit should still open the epochs it
 * can — the alternative is a recipient who sees nothing and cannot be told
 * which half broke. Returns null only when there is nothing usable at all.
 */
export function decodeInviteHistory(fragment: string | null | undefined): InviteHistoryKeys | null {
  if (typeof fragment !== 'string' || fragment.length === 0) return null;
  // Accept a leading '#' so callers can pass `location.hash` unchanged.
  const body = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (body.length > INVITE_FRAGMENT_MAX_CHARS) return null;

  // The fragment may carry other params; find ours without assuming position.
  const field = body.split('&').find((p) => p.startsWith(`${PARAM}=`));
  if (!field) return null;

  const taks: Record<number, string> = {};
  for (const part of field.slice(PARAM.length + 1).split('~')) {
    const dot = part.indexOf('.');
    if (dot <= 0) continue;
    const epoch = Number(part.slice(0, dot));
    const key = part.slice(dot + 1);
    // A non-integer epoch, a negative one, or an empty key names nothing this
    // client can use. Skipping beats guessing.
    if (!Number.isInteger(epoch) || epoch < 0 || key.length === 0) continue;
    // Base64, and EXACTLY one key's worth of it. Anything else did not come
    // from `encodeInviteHistory`, and a value that is not a whole key would be
    // written into the keychain as if it were — where it opens nothing and is
    // indistinguishable from a key that was never shared.
    if (key.length !== TAK_B64_CHARS) continue;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) continue;
    // First writer wins, so a duplicated epoch cannot be overridden by a later
    // one appended to the link.
    if (taks[epoch] === undefined) taks[epoch] = key;
  }

  return Object.keys(taks).length > 0 ? { taks } : null;
}

/**
 * Attach a history fragment to an invite URL.
 *
 * Any fragment already on the URL is REPLACED, not appended to: two `#` in one
 * URL is not a thing, and a caller passing a URL that already has one is
 * expressing a mistake rather than an intent.
 */
export function withInviteHistory(url: string, fragment: string | null): string {
  const base = url.split('#')[0];
  return fragment ? `${base}#${fragment}` : base;
}

/**
 * Strip the history keys from a link so it can be shown, logged or copied
 * without them.
 *
 * Exists because an invite link WILL end up somewhere it should not — a
 * screenshot, a support ticket, a console log — and the difference between the
 * token and the keys matters: the token can be revoked, the keys cannot.
 */
export function stripInviteHistory(url: string): string {
  return url.split('#')[0];
}
