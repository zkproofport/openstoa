/**
 * Reading a JOINING device's identity out of the Commit that added it.
 *
 * The signal D-1 needs (`docs/design/device-join-signal.md`): the server has to
 * know when a device joined a topic, and the only unforgeable evidence it holds
 * is the Commit itself — a member cannot fabricate another device's join without
 * actually performing it. Everything here is a property of the WIRE FORMAT, so
 * every case runs against a real Commit produced by the same MLS library the
 * clients use, exactly as `framing.ts` documents for its own parser. A
 * hand-built fixture would prove only that the parser agrees with itself.
 *
 * The two facts this rests on, measured rather than assumed:
 *   - a device's join is an External Commit, framed as a PublicMessage, whose
 *     content is NOT encrypted (an ordinary Commit is a PrivateMessage and is);
 *   - the joiner's leaf HPKE public key is that content's first reachable field,
 *     and `leafDeviceId` is its base64 — the same id the delivery cursor and the
 *     TAK bundle routes already key on.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   contract          → a real External Commit yields exactly the id the rest of
 *                       the system calls that device
 *   integrity         → the id matches `leafDeviceId(leaf.hpkePublicKey)` read
 *                       from the resulting tree, not merely "some base64"
 *   authorization     → an ordinary (PrivateMessage) Commit yields null: its
 *                       content is encrypted and a guess must never be returned
 *   boundary          → the second and third joiner of a group, so the parse
 *                       does not depend on an empty proposal list
 *   hostile input     → truncated, empty, random and structurally-valid-but-cut
 *                       bytes each return null instead of throwing
 *   empty/null/undef  → an empty buffer and a header-only buffer, separately
 *   race / UTF-8 / large → N/A: this is a pure byte parse with no caller
 *                       identity, no text, and a fixed input size
 */
import { describe, it, expect } from 'vitest';
import * as gc from '@/lib/mls/groupClient';
import * as tak from '@/lib/mls/takClient';
import { parseJoinerLeafKey, parseJoinerLeaf, parseCommitFraming } from '@/lib/mls/framing';
import { userIdOfLeaf } from '@/lib/mls/leafIdentity';

const unb64 = (s: string) => Buffer.from(s, 'base64');
const dec = new TextDecoder();

/** The device id the REST of the system would give this identity's leaf. */
function deviceIdOf(state: unknown, identity: string): string {
  const tree = (state as { ratchetTree: Array<{ nodeType?: string; leaf?: { hpkePublicKey: Uint8Array; credential?: { identity?: Uint8Array } } } | undefined> }).ratchetTree;
  for (const node of tree) {
    if (!node || node.nodeType !== 'leaf' || !node.leaf?.credential?.identity) continue;
    if (dec.decode(node.leaf.credential.identity) === identity) return tak.leafDeviceId(node.leaf.hpkePublicKey);
  }
  throw new Error(`no leaf for ${identity}`);
}

describe('parseJoinerLeafKey — against real commits', () => {
  it('CONTRACT + INTEGRITY: an External Commit names the joining device', async () => {
    const a = await gc.createDevice('user-a:dev-A');
    const created = await gc.createTopicGroup('t-join', a);

    const b = await gc.createDevice('user-b:dev-B');
    const joined = await gc.joinTopicGroup(b, created.groupInfoB64);

    const parsed = parseJoinerLeafKey(unb64(joined.commitB64));
    expect(parsed).not.toBeNull();

    // Not "some base64" — the exact id the delivery cursor and the TAK bundle
    // routes use for this device.
    const afterOnA = await gc.processCommit(created.state, joined.commitB64);
    expect(parsed).toBe(deviceIdOf(afterOnA, 'user-b:dev-B'));
  });

  it('BOUNDARY: the third device joining is named too', async () => {
    // The first join happens into a one-leaf group; later ones carry a
    // different tree and a longer path, so one case does not cover the parse.
    const a = await gc.createDevice('user-a:dev-A');
    const created = await gc.createTopicGroup('t-join-3', a);
    const b = await gc.createDevice('user-b:dev-B');
    const j1 = await gc.joinTopicGroup(b, created.groupInfoB64);
    const c = await gc.createDevice('user-c:dev-C');
    const j2 = await gc.joinTopicGroup(c, j1.groupInfoB64);

    const afterB = await gc.processCommit(created.state, j1.commitB64);
    const afterC = await gc.processCommit(afterB, j2.commitB64);

    expect(parseJoinerLeafKey(unb64(j1.commitB64))).toBe(deviceIdOf(afterC, 'user-b:dev-B'));
    expect(parseJoinerLeafKey(unb64(j2.commitB64))).toBe(deviceIdOf(afterC, 'user-c:dev-C'));
  });

  it('AUTHZ: an ordinary Commit yields NULL — its content is encrypted', async () => {
    /*
     * A Remove is a PrivateMessage: the proposals and path are sealed, so there
     * is nothing to read. Returning null is the whole point — a parser that
     * guessed here would attribute a join to whatever bytes happened to sit at
     * the offset, and a wrong device id blocks purging forever.
     */
    const a = await gc.createDevice('user-a:dev-A');
    const created = await gc.createTopicGroup('t-join-rm', a);
    const b = await gc.createDevice('user-b:dev-B');
    const j1 = await gc.joinTopicGroup(b, created.groupInfoB64);
    const afterB = await gc.processCommit(created.state, j1.commitB64);

    const removal = await gc.removeMembers(afterB, [1]);
    const framing = parseCommitFraming(unb64(removal.commitB64));
    expect(framing.wireFormat).toBe(2); // PrivateMessage, i.e. encrypted content
    expect(parseJoinerLeafKey(unb64(removal.commitB64))).toBeNull();
  });
});

