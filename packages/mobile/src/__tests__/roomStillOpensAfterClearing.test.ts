/*
 * What a cache clear keeps — measured by decrypting, not by checking that some
 * strings are still in a store.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE OTHER TWO. `deviceDataErase.test.ts`
 * proves the protected keys are byte-identical after twenty clears, and
 * `deviceDataBoundary.test.ts` proves the prefixes it protects are the ones
 * `mlsSession` actually writes. Both are true, and together they still do not
 * say the room WORKS afterwards. They compare names; this exercises the crypto.
 *
 * THE THREE LAYERS, because getting them confused wasted an hour on 2026-08-26:
 *
 *   MLS application message  opened exactly ONCE — the per-message key is
 *                            destroyed on decryption (forward secrecy), and a
 *                            sender can never open its own message at all
 *   mls.msg.<topic>.<id>     where that one opening was kept. A CACHE
 *   TAK archive              `archiveOnSend` re-encrypts the sent body under the
 *                            topic key and uploads it; `backfill` brings it back
 *                            on room entry. `tak.*` is protected from the clear,
 *                            so this is what makes `mls.msg.` re-derivable
 *
 * A session built WITHOUT the archive (as the cases below are) cannot get a sent
 * message back — which is a fact about the archive's job, NOT about the clear
 * being destructive. I read it as "the clear destroys history" and wrote that
 * down; it was wrong, and the archive path is `ChatRoomScreen.tsx:1948` /
 * `:1392`. Recorded so the next reader does not repeat it.
 *
 * THE AXIS IS ACCUMULATION. One clear proves the call did not crash. Twenty
 * clears with new cache written between them is what a phone looks like after a
 * month of somebody tapping the button.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   integrity → the ROOM keeps working: sealing after N clears still succeeds
 *   integrity → the MLS state and identity are byte-identical after N clears
 *   contract  → the plaintext store really is emptied (or every other case here
 *               is vacuous: a clear that removed nothing would also "still work")
 *   integrity → a session with NO archive cannot re-derive a sent message, which
 *               pins down what `archiveOnSend` is responsible for
 *   boundary  → clearing an untouched store is a no-op, not a failure
 */
import { describe, it, expect } from 'vitest';

import { eraseDeviceData } from '../lib/deviceDataErase';
import { MlsSessionStore } from '../../../mls/src/mlsSession';

/*
 * The MLS stack is exercised for real; only the SERVER is faked. A mocked
 * `seal`/`open` pair would make this file a tautology — it would prove that a
 * stub returns what it was told to return.
 */
/** A key-value store that also reports its keys, the way the host's does. */
function store(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => void map.set(k, v),
    removeItem: async (k: string) => void map.delete(k),
    getAllKeys: async () => [...map.keys()],
    // MlsSession's SecureKVStore shape.
    get: async (k: string) => map.get(k) ?? null,
    set: async (k: string, v: string) => void map.set(k, v),
  };
}

/**
 * A server that remembers one group.
 *
 * Enough for one device to create a group and talk to itself, which is exactly
 * the shape of the personal room — and of the case a person hits when they clear
 * the cache on the only phone they own.
 */
function fakeTransport() {
  let groupInfo: string | null = null;
  const commits: Array<{ epoch: number; commit: string }> = [];
  return {
    getGroupInfo: async () => groupInfo,
    postGroupInfo: async (_t: string, gi: string) => {
      if (groupInfo) return false;
      groupInfo = gi;
      return true;
    },
    postCommit: async (_t: string, commit: string, gi: string) => {
      groupInfo = gi;
      commits.push({ epoch: commits.length + 1, commit });
      return { ok: true, epoch: commits.length };
    },
    getCommitsSince: async (_t: string, since: number) =>
      commits.filter((c) => c.epoch > since).map((c) => ({ epoch: c.epoch, commit: c.commit })),
  };
}

/** A filesystem with no media in it — absent `fs` is reported as a gap. */
function fakeFs() {
  return { listCache: async () => [] as string[], deleteFile: async () => {} };
}

const TOPIC = 'topic-under-test';

/** Everything a clear is allowed to take: the message cache, nothing else. */
function writeCacheNoise(local: ReturnType<typeof store>, round: number): void {
  local.map.set(`mls.msg.${TOPIC}.noise-${round}`, 'stale plaintext');
  local.map.set(`openstoa.chatList.v1.${round}`, '[]');
  local.map.set(`chatHistory/v1/${TOPIC}/${round}`, '[]');
}

