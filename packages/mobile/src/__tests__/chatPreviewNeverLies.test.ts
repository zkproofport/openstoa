/*
 * The one line under a room's name must not print `null`, and must not put a
 * name on something the person did not write.
 *
 * SEEN ON A PHONE, 2026-08-27:
 *
 *     My space
 *     dev_user_0cc86973: null
 *
 * Two defects in eight characters. `null` is what `${row.message}` produces for
 * a SEALED row — a notice carries `ciphertext`, not the plaintext `message`
 * that `join`/`leave` carry, and the system branch assumed the latter. And the
 * nickname claims authorship: a notice is filed with the reader's own token, so
 * its `nickname` is theirs, and printing it says they wrote something they did
 * not. The room itself had just been fixed for exactly that; the list kept its
 * own copy of the mistake.
 *
 * NOTHING IS DECRYPTED HERE and no test should ask for it: opening a sealed body
 * would bootstrap or rejoin the MLS group and churn epochs just from LOOKING at
 * the list.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → a notice shows no author
 *   contract  → an ordinary message keeps its author
 *   hostile   → a null / undefined / empty body never reaches the screen
 *   hostile   → an unknown future type does not print its raw body either
 *   boundary  → no rows at all
 *   integrity → the literal string "null" never appears, whatever the input
 */
import { describe, it, expect } from 'vitest';

import { chatPreview, type PreviewRow } from '../lib/chatPreview';

/** Identity translator: the assertions read as the keys they check. */
const t = (k: string) => k;
const ENC = 'openstoa.chat.encryptedMessage';
const NONE = 'openstoa.chat.noMessagesYet';

const row = (over: Partial<NonNullable<PreviewRow>>): PreviewRow =>
  ({ type: 'message', nickname: 'me', message: null, ...over }) as PreviewRow;

describe('the chat list preview never lies', () => {
  it('CONTRACT: a notice shows no author', () => {
    /*
     * The defect exactly. `nickname` is the reader's own, because their token
     * filed it — naming them says they wrote it.
     *
     * THE ASSERTION IS THE ABSENT NAME, not the placeholder text. Removing the
     * notice branch makes the row fall through to the join/leave one, which now
     * ALSO returns a placeholder for an empty body — so a test that only checked
     * the text passed with the branch deleted. Measured: mutation M1 survived
     * until this case was written this way. What the two branches disagree about
     * is the name, and that is the only thing worth asserting here.
     */
    const out = chatPreview(row({ type: 'notice', nickname: 'dev_user_0cc86973' }), t);
    expect(out).toBe(ENC);
    expect(out).not.toContain('dev_user_0cc86973');
    expect(out).not.toContain(':');
  });

  it('CONTRACT: a notice with a nickname AND a body still names nobody', () => {
    /*
     * The combination the fall-through survives on. Give the row a plaintext
     * `message` as well: without its own branch it takes the join/leave path and
     * prints "name: text" — a system notice wearing the reader's name and
     * leaking a body the list is not supposed to read.
     */
    const out = chatPreview(
      row({ type: 'notice', nickname: 'dev_user_0cc86973', message: 'leaked text' }),
      t,
    );
    expect(out).toBe(ENC);
    expect(out).not.toContain('dev_user_0cc86973');
    expect(out).not.toContain('leaked text');
  });

  it('CONTRACT: an ordinary message keeps its author', () => {
    // The control. Removing the name from everything would be the same bug
    // pointing the other way.
    expect(chatPreview(row({ type: 'message', nickname: 'kim' }), t)).toBe(`kim: ${ENC}`);
  });

  it('CONTRACT: a join/leave row shows its public text, with the name once', () => {
    /*
     * This case used to assert `kim: kim joined the chat` — the name twice —
     * and so held the defect in place as the expected answer. The server writes
     * the body as `"<nickname> joined the chat"` (`src/lib/chat.ts`), so there
     * was never a prefix to add.
     */
    expect(
      chatPreview(row({ type: 'join', nickname: 'kim', message: 'kim joined the chat' }), t),
    ).toBe('kim joined the chat');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
  ])('HOSTILE: a %s body never reaches the screen', (_label, body) => {
    /*
     * This is the half that put the word `null` in front of a person. A missing
     * body is a placeholder, never an interpolation.
     */
    const out = chatPreview(row({ type: 'join', nickname: 'kim', message: body as never }), t);
    expect(out).toBe(ENC);
    expect(out).not.toContain('null');
    expect(out).not.toContain('undefined');
  });

  it('HOSTILE: an unknown future type does not print its raw body', () => {
    // A type added later must fail towards a placeholder, not towards leaking
    // whatever happens to be in `message`.
    const out = chatPreview(row({ type: 'something-new' as never, message: null }), t);
    expect(out).not.toContain('null');
  });

  it('BOUNDARY: no rows at all', () => {
    expect(chatPreview(undefined, t)).toBe(NONE);
    expect(chatPreview(null, t)).toBe(NONE);
  });

  it('INTEGRITY: the literal "null" never appears, for ANY combination', () => {
    /*
     * The accumulating axis, and the one that would have caught this before a
     * phone did: every type crossed with every empty body, all at once, rather
     * than the single happy row a hand-written case would use.
     */
    const types = ['message', 'notice', 'join', 'leave', 'unknown'] as const;
    const bodies = [null, undefined, '', 'real text'] as const;
    const names = ['me', '', 'null'] as const;

    for (const type of types) {
      for (const message of bodies) {
        for (const nickname of names) {
          const out = chatPreview(row({ type: type as never, nickname, message: message as never }), t);
          // A nickname that is literally "null" is the person's own doing and
          // may legitimately appear; the BODY never may.
          const withoutName = out.replace(new RegExp(`^${nickname}: `), '');
          expect(withoutName).not.toBe('null');
          expect(withoutName).not.toBe('undefined');
        }
      }
    }
  });
});

