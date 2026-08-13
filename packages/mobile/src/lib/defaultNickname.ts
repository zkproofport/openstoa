/**
 * The name a new account gets, before anyone chooses one.
 *
 * It used to be `anon_a1b2c3d4` — and worse than the look of it, the product
 * ACTED on that look: writes were refused until the user picked something else,
 * so a new account could sign in, open chat, and watch a spinner that would
 * never resolve because the request behind it was being refused. The gate is
 * gone. A default name is a real name now, and someone who wants an identity
 * changes it.
 *
 * Derived straight from the nullifier, so it inherits the nullifier's
 * uniqueness: no shared pool, no collisions, no retry, and no way for an
 * account to be unable to sign in because its candidate names were taken. An
 * earlier version assembled names from word lists to read more like a person's
 * name; it bought that at the price of a collision path, and since a long name
 * is shortened for display anyway (`displayNickname`), it was not buying much.
 *
 * Two copies exist — `src/lib/defaultNickname.ts` (web/server) and
 * `packages/mobile/src/lib/defaultNickname.ts` (mini-app) — and a test asserts
 * they stay BYTE-IDENTICAL, so keep this file dependency-free.
 */

/** The prefix that marks a name this system chose. */
export const DEFAULT_NICKNAME_PREFIX = 'OS_';

/**
 * Reserved for accounts this project runs itself.
 *
 * Compared case-insensitively, because `openstoa_admin` impersonates just as
 * well as `OpenStoa_Admin` does.
 */
export const RESERVED_NICKNAME_PREFIX = 'openstoa';

/**
 * Hex characters in the name.
 *
 * Sixteen is not a proof of uniqueness, but at 2^64 it is the same bet the rest
 * of the system already makes on the nullifier, and `OS_` + 16 fits the
 * twenty-character nickname limit exactly.
 */
const HEX_CHARS = 16;

/**
 * A stable name for the account behind `nullifier`.
 *
 * The whole nullifier is folded in, rather than a slice of it taken. Slicing
 * looks equivalent and is not: two nullifiers that agree on their first
 * sixteen characters would get the SAME name, and the nickname column is
 * unique, so the second account would fail to be created at all. Real
 * nullifiers are hashes and rarely share a prefix — but "rarely" is the wrong
 * property for something that decides whether a sign-in works.
 *
 * FNV-1a over 64 bits: dependency-free, deterministic, and every character of
 * the input reaches the output.
 */
export function defaultNickname(nullifier: string): string {
  const OFFSET = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = OFFSET;
  for (let i = 0; i < nullifier.length; i++) {
    hash = (hash ^ BigInt(nullifier.charCodeAt(i))) & MASK;
    hash = (hash * PRIME) & MASK;
  }
  return `${DEFAULT_NICKNAME_PREFIX}${hash.toString(16).padStart(HEX_CHARS, '0')}`;
}

/**
 * Whether this name is one this system handed out rather than one a person
 * chose.
 *
 * Nothing is REFUSED on this basis — it is here so a profile screen can offer a
 * rename, and so `displayNickname` knows which names are safe to shorten.
 */
export function isDefaultNickname(nickname: string): boolean {
  // The legacy prefix still counts: accounts created before this existed are
  // still carrying `anon_…` and deserve the same offer.
  return nickname.startsWith(DEFAULT_NICKNAME_PREFIX) || nickname.startsWith('anon_');
}

/** Whether a person may take this name. Only the project's own prefix is held back. */
export function isReservedNickname(nickname: string): boolean {
  return nickname.toLowerCase().startsWith(RESERVED_NICKNAME_PREFIX);
}

/** Where a shortened default name is cut, before the ellipsis. */
const DISPLAY_MAX = 10;

/**
 * The name as it appears next to a message.
 *
 * A generated name is nineteen characters of hex and crowds out the message it
 * belongs to, so it is shortened. A name a PERSON chose is never shortened —
 * they picked those characters on purpose, and the limit is twenty anyway.
 *
 * The side effect is the point: shortened names all look alike, which is a
 * standing invitation to go and pick a real one.
 */
export function displayNickname(nickname: string): string {
  if (!isDefaultNickname(nickname) || nickname.length <= DISPLAY_MAX) return nickname;
  return `${nickname.slice(0, DISPLAY_MAX)}…`;
}
