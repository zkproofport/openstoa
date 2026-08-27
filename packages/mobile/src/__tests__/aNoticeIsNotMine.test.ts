/*
 * A system notice must not read as something the person wrote.
 *
 * THE DEFECT, seen on a phone on 2026-08-27. The recovery-code note appeared as
 * a RIGHT-HAND bubble in the person's own space — their own voice, their own
 * side of the room — for a message they had never written. It is filed with
 * their token because that is the only way to seal it into their room, and the
 * client decides sides by comparing that id to the reader's.
 *
 * WHY NOT A `join`/`leave` SYSTEM ROW. Those carry `systemText`, a PLAINTEXT
 * column the server reads (SI-1). A recovery code is the value that opens
 * `master_key`; putting it there defeats what it protects. A notice stays
 * sealed and changes only its TYPE.
 *
 * WHY NOT A CENTRED SYSTEM LINE either — the shape a first attempt reached for.
 * A recovery code has to be COPYABLE, and a centred grey line is not a bubble
 * you can long-press. It is a received message: tap-to-copy intact, author not
 * claimed.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → the note is filed with type 'notice'
 *   integrity  → the body still travels sealed, never as plaintext
 *   race       → N notes in a row are each a notice, not just the first
 */
import { describe, it, expect } from 'vitest';

import { isOwnMessage } from '../lib/messageSide';
import { useOpenStoaSession } from '../stores/sessionStore';
import { act } from 'react-test-renderer';

import { fileNoteOnce, type PersonalRoomClient, type PersonalRoomSealer } from '../lib/personalRoomNote';

const TOPIC = 'topic-personal';

function harness() {
  const posted: Array<Record<string, unknown>> = [];
  let n = 0;
  const client: PersonalRoomClient = {
    get: (async () => ({ topics: [{ id: TOPIC, personal: true }] })) as never,
    post: (async (_path: string, body: unknown) => {
      posted.push(body as Record<string, unknown>);
      return { message: { id: `m${++n}` } };
    }) as never,
  };
  const sealer: PersonalRoomSealer = {
    /*
     * OPAQUE, like the real thing. A fake that echoed the plaintext into the
     * ciphertext would make the "never as plaintext" assertion below fail on the
     * FAKE rather than on the code — which is exactly what the first version of
     * this file did.
     */
    seal: async (_t, plaintext) => ({
      ciphertext: Buffer.from(plaintext, 'utf8').toString('base64'),
      epoch: 1,
    }),
    cachePlaintext: async () => {},
  };
  return { client, sealer, posted };
}

describe('a filed note is a notice, not a message from the reader', () => {
  it("CONTRACT: the note is filed with type 'notice'", async () => {
    const { client, sealer, posted } = harness();
    await fileNoteOnce(client, sealer, 'the note');

    expect(posted).toHaveLength(1);
    expect(posted[0].type).toBe('notice');
  });

  it('INTEGRITY: the body travels SEALED — never as plaintext', async () => {
    /*
     * The whole reason a notice is not a `join`/`leave` row. If the body ever
     * appears in a plaintext field, a recovery code lands in a column the server
     * reads.
     */
    const body = 'BIXR-UGUZ-USCL-EI6V';
    const { client, sealer, posted } = harness();
    await fileNoteOnce(client, sealer, body);

    expect(posted[0].ciphertext).toBe(Buffer.from(body, 'utf8').toString('base64'));
    expect(posted[0].systemText).toBeUndefined();
    expect(posted[0].message).toBeUndefined();
    // ...and nowhere else in the payload either.
    expect(JSON.stringify(posted[0])).not.toContain(body);
  });

  it('RACE: five notes in a row are EACH a notice', async () => {
    // A first-one-only implementation would leave four of them drawn as the
    // person's own messages, which is the defect wearing a smaller hat.
    const { client, sealer, posted } = harness();
    for (let i = 0; i < 5; i++) await fileNoteOnce(client, sealer, `note ${i}`);

    expect(posted.map((p) => p.type)).toEqual(Array(5).fill('notice'));
  });
});