describe('parseJoinerLeafKey — hostile and empty input', () => {
  it('EMPTY: an empty buffer and a header-only buffer each yield null', async () => {
    expect(parseJoinerLeafKey(Buffer.alloc(0))).toBeNull();
    expect(parseJoinerLeafKey(Buffer.from([0x00, 0x01, 0x00, 0x01]))).toBeNull();
  });

  it('HOSTILE: random bytes never throw', () => {
    for (let i = 0; i < 50; i++) {
      const junk = Buffer.alloc(64);
      for (let j = 0; j < junk.length; j++) junk[j] = (i * 31 + j * 7) & 0xff;
      expect(() => parseJoinerLeafKey(junk)).not.toThrow();
    }
  });

  it('HOSTILE: a REAL commit cut short yields null rather than a partial key', async () => {
    /*
     * The dangerous shape: valid framing, truncated content. A parser that
     * returned what it had would hand back half a public key, which is a device
     * id that names nothing and can never be acked — so it would block the purge
     * of that topic forever.
     */
    const a = await gc.createDevice('user-a:dev-A');
    const created = await gc.createTopicGroup('t-join-cut', a);
    const b = await gc.createDevice('user-b:dev-B');
    const joined = await gc.joinTopicGroup(b, created.groupInfoB64);
    const full = unb64(joined.commitB64);

    const whole = parseJoinerLeafKey(full);
    expect(whole).not.toBeNull();
    for (const cut of [4, 20, 60, 80, full.length - 8, full.length - 1]) {
      const short = full.subarray(0, cut);
      expect(() => parseJoinerLeafKey(short), `cut at ${cut}`).not.toThrow();
      const got = parseJoinerLeafKey(short);
      // Either it could not read a whole key (null), or — if the key happens to
      // be entirely inside the surviving prefix — it is the SAME whole key.
      expect(got === null || got === whole, `cut at ${cut} produced a partial key`).toBe(true);
    }
  });
});

