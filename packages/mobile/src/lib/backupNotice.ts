/**
 * The message that tells somebody their chat history is one accident away from
 * being gone.
 *
 * WHY A CHAT MESSAGE AND NOT A BADGE. A profile badge is somewhere you have to
 * go; nobody goes there to find out about a problem they do not know they have.
 * A message in the person's own room raises an unread count, sits in the chat
 * list next to rooms they actually open, and is still there next week. That is
 * the difference between a warning and a decoration.
 *
 * WHY IT IS SEALED LIKE ANY OTHER MESSAGE. `systemText` is a plaintext column
 * the server reads (`src/lib/chat.ts`, SI-1). Nothing about this note is secret,
 * but a system message is a server-authored row — and a server that can author
 * rows in a person's own room is a server that can author any row in it, which
 * is the property this product sells. It goes through the ordinary sealed path,
 * which is also why it cannot be sent from the backend at all.
 *
 * WHY THE WORDING NEVER SAYS "BEFORE YOU DELETE THE APP". `expo-secure-store`
 * keeps its items on iOS across an app deletion and does NOT on Android — so
 * "back up before you uninstall" is FALSE for every iPhone user reading it, and
 * a warning caught being wrong once is a warning the next one does not survive.
 * The copy names what actually removes the key: resetting the phone, moving to
 * a new one, erasing the app's data from Profile, and — on Android only —
 * reinstalling.
 *
 * WHY EACH KIND HAS ITS OWN MARKER. Recognising a note already in the room is
 * how a person is spared twenty copies of the same warning, and the only thing
 * that can do the recognising is this device, on text it has already decrypted.
 * A locale-independent leading glyph survives the user switching language, which
 * matching on the heading would not: a Korean-then-English switch would file a
 * second copy of a warning already sitting there. Per-KIND rather than one
 * family marker because "you have no backup" and "your backup does not open
 * these rooms" are different facts, and somebody who fixed the first and later
 * hit the second should hear about the second.
 */

import type { BackupNoticeKind } from './backupHealth';

/**
 * The leading glyph for each kind. Stable forever: change one and every note
 * already filed stops being recognised, and the room starts collecting copies.
 */
export const BACKUP_NOTICE_MARKERS: Record<BackupNoticeKind, string> = {
  /** Nothing is backed up. */
  none: '\u{1F6A8} ',
  /** A backup exists and opens nothing. */
  unopenable: '\u{1F513} ',
};

export interface BackupNoticeStrings {
  /** One line naming the problem. */
  heading: string;
  /** What is at stake, what removes the key, and what to do. */
  body: string;
}

/**
 * Build the note.
 *
 * Heading and body are joined here rather than in the caller so a screen that
 * only wanted the headline cannot send the alarming half without the sentence
 * that says what to do about it.
 */
export function backupNotice(kind: BackupNoticeKind, s: BackupNoticeStrings): string {
  return `${BACKUP_NOTICE_MARKERS[kind]}${s.heading}\n\n${s.body}`;
}

/**
 * Which kind of note this body is, if any.
 *
 * Anchored at the START, like `isRecoveryCodeNote`. A message that merely
 * CONTAINS the glyph — somebody quoting the note back, an unrelated message
 * that happens to use the emoji — is not one of these, and treating it as one
 * would suppress the real note forever.
 *
 * Only ever applied to text THIS DEVICE has decrypted. There is no server-side
 * equivalent and there must not be one: the server cannot read these rooms, and
 * a marker it could see would be a marker it could index.
 */
export function backupNoticeKindOf(body: string): BackupNoticeKind | null {
  for (const kind of Object.keys(BACKUP_NOTICE_MARKERS) as BackupNoticeKind[]) {
    if (body.startsWith(BACKUP_NOTICE_MARKERS[kind])) return kind;
  }
  return null;
}

/** Every kind of note already sitting in these already-decrypted bodies. */
export function filedBackupNoticeKinds(bodies: readonly string[]): Set<BackupNoticeKind> {
  const found = new Set<BackupNoticeKind>();
  for (const body of bodies) {
    const kind = backupNoticeKindOf(body);
    if (kind) found.add(kind);
  }
  return found;
}