describe('a personal room does not name the only person in it', () => {
  /*
   * FOUND ON A DEVICE, 2026-08-27, on a row titled "My space":
   *
   *     dev_user_a7fd80da: 🔒 암호화된 메시지
   *
   * The room has exactly one member and it is the person reading the list.
   * Naming them tells them nothing, and it eats the width the message needs —
   * on a narrow row the name pushes the actual content out of view entirely.
   *
   * NOT "hide my own name everywhere". In a room with other people the sender
   * matters, including when the sender is you: a list that shows the words
   * without saying who said them makes you open the room to find out.
   */
  it('CONTRACT: no name in a personal room', () => {
    expect(chatPreview({ type: 'message', nickname: 'me', message: 'x' }, t, { personal: true }))
      .toBe('openstoa.chat.encryptedMessage');
  });

  it('CONTRACT: the name stays in a room with other people', () => {
    expect(chatPreview({ type: 'message', nickname: 'me', message: 'x' }, t, { personal: false }))
      .toBe('me: openstoa.chat.encryptedMessage');
    // And with no room information at all — the caller that has not been
    // updated must keep the old, safe behaviour rather than silently dropping
    // the sender.
    expect(chatPreview({ type: 'message', nickname: 'me', message: 'x' }, t))
      .toBe('me: openstoa.chat.encryptedMessage');
  });

  it('ACCUMULATING: ten previews in a personal room never leak a name', () => {
    /*
     * THE AXIS. A fix applied at one of the two places a name is printed passes
     * a single-case test and leaks at the other — and which one you hit depends
     * on whether the row decrypted, which varies row to row down the same list.
     */
    const rows = Array.from({ length: 10 }, (_, i) => ({
      type: 'message' as const,
      nickname: `person-${i}`,
      message: i % 2 === 0 ? '' : `words ${i}`,
    }));

    const out = rows.map((r) => chatPreview(r, t, { personal: true }));

    for (const [i, line] of out.entries()) {
      expect(line, `row ${i}`).not.toContain('person-');
      expect(line, `row ${i}`).not.toContain(':');
    }
  });

  it('INTEGRITY: a notice is still nameless in both kinds of room', () => {
    // It was never the person's message. That was fixed once already; this
    // stops the new room argument from bringing it back for group rooms.
    for (const room of [{ personal: true }, { personal: false }, undefined]) {
      expect(chatPreview({ type: 'notice', nickname: 'me', message: 'x' }, t, room))
        .toBe('openstoa.chat.encryptedMessage');
    }
  });
});

describe('a join or leave row does not print the name twice', () => {
  /*
   * The server builds these bodies as `"<nickname> joined the chat"`
   * (`src/lib/chat.ts`), so a name prefix produced
   *
   *     alice: alice joined the chat
   *
   * FOUND BY MUTATION TESTING, not by reading. Removing the prefix from that
   * line changed no result, which meant nothing reached it — every case was a
   * `message` row, and those return earlier, so the branch only ever sees
   * `join` and `leave`. The surviving mutation was the evidence that the whole
   * branch was untested, and the bug was sitting inside it.
   */
  it('CONTRACT: the body is shown as the server wrote it', () => {
    expect(chatPreview({ type: 'join', nickname: 'alice', message: 'alice joined the chat' }, t))
      .toBe('alice joined the chat');
    expect(chatPreview({ type: 'leave', nickname: 'bob', message: 'bob left the chat' }, t))
      .toBe('bob left the chat');
  });

  it('CONTRACT: a personal room is no different — there was never a prefix to drop', () => {
    expect(
      chatPreview({ type: 'join', nickname: 'me', message: 'me joined the chat' }, t, {
        personal: true,
      }),
    ).toBe('me joined the chat');
  });

  it('ACCUMULATING: ten join rows each print one name, never two', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      type: 'join' as const,
      nickname: `person-${i}`,
      message: `person-${i} joined the chat`,
    }));

    for (const [i, r] of rows.entries()) {
      const line = chatPreview(r, t);
      const times = line.split(`person-${i}`).length - 1;
      expect(times, `row ${i} names the person once`).toBe(1);
    }
  });

  it('BOUNDARY: a system row with no body falls back rather than printing a bare name', () => {
    for (const bad of ['', null, undefined]) {
      expect(
        chatPreview({ type: 'join', nickname: 'alice', message: bad as unknown as string }, t),
      ).toBe('openstoa.chat.encryptedMessage');
    }
  });
});