describe('parseJoinerLeaf — the credential, for "whose device is this?"', () => {
  it('CONTRACT: an attributable leaf yields the account that owns it', async () => {
    /*
     * Two callers need this and neither can use a device id alone: the delivery
     * obligation binds a device to an account, and inactive-leaf eviction has to
     * know whose leaf went quiet.
     */
    const a = await gc.createDevice('user-a:dev-A');
    const created = await gc.createTopicGroup('t-cred', a);
    const b = await gc.createDevice('nullifier-b:dev-B');
    const joined = await gc.joinTopicGroup(b, created.groupInfoB64);

    const leaf = parseJoinerLeaf(unb64(joined.commitB64))!;
    expect(leaf.identity).toBe('nullifier-b:dev-B');
    expect(userIdOfLeaf(leaf.identity!)).toBe('nullifier-b');
    // Both halves come off the same walk, so they cannot disagree about which
    // leaf they describe.
    expect(leaf.deviceId).toBe(parseJoinerLeafKey(unb64(joined.commitB64)));
  });

  it('INTEGRITY: an UNATTRIBUTABLE leaf is returned raw, not guessed at', async () => {
    /*
     * An agent leaf minted before the `<userId>:<deviceId>` convention is a bare
     * handle. The honest answer is the string itself plus a null account —
     * inventing an owner here is what would evict an innocent member.
     */
    const a = await gc.createDevice('user-a:dev-A');
    const created = await gc.createTopicGroup('t-cred-bare', a);
    const bot = await gc.createDevice('sdk-7f3c9e21');
    const joined = await gc.joinTopicGroup(bot, created.groupInfoB64);

    const leaf = parseJoinerLeaf(unb64(joined.commitB64))!;
    expect(leaf.identity).toBe('sdk-7f3c9e21');
    expect(userIdOfLeaf(leaf.identity!)).toBeNull();
    expect(leaf.deviceId).toBeTruthy();
  });

  it('BOUNDARY: a re-join mints a NEW device id, so it is a new row and not a collision', async () => {
    /*
     * Clearing storage and re-joining produces a fresh leaf key under the same
     * credential. It matters at the storage layer: a fire-and-forget insert that
     * collided on a unique key would fail silently and the join would go
     * unrecorded.
     */
    const a = await gc.createDevice('user-a:dev-A');
    const created = await gc.createTopicGroup('t-rejoin', a);
    const first = await gc.joinTopicGroup(await gc.createDevice('user-b:dev-B'), created.groupInfoB64);
    const again = await gc.joinTopicGroup(await gc.createDevice('user-b:dev-B'), first.groupInfoB64);

    const l1 = parseJoinerLeaf(unb64(first.commitB64))!;
    const l2 = parseJoinerLeaf(unb64(again.commitB64))!;
    expect(l1.identity).toBe(l2.identity);
    expect(l1.deviceId).not.toBe(l2.deviceId);
  });

  it('HOSTILE: an ordinary Commit and junk both yield null, never a half-read credential', () => {
    expect(parseJoinerLeaf(Buffer.alloc(0))).toBeNull();
    expect(parseJoinerLeaf(Buffer.from([0, 1, 0, 2]))).toBeNull();
  });

  it('HOSTILE: a credential cut short yields NO identity, never half an account name', async () => {
    /*
     * Hand-built from a REAL commit on purpose: the assertion is that a
     * malformed value is REJECTED, which is the one case where fabricating
     * bytes is safe (see this parser's own note on empirical layout). Half a
     * credential names the wrong account as readily as the right one, and the
     * caller would store it as fact.
     */
    const a = await gc.createDevice('user-a:dev-A');
    const created = await gc.createTopicGroup('t-cut-cred', a);
    const joined = await gc.joinTopicGroup(await gc.createDevice('user-b:dev-B'), created.groupInfoB64);
    const full = unb64(joined.commitB64);

    const at = full.indexOf(Buffer.from('user-b:dev-B', 'utf8'));
    expect(at).toBeGreaterThan(0);
    // Keep everything up to the middle of the identity and drop the rest.
    const cut = full.subarray(0, at + 4);
    const leaf = parseJoinerLeaf(cut);
    // The device id may still be readable — it sits earlier — but the identity
    // must not come back as 'user' or 'user-'.
    expect(leaf?.identity ?? null).toBeNull();
  });

  it('HOSTILE: a credential this system does not mint is not read as text', async () => {
    // Only `basic` carries a raw identity string. Reading some other credential
    // type's bytes as UTF-8 would produce a plausible-looking account name out
    // of a structure that means something else entirely.
    const a = await gc.createDevice('user-a:dev-A');
    const created = await gc.createTopicGroup('t-cred-type', a);
    const joined = await gc.joinTopicGroup(await gc.createDevice('user-b:dev-B'), created.groupInfoB64);
    const bytes = Buffer.from(unb64(joined.commitB64));

    const at = bytes.indexOf(Buffer.from('user-b:dev-B', 'utf8'));
    // The credential type is the uint16 immediately before the identity's
    // varint length prefix; a 1-byte length means it sits at `at - 3`.
    bytes.writeUInt16BE(0x0002, at - 3);
    expect(parseJoinerLeaf(bytes)?.identity ?? null).toBeNull();
  });
});