async function makeSession(secure: ReturnType<typeof store>, local: ReturnType<typeof store>) {
  const s = new MlsSessionStore(
    fakeTransport() as never,
    'user-1:dev-1',
    secure as never,
    local as never,
  );
  return s;
}

describe('what a cache clear keeps, and what it destroys', () => {
  it('INTEGRITY: the room keeps WORKING — sealing still succeeds after twenty clears', async () => {
    /*
     * The half that is genuinely safe. The group state lives in the secure store
     * and the clear does not reach it, so the room is not broken: new messages
     * seal and the conversation continues.
     */
    const secure = store();
    const local = store();
    const session = await makeSession(secure, local);

    for (let round = 0; round < 20; round++) {
      writeCacheNoise(local, round);
      const r = await eraseDeviceData(
        { local: local as never, secure: secure as never, fs: fakeFs() as never },
        'cache',
      );
      expect(r.gaps ?? []).toEqual([]);
    }

    const sealed = await session.seal(TOPIC, 'still able to speak');
    expect(sealed).toBeTruthy();
    expect(sealed.epoch).toBeGreaterThanOrEqual(0);
  });

  it('INTEGRITY: the MLS state and identity are byte-identical after twenty clears', async () => {
    /*
     * Compared by VALUE out of the secure store, not by a list of names, so a
     * clear that reached across stores is caught even if the prefixes still look
     * right.
     */
    const secure = store();
    const local = store();
    const session = await makeSession(secure, local);
    await session.seal(TOPIC, 'x');

    const snapshot = new Map(secure.map);
    expect(snapshot.size).toBeGreaterThan(0);

    for (let i = 0; i < 20; i++) {
      writeCacheNoise(local, i);
      await eraseDeviceData(
        { local: local as never, secure: secure as never, fs: fakeFs() as never },
        'cache',
      );
    }

    expect([...secure.map.entries()].sort()).toEqual([...snapshot.entries()].sort());
  });

  it('CONTRACT: the clear really did empty the plaintext store', async () => {
    /*
     * The guard on the guard. A clear that removed NOTHING would satisfy every
     * other case in this file — the room works because nothing was taken. This
     * is what separates "clearing is safe" from "clearing does not happen".
     */
    const secure = store();
    const local = store();
    const session = await makeSession(secure, local);
    await session.seal(TOPIC, 'kept');

    writeCacheNoise(local, 0);
    await session.cachePlaintext(TOPIC, 'msg-1', 'a decrypted line');
    expect([...local.map.keys()].filter((k) => k.startsWith('mls.msg.')).length).toBeGreaterThan(0);

    await eraseDeviceData(
      { local: local as never, secure: secure as never, fs: fakeFs() as never },
      'cache',
    );

    expect([...local.map.keys()].filter((k) => k.startsWith('mls.msg.'))).toEqual([]);
    expect([...local.map.keys()].filter((k) => k.startsWith('openstoa.chatList.v1.'))).toEqual([]);
  });

  it('INTEGRITY: without the archive, a sent message is not re-derivable — which is what the archive is FOR', async () => {
    /*
     * THE FINDING, asserted rather than described. An MLS sender cannot decrypt
     * its own application message — `cachePlaintext` exists precisely because of
     * that — so the plaintext store is the only copy there will ever be. Clearing
     * it is not "freeing re-fetchable data".
     *
     * The second store instance is an app restart: it drops the in-memory memo,
     * which is what makes the loss visible. Without that this reads as a pass.
     *
     * If this case ever starts returning the text again, the product decision
     * changed — do not "fix" the test.
     */
    const secure = store();
    const local = store();
    const session = await makeSession(secure, local);

    const sealed = await session.seal(TOPIC, 'a line the person wrote');
    await session.cachePlaintext(TOPIC, 'm1', 'a line the person wrote');
    expect(await session.openCached(TOPIC, 'm1', sealed)).toBe('a line the person wrote');

    await eraseDeviceData(
      { local: local as never, secure: secure as never, fs: fakeFs() as never },
      'cache',
    );

    const afterRestart = await makeSession(secure, local);
    expect(await afterRestart.openCached(TOPIC, 'm1', sealed)).toBeNull();
  });

  it('BOUNDARY: clearing a store with nothing to clear is a no-op, not a failure', async () => {
    const secure = store();
    const local = store();
    const session = await makeSession(secure, local);

    const r = await eraseDeviceData(
      { local: local as never, secure: secure as never, fs: fakeFs() as never },
      'cache',
    );
    expect(r.gaps ?? []).toEqual([]);
    expect(await session.seal(TOPIC, 'unaffected')).toBeTruthy();
  });
});
