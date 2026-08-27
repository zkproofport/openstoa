/**
 * The copy of the recovery key that lands in the person's own space.
 *
 * WHY A COPY EXISTS AT ALL. The key is shown once, in a sheet, and people close
 * sheets. A second place to find it — a room they already have, that already
 * shows in their chat list — costs nothing and answers "where did I put that?"
 * for the ordinary case where the phone still works.
 *
 * WHY IT IS NOT A BACKUP, and why the note says so out loud. The message is
 * sealed like any other, under a key derived from `master_key`. Lose that key
 * and this message is exactly as unreadable as everything else it was meant to
 * rescue — the recovery key, filed behind the recovery key. A copy that people
 * mistake for a backup is worse than no copy, because it is the difference
 * between writing the key down and thinking you already did.
 *
 * WHY NOT A SYSTEM MESSAGE, which was the first shape tried and is the tempting
 * one: `systemText` is a PLAINTEXT column the server reads (`chat.ts`, SI-1).
 * Putting the key there files the thing that opens `master_key` in the database
 * in the clear — the one value `keyManager` says never reaches the server. It
 * goes through the ordinary sealed path instead.
 *
 * The text is assembled here rather than in the screen so the warning cannot be
 * dropped by a caller who only wanted to send the code.
 */

/** How the note is recognised later, without reading anyone's messages. */
export const RECOVERY_NOTE_MARKER = '\u{1F511} ';

export interface RecoveryNoteStrings {
  /** "Your recovery key" */
  heading: string;
  /** The warning. Not optional — see above. */
  warning: string;
}

/**
 * Build the note.
 *
 * The code sits on its own line so a long-press copy takes the key and not the
 * prose around it.
 */
export function recoveryCodeNote(code: string, s: RecoveryNoteStrings): string {
  return `${RECOVERY_NOTE_MARKER}${s.heading}\n\n${code}\n\n${s.warning}`;
}

/**
 * Whether a message body is one of these notes.
 *
 * Used to avoid writing a second one, and only ever applied to text this device
 * has already decrypted — there is no server-side equivalent, and there must not
 * be one.
 */
export function isRecoveryCodeNote(body: string): boolean {
  return body.startsWith(RECOVERY_NOTE_MARKER);
}