/*
 * THE SIDE DECISION — guarded where it can actually be guarded.
 *
 * THREE ATTEMPTS FAILED BEFORE THIS, and naming them is the point of the
 * comment: each looked like a test and guarded nothing.
 *
 *   1. A SOURCE SCAN of the `isOwn` expression. Rename the variable, still
 *      green. Never asks which side anything lands on.
 *   2. A RENDER with no session. `isOwn` compares the row's author to the
 *      reader; with no reader it is false either way, so deleting the `notice`
 *      case left the test green.
 *   3. A RENDER with a session. The control row — an ordinary message — never
 *      appears at all: decrypting one needs real MLS group state, so the screen
 *      drops it. Measured: `notice` 1 node, `message` 0 nodes, whether the
 *      author was the reader or a peer.
 *
 * So the decision was extracted to `lib/messageSide` and is guarded there. This
 * guards the DECISION, not the LAYOUT — the layout is a device check, and that
 * is where the defect was actually seen.
 */
describe('which side a row is drawn on', () => {
  const ME = 'user-me';

  it('CONTRACT: a notice under MY id is NOT mine', () => {
    // The defect exactly: filed with the reader's token, because that is the
    // only token that can seal into their room.
    expect(isOwnMessage({ userId: ME, type: 'notice' }, ME)).toBe(false);
  });

  it('CONTROL: an ordinary message under MY id IS mine', () => {
    // The half that makes the case above mean something. Same id, same reader —
    // only the type differs.
    expect(isOwnMessage({ userId: ME, type: 'message' }, ME)).toBe(true);
  });

  it("CONTRACT: a peer's message is not mine", () => {
    expect(isOwnMessage({ userId: 'peer', type: 'message' }, ME)).toBe(false);
  });

  it('INTEGRITY: a notice stays not-mine even when pending or failed', () => {
    /*
     * Order is the assertion. If `notice` were checked AFTER the optimistic
     * branch, a retry would flip a system message onto the reader's side — and
     * the optimistic branch exists precisely to claim rows the server has not
     * seen yet.
     */
    expect(isOwnMessage({ userId: ME, type: 'notice', pending: true }, ME)).toBe(false);
    expect(isOwnMessage({ userId: ME, type: 'notice', failed: true }, ME)).toBe(false);
  });

  it('CONTRACT: an optimistic row is mine before the server answers', () => {
    // It has not been near the server, so there is no id to compare; deciding by
    // comparison alone put the bubble on the left, then slid it right.
    expect(isOwnMessage({ type: 'message', pending: true }, ME)).toBe(true);
    expect(isOwnMessage({ type: 'message', failed: true }, ME)).toBe(true);
  });

  it.each([
    ['no reader', { userId: ME, type: 'message' }, null],
    ['no author', { type: 'message' }, ME],
    ['neither', { type: 'message' }, null],
    // THE COMBINATION THAT MAKES THE GUARD NECESSARY. Without the explicit
    // check, `'' === ''` is TRUE and the row is claimed as the reader's — a
    // signed-out reader and an author-less row agreeing they are the same
    // person. A first version of this list used only `undefined`/`null`, where
    // `undefined === null` is false anyway, so removing the guard changed
    // nothing and the mutation survived.
    ['both empty strings', { userId: '', type: 'message' }, ''],
    ['empty author, empty reader', { userId: '', type: 'message' }, ''],
  ])('BOUNDARY: %s does not claim authorship', (_label, item, reader) => {
    expect(isOwnMessage(item as never, reader as never)).toBe(false);
  });

  it('REPETITION: twenty evaluations of the same notice never flip', () => {
    // The screen re-evaluates this on every render for the whole visit, and the
    // defect persisted across all of them.
    const seen = new Set<boolean>();
    for (let i = 0; i < 20; i++) seen.add(isOwnMessage({ userId: ME, type: 'notice' }, ME));
    expect([...seen]).toEqual([false]);
  });
});
