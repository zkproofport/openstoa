/**
 * The one line under a room's name in the chat list.
 *
 * EXTRACTED SO IT CAN BE GUARDED, and because it had a defect that reached a
 * phone: a `notice` row rendered as
 *
 *     dev_user_0cc86973: null
 *
 * Two things wrong in eight characters. The literal `null` is what
 * `${lastMessage.message}` produces for a row whose body is SEALED — notices
 * carry `ciphertext`, not the plaintext `message` that `join`/`leave` rows
 * carry, and the branch that handled system rows assumed the latter. And the
 * nickname prefix claims the person wrote it, which is the same false
 * authorship the room itself was just fixed for; the list had its own copy.
 *
 * NOTHING IS DECRYPTED HERE. Opening a sealed body would bootstrap or rejoin the
 * MLS group and churn epochs just from LOOKING at the list, so a sealed row
 * shows a placeholder either way. The question this file answers is only whose
 * name, if anyone's, goes in front of it.
 */
import type { ChatMessage } from '@openstoa/api-types';

type Translate = (key: string) => string;

/** The newest row in a room, as the list has it. */
export type PreviewRow =
  | Pick<ChatMessage, 'type' | 'nickname' | 'message'> & { userId?: string }
  | undefined
  | null;

/**
 * Whose room this is, as far as the preview needs to know.
 *
 * `personal: true` means the room has exactly one member — the reader. Naming
 * the sender there is naming the person reading the list, which is noise at
 * best: they know who wrote it, there is nobody else it could be, and the name
 * eats the width the message itself needs. Seen on a device on 2026-08-27 as
 * `dev_user_a7fd80da: 🔒 암호화된 메시지` on a row titled "My space".
 */
export interface PreviewRoom {
  personal?: boolean;
  /**
   * Who is reading. Used to say "나" instead of repeating their own nickname
   * back at them — a list that prints your own name at you tells you nothing
   * and reads like somebody else wrote it.
   */
  meUserId?: string | null;
}

/**
 * How to introduce the sender, or `null` when nobody should be named.
 *
 * `null` in a personal room: the only member is the reader, so a name is noise
 * that eats the width the message needs.
 */
function senderLabel(
  row: { nickname: string; userId?: string },
  room: PreviewRoom | undefined,
  t: Translate,
): string | null {
  if (room?.personal) return null;
  if (room?.meUserId && row.userId && row.userId === room.meUserId) {
    return t('openstoa.chat.youPrefix');
  }
  return row.nickname;
}

export function chatPreview(row: PreviewRow, t: Translate, room?: PreviewRoom): string {
  if (!row) return t('openstoa.chat.noMessagesYet');

  /*
   * A NOTICE HAS NO AUTHOR TO NAME. It is filed with the reader's own token —
   * the only token that can seal into their room — so its `nickname` is the
   * reader's, and printing it says they wrote something they did not.
   *
   * Its body is sealed, so there is no text to show either; the placeholder is
   * the same one a message gets, minus the name.
   */
  if (row.type === 'notice') return t('openstoa.chat.encryptedMessage');

  if (row.type === 'message') {
    const who = senderLabel(row, room, t);
    const body = t('openstoa.chat.encryptedMessage');
    return who ? `${who}: ${body}` : body;
  }

  /*
   * `join` / `leave` — public text, in `message`. Guarded rather than
   * interpolated blind: a row of an unknown type, or one whose text the server
   * did not send, used to render the string "null" straight to the person. An
   * empty preview is a worse-looking bug that is at least not a lie.
   */
  const text = typeof row.message === 'string' && row.message ? row.message : null;
  if (!text) return t('openstoa.chat.encryptedMessage');

  /*
   * NO NAME PREFIX HERE, in any room. A join/leave row's body is built by the
   * server as `"<nickname> joined the chat"` (`src/lib/chat.ts`), so prefixing
   * it printed the name TWICE — "alice: alice joined the chat".
   *
   * Found while mutation-testing the personal-room change: removing the prefix
   * from this line changed no result, which meant no case reached it. The
   * cases were all `message` rows, and a `message` returns above — this branch
   * only ever sees `join` and `leave`.
   */
  return text;
}
