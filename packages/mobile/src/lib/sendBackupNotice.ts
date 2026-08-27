/**
 * Telling somebody, once, that their chat history is not backed up.
 *
 * WHAT IT COSTS TO GET WRONG IN EACH DIRECTION, because that is what every
 * decision in here is balancing:
 *
 *   Too quiet  → a person loses every encrypted conversation they have, and the
 *                first they hear about it is when the new phone shows empty
 *                rooms. Nothing can be done at that point, by them or by us.
 *   Too loud   → their own room fills with identical alarms, they stop reading
 *                it, and the notice that mattered is buried under nineteen
 *                copies of itself. A warning nobody reads is worth nothing, so
 *                this is not the "safe" side of the trade.
 *
 * The resolution is: say it when the facts are established (`backupHealth`
 * returns `unknown` for everything else), say it in the room they already look
 * at, and say it exactly once per distinct fact.
 *
 * ONCE IS ENFORCED BY READING THE ROOM, not by a local flag. A flag lives in
 * storage that a reinstall clears, and this app runs on Android where a
 * reinstall also destroys the key the whole warning is about — so the launch
 * that most needs to re-check is precisely the launch where a flag would have
 * been lost. The room itself is the record, and the only reader of it is this
 * device.
 *
 * REFUSING TO GUESS IS PART OF THE ONCE. A scan that could not read the whole
 * room does not know whether a note is in it, and a scan that could not decrypt
 * does not either. Both answer "do not write" — `fileNoteOnce` treats a thrown
 * predicate as a reason to leave the room alone.
 */

import { noticeKindFor, type BackupHealth, type BackupNoticeKind } from './backupHealth';
import { backupNotice, filedBackupNoticeKinds, type BackupNoticeStrings } from './backupNotice';
import {
  fileNoteOnce,
  scanPersonalRoom,
  type FileNoteResult,
  type OpenRow,
  type PersonalRoomClient,
  type PersonalRoomSealer,
} from './personalRoomNote';

export type SendBackupNoticeResult =
  | FileNoteResult
  /** Nothing to say: backed up, nothing at stake yet, or the facts are not in. */
  | { kind: 'not-needed'; health: BackupHealth['kind'] };

/** The copy for every kind, so a new kind cannot ship without its words. */
export type BackupNoticeCopy = Record<BackupNoticeKind, BackupNoticeStrings>;

/**
 * File the notice this account's state calls for, if it does not already have
 * one.
 *
 * `open` decrypts one history row. It is passed in rather than imported because
 * the real implementation consumes MLS message keys on first use and needs the
 * session store's plaintext cache to avoid doing so — see
 * `toDisplayMessageMls`.
 */
export async function sendBackupNotice(
  client: PersonalRoomClient,
  sealer: PersonalRoomSealer,
  open: OpenRow,
  health: BackupHealth,
  copy: BackupNoticeCopy,
): Promise<SendBackupNoticeResult> {
  const kind = noticeKindFor(health);
  if (!kind) return { kind: 'not-needed', health: health.kind };

  return fileNoteOnce(client, sealer, backupNotice(kind, copy[kind]), {
    alreadyFiled: async (topicId) => {
      const scan = await scanPersonalRoom(client, topicId, open);
      /*
       * Thrown, not returned as `true`. "There is already a note" and "I could
       * not check" both stop the write, but only one of them is a state the
       * caller should treat as settled — reporting a partial scan as `already`
       * would record a note that may not exist, and the next launch would trust
       * that just as blindly.
       */
      if (scan.kind === 'partial') {
        throw new Error('personal room history is longer than one scan; cannot prove absence');
      }
      return filedBackupNoticeKinds(scan.bodies).has(kind);
    },
  });
}