describe('the list says 나, not your own nickname back at you', () => {
  /*
   * The user, looking at the device on 2026-08-27: "그 유저는 나 아니니? 내
   * 닉네임을 거길 올려? ux 적으로?"
   *
   * Printing somebody's own name at them tells them nothing and reads like a
   * stranger wrote it — the whole point of a preview line is "who said this",
   * and for your own message the answer is not a random-looking handle like
   * `dev_user_a7fd80da`.
   *
   * STILL A LABEL, NOT NOTHING. In a room with other people the sender matters
   * even when it is you: a line with no name at all makes you open the room to
   * find out whether you are waiting on a reply. So it becomes "나", which is
   * what every chat app people already use does.
   */
  const ME = '0xme';
  const THEM = '0xthem';

  it('CONTRACT: my own message is introduced as 나', () => {
    expect(
      chatPreview({ type: 'message', nickname: 'dev_user_a7fd80da', userId: ME, message: 'x' }, t, {
        meUserId: ME,
      }),
    ).toBe('openstoa.chat.youPrefix: openstoa.chat.encryptedMessage');
  });

  it("CONTRACT: somebody else's message keeps their nickname", () => {
    expect(
      chatPreview({ type: 'message', nickname: 'alice', userId: THEM, message: 'x' }, t, {
        meUserId: ME,
      }),
    ).toBe('alice: openstoa.chat.encryptedMessage');
  });

  it('BOUNDARY: with no reader known, nothing is claimed to be mine', () => {
    /*
     * A signed-out list, or one rendering before the session resolves. Guessing
     * would put "나" on a stranger's message, which is worse than a handle.
     */
    for (const room of [undefined, {}, { meUserId: null }]) {
      expect(
        chatPreview({ type: 'message', nickname: 'alice', userId: THEM, message: 'x' }, t, room),
      ).toBe('alice: openstoa.chat.encryptedMessage');
    }
  });

  it('BOUNDARY: a row with no sender id is never claimed to be mine', () => {
    // Older cached rows predate the field. Absent must not compare equal to
    // absent and turn everyone into me.
    expect(
      chatPreview({ type: 'message', nickname: 'alice', message: 'x' }, t, { meUserId: ME }),
    ).toBe('alice: openstoa.chat.encryptedMessage');
    expect(
      chatPreview({ type: 'message', nickname: 'alice', userId: undefined, message: 'x' }, t, {
        meUserId: undefined,
      }),
    ).toBe('alice: openstoa.chat.encryptedMessage');
  });

  it('INTEGRITY: a personal room still names nobody, mine or not', () => {
    // The narrower rule wins: one member means there is nothing to disambiguate.
    expect(
      chatPreview({ type: 'message', nickname: 'me', userId: ME, message: 'x' }, t, {
        personal: true,
        meUserId: ME,
      }),
    ).toBe('openstoa.chat.encryptedMessage');
  });

  it('ACCUMULATING: a mixed list labels each row by its own sender', () => {
    /*
     * THE AXIS. A fix that reads the reader's id once and applies one answer to
     * the whole list passes any single-row case and then labels every message
     * "나" — including the ones you are waiting on a reply to.
     */
    const rows = Array.from({ length: 10 }, (_, i) => ({
      type: 'message' as const,
      nickname: i % 2 === 0 ? 'dev_user_a7fd80da' : `alice-${i}`,
      userId: i % 2 === 0 ? ME : `0xthem-${i}`,
      message: 'x',
    }));

    const out = rows.map((r) => chatPreview(r, t, { meUserId: ME }));

    for (const [i, line] of out.entries()) {
      if (i % 2 === 0) {
        expect(line, `row ${i} is mine`).toContain('youPrefix');
        expect(line, `row ${i} must not show my handle`).not.toContain('dev_user_a7fd80da');
      } else {
        expect(line, `row ${i} is theirs`).toContain(`alice-${i}`);
        expect(line, `row ${i} must not be called mine`).not.toContain('youPrefix');
      }
    }
  });
});
