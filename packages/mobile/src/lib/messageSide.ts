/**
 * Which side of the room a chat row is drawn on.
 *
 * EXTRACTED SO IT CAN BE GUARDED. This decision lived inline in a 2,800-line
 * screen, and the screen cannot be rendered with an ordinary message in a unit
 * test — decrypting one needs real MLS group state, so those rows are dropped
 * and there is nothing to assert against. Three attempts at a guard failed in
 * three different ways before this: a source scan of the expression (satisfied
 * by a rename), a render with no session (false for both rows, so it could not
 * tell a fixed case from a broken one), and a render with a session (the
 * control row never appeared).
 *
 * A pure function is what remains that is honest: it guards the DECISION, and a
 * mutation to it turns a test red. It does not guard the LAYOUT — that is a
 * device check, and it is where the defect below was actually seen.
 *
 * THE DEFECT, on a phone on 2026-08-27. A recovery-code notice appeared as a
 * right-hand bubble in the person's own space: their voice, their side, for a
 * message they had never written. A notice is filed with the reader's own token
 * because that is the only token that can seal into their room, and the side was
 * decided by comparing that id to the reader's.
 */

/** The fields the decision needs. Nothing else about a row matters here. */
export interface SideInput {
  /** Row author as the server recorded it. */
  userId?: string | null;
  /** `notice` is from the system; everything else is from a member. */
  type?: string | null;
  /** Optimistic row, not yet acknowledged. */
  pending?: boolean;
  /** Optimistic row whose send failed. */
  failed?: boolean;
}

/**
 * Is this row the reader's own message?
 *
 * ORDER IS LOAD-BEARING. `notice` is checked FIRST, before the optimistic
 * branch: nothing types a notice into a composer, so there is no provisional
 * case to preserve — and checking it second would let a retry flip a system
 * message back onto the reader's side.
 *
 * A provisional row is mine by construction: it has not been near the server, so
 * there is no `userId` to compare and deciding by comparison alone would put the
 * bubble on the LEFT until the server answered, then slide it right.
 */
export function isOwnMessage(item: SideInput, sessionUserId: string | null | undefined): boolean {
  if (item.type === 'notice') return false;
  if (item.pending || item.failed) return true;
  // A row with no author, or a reader with no id, is not the reader's — the
  // alternative claims authorship on the strength of two absent values matching.
  if (!item.userId || !sessionUserId) return false;
  return item.userId === sessionUserId;
}
