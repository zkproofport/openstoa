/**
 * Filing the recovery key in the person's own space.
 *
 * WHY IT IS WORTH DOING. The key is shown once, in a sheet, and people close
 * sheets. Their own room is somewhere they already have, already see in the chat
 * list, and can search — it answers "where did I put that?" for the ordinary
 * case where the phone still works.
 *
 * WHY IT IS NOT A BACKUP, and why the note says so in its own body. The message
 * is sealed like any other, under a key derived from `master_key`. Lose that and
 * this message is exactly as unreadable as everything it was meant to rescue:
 * the recovery key, filed behind the recovery key. A copy people MISTAKE for a
 * backup is worse than no copy, because it is the difference between writing the
 * key down and believing you already did.
 *
 * WHY NOT A SYSTEM MESSAGE. `systemText` is a plaintext column the server reads
 * (`chat.ts`, SI-1). Putting the key there files the thing that opens
 * `master_key` in the database in the clear — the one value `keyManager` states
 * never reaches the server. So it goes through the ordinary sealed path, which
 * is also why this cannot be done server-side at all.
 *
 * FAILURE IS NOT REPORTED to the person. The sheet has already shown them the
 * key and asked them to store it, and that is the path that matters; a red line
 * about a copy failing would read as the key itself having failed. It is logged
 * and dropped.
 */
import { isRecoveryCodeNote, recoveryCodeNote, type RecoveryNoteStrings } from './recoveryCodeNote';
import {
  fileNoteOnce,
  type FileNoteResult,
  type ArchiveNote,
  type PersonalRoomClient,
  type PersonalRoomSealer,
} from './personalRoomNote';

/**
 * The client and sealer this needs, and the answers it can give.
 *
 * Aliases rather than separate declarations: the mechanism moved to
 * `personalRoomNote.ts` when the no-backup warning needed exactly the same one,
 * and two structurally-identical interfaces would drift the first time one
 * gained a method. The names stay because callers already import them.
 */
export type RecoveryNoteClient = PersonalRoomClient;
export type RecoveryNoteSealer = PersonalRoomSealer;
export type SendRecoveryNoteResult = FileNoteResult;

/**
 * Send the note, unless one is already there.
 *
 * The duplicate check reads the room's recent messages and looks for the marker
 * in text THIS DEVICE has decrypted — there is no server-side equivalent and
 * there must not be one. A device that cannot read the room cannot tell, and
 * answers `failed` rather than writing a second copy: the room already holding
 * an unreadable note is exactly the case where another one helps nobody.
 */
export async function sendRecoveryNote(
  client: RecoveryNoteClient,
  sealer: RecoveryNoteSealer,
  code: string,
  strings: RecoveryNoteStrings,
  opts: {
    alreadyFiled?: (topicId: string) => Promise<boolean>;
    /** Re-seal under the archive key so the note outlives this phone. */
    archive?: ArchiveNote;
  } = {},
): Promise<SendRecoveryNoteResult> {
  return fileNoteOnce(client, sealer, recoveryCodeNote(code, strings), opts);
}

/** Does any of these already-decrypted bodies hold a note? */
export function anyIsRecoveryNote(bodies: readonly string[]): boolean {
  return bodies.some(isRecoveryCodeNote);
}
