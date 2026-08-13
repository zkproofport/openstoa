/**
 * The two chat-status rules that BOTH clients have to agree on, in one place.
 *
 * Each of these was got wrong independently on web and on mobile, more than
 * once, because each surface re-derived it inline from whatever state happened
 * to be nearby:
 *
 *  - the spinner stopped before a single message had been decrypted, because
 *    "not probed yet" and "probed, answer was null" were both spelled `null`;
 *  - three messages sent in one burst appeared in random order, because the
 *    provisional rows were keyed by random uuid and the merge breaks
 *    same-millisecond ties by comparing ids as STRINGS.
 *
 * Two copies exist — `src/lib/chatStatus.ts` (web) and
 * `packages/mobile/src/lib/chatStatus.ts` (mini-app) — and a test asserts they
 * stay BYTE-IDENTICAL, so keep this file dependency-free.
 */

/** What the archive probe has said so far about this device's room key. */
export type ArchiveProbe = {
  /** How many rows on screen this device could not open. */
  lockedCount: number;
  /** The probe's answer, or null when it has answered "nothing to wait for". */
  rootState: 'verified' | 'waiting' | 'orphan' | 'unverified' | null;
  /** Whether the probe has answered AT ALL. Not the same as `rootState`. */
  rootProbed: boolean;
};

/**
 * Whether the room is still working on making its history readable.
 *
 * True means: keep one spinner up for the whole room, and render nothing at all
 * for the rows that cannot be opened yet. False means we are done trying, and a
 * row that is still unreadable is a real outcome that should say so.
 *
 * The `rootProbed` term is the one that matters. `rootState === null` is a
 * legitimate ANSWER — a scoped tier with no topic-wide root — and it is also
 * the value before anything has been asked, and for a guest or non-member who
 * will never ask. Treating those as the same thing spun forever in every case
 * where there was nothing to wait for.
 */
export function isSyncingHistory({ lockedCount, rootState, rootProbed }: ArchiveProbe): boolean {
  if (lockedCount <= 0) return false;
  if (!rootProbed) return true;
  return rootState === 'waiting';
}

/**
 * Provisional ids for messages that are on screen before the server has seen
 * them.
 *
 * Monotonic and zero-padded, because the merge breaks same-millisecond ties by
 * comparing ids as strings. Random ids therefore shuffled a burst of messages
 * into an arbitrary order, which then rearranged itself as each server row
 * replaced its provisional one.
 *
 * The prefix is what marks a row as not-yet-stored, so `isProvisionalId` is the
 * only thing that should ever test for it.
 */
const PENDING_PREFIX = 'pending-';
let pendingSeq = 0;

export function nextPendingId(): string {
  pendingSeq += 1;
  return `${PENDING_PREFIX}${String(pendingSeq).padStart(12, '0')}`;
}

/**
 * Whether an id was minted locally rather than assigned by the server.
 *
 * A provisional row must never be archived: the archive keys rows by the
 * server's uuid, so posting one is rejected — once per unsent message, on every
 * pass — and the row it would occupy belongs to the real message.
 */
export function isProvisionalId(id: string): boolean {
  return id.startsWith(PENDING_PREFIX);
}
