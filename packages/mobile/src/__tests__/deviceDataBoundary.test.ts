/**
 * The line between "clear the cache" and "erase this device", checked against
 * the keys the app ACTUALLY writes — not against a list retyped into a test.
 *
 * WHY THAT DISTINCTION IS THE POINT OF THIS FILE. A test that asserts
 * `keyVerdict('mls.msg.t.m', 'cache') === 'erase'` proves the function agrees
 * with the string in the test, and nothing else. The failure this guards
 * against is a RENAME: `chatListCache` changing its key, `mlsSession` changing
 * its prefix, `takSession` adding a family. In every one of those cases the
 * hand-written test still passes and the shipped feature deletes the wrong
 * thing — or, worse, silently stops deleting and starts protecting nothing.
 *
 * So the keys come from three places, in descending order of trust:
 *
 *   1. BEHAVIOUR — `chatListCache` and `chatHistoryCache` are called against a
 *      recording store and asked what keys they wrote. A rename breaks this
 *      test the moment it happens.
 *   2. EXPORTED CONSTANTS — `RECOVERY_SHOWN_KEY`, `INSTALL_DEVICE_ID_KEY`,
 *      `DEVICE_KEY_STORE_KEY`. Same guarantee, without needing to run anything.
 *   3. SOURCE SCAN — `mlsSession` and `takSession` build their keys inside
 *      private methods with no reachable seam, so their template literals are
 *      read out of the source. COMMENTS ARE STRIPPED FIRST: this very file's
 *      subject matter is discussed at length in the comments of those modules,
 *      and a scan that counted prose would pass whether or not the code was
 *      still there.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → every key family the app writes has a verdict under both scopes
 *   integrity  → the protected families survive a cache clear, and survive it
 *                after N repeats (the cumulative axis)
 *   integrity  → `device` erases a strict superset of what `cache` erases
 *   hostile    → keys crafted to look like a cache family but sit inside a
 *                protected one (`mls.state.<identity containing 'msg'>`), and
 *                near-misses (`mls.msgs.`, `mls.msg` with no dot)
 *   boundary   → the shortest and longest plausible topic / message ids
 *   empty      → '', whitespace, and non-strings are each their own case
 *   UTF-8      → Korean, emoji and mixed-script topic ids round-trip
 *   authz      → host-owned keys (`openstoa.token.v1`) are never touched
 *   external   → a TAK manifest naming a key outside every family is dropped
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  KEY_FAMILY_IDS,
  keyFamilyId,
  keyVerdict,
  planKeys,
  secureEraseKeys,
  isMediaCacheFile,
  eraseConfirm,
  BACKUP_STALE_AFTER_MS,
} from '../lib/deviceData';
import { writeCachedChatList } from '../lib/chatListCache';
import { writeChatHistory } from '../../../mls/src/chatHistoryCache';
import { RECOVERY_SHOWN_KEY } from '../lib/firstRunRecovery';
import { INSTALL_DEVICE_ID_KEY } from '../lib/installDeviceId';
import { chatMediaCacheFilename, chatMediaCiphertextFilename } from '../../../mls/src/chatMedia';

// ---------------------------------------------------------------------------
// Key sources
// ---------------------------------------------------------------------------

/** A store that answers nothing and remembers every key it was written to. */
function recorder() {
  const keys: string[] = [];
  return {
    keys,
    getItem: async () => null,
    setItem: async (k: string) => void keys.push(k),
    // `chatHistoryCache` uses the `get`/`set` shape.
    get: async () => null,
    set: async (k: string) => void keys.push(k),
  };
}

/**
 * Source with comments removed.
 *
 * Both block and line comments go. The modules being scanned explain their own
 * key layout in prose that quotes the very literals being looked for, so a scan
 * over raw source can be satisfied by a paragraph and stay green after the code
 * it describes is deleted.
 */
function codeOf(relativePath: string): string {
  const raw = readFileSync(join(__dirname, relativePath), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MLS_SESSION = codeOf('../../../mls/src/mlsSession.ts');
const TAK_SESSION = codeOf('../../../mls/src/takSession.ts');
const CHAT_ROOM = codeOf('../screens/chat/ChatRoomScreen.tsx');

/**
 * `DEVICE_KEY_STORE_KEY`, read out of its module rather than imported.
 *
 * `crypto/deviceKey.ts` imports `react-native-quick-crypto`, a native module
 * with no JS fallback, so importing the constant would drag the whole native
 * surface into a node test. The regex is anchored on the export so it still
 * fails the moment the key is renamed — the anti-drift property is what this
 * constant is here for, and a hardcoded string would lose it.
 */
const DEVICE_KEY_STORE_KEY = (() => {
  const m = /export const DEVICE_KEY_STORE_KEY\s*=\s*'([^']+)'/.exec(
    codeOf('../crypto/deviceKey.ts'),
  );
  if (!m) throw new Error('DEVICE_KEY_STORE_KEY is no longer exported from crypto/deviceKey.ts');
  return m[1];
})();

describe('the key names this feature is built on still exist', () => {
  it('CONTRACT: mlsSession still keys plaintext under `mls.msg.` and state under `mls.state.`', () => {
    /*
     * If either of these fails, the answer is NOT to update the string here.
     * It is that `deviceData.FAMILIES` is now wrong, and until it is fixed a
     * cache clear either misses the plaintext or reaches the group state.
     */
    expect(MLS_SESSION).toContain('`mls.msg.${topicId}.${msgId}`');
    expect(MLS_SESSION).toContain('`mls.state.${this.identity}.${topicId}`');
    expect(MLS_SESSION).toContain("'mls.identity'");
  });

  it('CONTRACT: the comment strip is real — the scan cannot be satisfied by prose', () => {
    /*
     * The guard on the guard. `mlsSession`'s header discusses these key shapes,
     * so if `codeOf` ever stopped stripping, the assertions above would pass on
     * documentation alone.
     */
    const raw = readFileSync(join(__dirname, '../../../mls/src/mlsSession.ts'), 'utf8');
    expect(raw.length).toBeGreaterThan(MLS_SESSION.length);
    expect(MLS_SESSION).not.toContain('deliberately: it is a memo over the durable cache');
  });

  it('CONTRACT: takSession still keys roots, orphans and epochs under `tak.`', () => {
    expect(TAK_SESSION).toContain('`tak.root.${t}`');
    expect(TAK_SESSION).toContain('`tak.root.orphan.${t}`');
    expect(TAK_SESSION).toContain('`tak.epoch.${t}.${e}`');
    expect(TAK_SESSION).toContain("'tak.manifest'");
  });

  it('AUTHZ: a full erase takes the mini-app\u2019s own unsent-message rows', () => {
    /*
     * NAMED, not inferred from the family list.
     *
     * The completeness test above only walks the families that EXIST, so
     * deleting this one takes its check with it and every assertion still
     * passes \u2014 which is exactly what happened on 2026-08-27 while this file
     * was being written. The verdict has to be asserted on the key itself.
     *
     * The key\u2019s own NAME is a room id, so a row left behind says which rooms
     * this person was in, on a phone that was just told everything was wiped.
     * Three of them were still there after a full erase on a real device.
     */
    expect(keyVerdict('openstoa.failedSend.864adcce-25b3-4d08-8c42-ee3d32ba0b95', 'device'))
      .toBe('erase');
    // ...and a cache clear must not touch it: an unsent message is not a copy
    // of anything, and re-fetching cannot bring it back.
    expect(keyVerdict('openstoa.failedSend.864adcce-25b3-4d08-8c42-ee3d32ba0b95', 'cache'))
      .toBe('keep');
    expect(keyFamilyId('openstoa.failedSend.t1')).toBe('failed-send');
  });

  it('CONTRACT: the room still files unsent messages under `openstoa.failedSend.`', () => {
    /*
     * The probe below is a literal, so on its own it would keep passing after
     * the room renamed its key: the family would go on matching a shape
     * nothing writes any more, and the real rows would quietly go back to
     * surviving a full erase. This reads the room itself.
     */
    expect(CHAT_ROOM).toContain('`openstoa.failedSend.${topicId}`');
  });

  it('CONTRACT: every family id is reachable, so none was added without a verdict', () => {
    const probes = [
      'mls.identity',
      'mls.state.mobile-aa.t1',
      'tak.root.t1',
      'openstoa.masterKey.v1',
      DEVICE_KEY_STORE_KEY,
      INSTALL_DEVICE_ID_KEY,
      RECOVERY_SHOWN_KEY,
      'mls.msg.t1.m1',
      'openstoa.chatList.v1.u1',
      'chatHistory/v1/u1/t1',
      'openstoa.failedSend.t1',
    ];
    const seen = new Set(probes.map(keyFamilyId));
    for (const id of KEY_FAMILY_IDS) expect(seen).toContain(id);
  });
});

describe('the cache boundary', () => {
  it('INTEGRITY: the real chat-list key is a cache', async () => {
    const store = recorder();
    await writeCachedChatList(store, 'user-1', [{ id: 't1' }]);

    expect(store.keys.length).toBe(1);
    for (const k of store.keys) {
      expect(keyVerdict(k, 'cache')).toBe('erase');
      expect(keyVerdict(k, 'device')).toBe('erase');
    }
  });

  it('INTEGRITY: the real chat-history keys — rooms AND the index — are caches', async () => {
    const store = recorder();
    await writeChatHistory(
      store,
      'user-1',
      't1',
      // Typed, not `as never`: the compiler is part of the anti-drift guard.
      // A field rename in `CachedChatMessage` should break this file too.
      [{ id: 'm1', createdAt: '2026-01-01T00:00:00.000Z', plaintext: 'hi' }],
      null,
    );

    /*
     * Both the room record and the eviction index must go. An index left
     * pointing at rooms that were deleted budgets against bytes that are not
     * there.
     */
    expect(store.keys.length).toBeGreaterThanOrEqual(2);
    for (const k of store.keys) expect(keyVerdict(k, 'cache')).toBe('erase');
  });

  it('INTEGRITY: `mls.` is NOT the prefix — only `mls.msg.` is', () => {
    expect(keyVerdict('mls.msg.t1.m1', 'cache')).toBe('erase');
    expect(keyVerdict('mls.identity', 'cache')).toBe('keep');
    expect(keyVerdict('mls.state.mobile-aa.t1', 'cache')).toBe('keep');
  });

  it('HOSTILE: an identity containing "msg" does not make its group state a cache', () => {
    /*
     * The identity is `<userId>:<deviceId>` and neither half is constrained to
     * avoid the substring. A naive `key.includes('msg')` deletes this room's
     * history.
     */
    expect(keyVerdict('mls.state.user-msg:dev-1.t1', 'cache')).toBe('keep');
    expect(keyVerdict('mls.state.mls.msg.weird.t1', 'cache')).toBe('keep');
  });

  it('HOSTILE: near-misses on the cache prefix are kept, not guessed at', () => {
    for (const k of ['mls.msg', 'mls.msgs.t1.m1', 'mls.message.t1', 'xmls.msg.t1.m1']) {
      expect(keyVerdict(k, 'cache')).toBe('keep');
      expect(keyVerdict(k, 'device')).toBe('keep');
    }
  });

  it('AUTHZ: the host’s own keys are never touched under either scope', () => {
    /*
     * `localStore` is the WALLET APP's AsyncStorage. These rows are the host's
     * OpenStoa auth cache; signing out is `logoutFromOpenStoa`'s job, and a
     * wallet key that happened to sit here must survive an erase of a mini-app.
     */
    for (const k of [
      'openstoa.token.v1',
      'openstoa.userId.v1',
      'openstoa.nickname.v1',
      'openstoa.expiresAt.v1',
      'openstoa.loggedOut.v1',
      'openstoa.push.handle.v1',
      'openstoa.language',
      'privy:session',
      'walletconnect@2:core',
    ]) {
      expect(keyVerdict(k, 'cache')).toBe('keep');
      expect(keyVerdict(k, 'device')).toBe('keep');
    }
  });

  it('INTEGRITY: `device` erases a strict superset of `cache`', () => {
    const universe = [
      'mls.identity',
      'mls.state.mobile-aa.t1',
      'tak.root.t1',
      'tak.root.orphan.t1',
      'tak.epoch.t1.4',
      'tak.manifest',
      'openstoa.masterKey.v1',
      'openstoa.masterKey.retired.v1',
      DEVICE_KEY_STORE_KEY,
      INSTALL_DEVICE_ID_KEY,
      RECOVERY_SHOWN_KEY,
      'mls.msg.t1.m1',
      'openstoa.chatList.v1.u1',
      'chatHistory/v1/u1/t1',
      'openstoa.failedSend.t1',
      'chatHistory/v1/index/u1',
      'openstoa.token.v1',
    ];
    const cache = new Set(planKeys(universe, 'cache').erase);
    const device = new Set(planKeys(universe, 'device').erase);

    for (const k of cache) expect(device).toContain(k);
    expect(device.size).toBeGreaterThan(cache.size);
  });

  it('EMPTY: empty, whitespace and non-strings are each kept, separately', () => {
    expect(keyVerdict('', 'device')).toBe('keep');
    expect(keyVerdict('   ', 'device')).toBe('keep');
    expect(keyVerdict('\n', 'device')).toBe('keep');
    expect(keyVerdict(null as unknown as string, 'device')).toBe('keep');
    expect(keyVerdict(undefined as unknown as string, 'device')).toBe('keep');
    expect(keyVerdict(42 as unknown as string, 'device')).toBe('keep');
    expect(keyVerdict({} as unknown as string, 'device')).toBe('keep');
  });

  it('UTF-8: Korean, emoji and mixed-script ids classify like any other', () => {
    for (const id of ['한국어방', '🔑🚪', 'mix한글emoji🙂', 'ко-ru-t1']) {
      expect(keyVerdict(`mls.msg.${id}.m1`, 'cache')).toBe('erase');
      expect(keyVerdict(`mls.state.mobile-aa.${id}`, 'cache')).toBe('keep');
      expect(keyVerdict(`tak.root.${id}`, 'cache')).toBe('keep');
    }
  });

  it('BOUNDARY: a one-character id and a very long one behave the same', () => {
    expect(keyVerdict('mls.msg.a.b', 'cache')).toBe('erase');
    const long = 'x'.repeat(4096);
    expect(keyVerdict(`mls.msg.${long}.${long}`, 'cache')).toBe('erase');
    expect(keyVerdict(`mls.state.mobile-aa.${long}`, 'cache')).toBe('keep');
  });

  it('CUMULATIVE: N clears in a row keep the protected set intact and whole', () => {
    /*
     * THE AXIS THAT CATCHES WHAT ONE PASS DOES NOT. A boundary that leaks
     * gradually — because a plan is computed from the previous plan's output,
     * or because a family is dropped once it stops appearing — looks correct on
     * the first clear. This runs the same store through twenty of them and
     * asserts the protected set is byte-identical at the end.
     */
    const protectedKeys = [
      'mls.identity',
      'mls.state.mobile-aa.t1',
      'mls.state.mobile-aa.t2',
      'tak.root.t1',
      'tak.root.orphan.t1',
      'tak.epoch.t1.7',
      'tak.manifest',
      'openstoa.masterKey.v1',
      'openstoa.masterKey.retired.v1',
      DEVICE_KEY_STORE_KEY,
      INSTALL_DEVICE_ID_KEY,
      // An unsent message must survive any number of cache clears — losing it
      // is the one outcome the store exists to prevent.
      'openstoa.failedSend.t1',
    ];
    let store = [
      ...protectedKeys,
      'mls.msg.t1.m1',
      'openstoa.chatList.v1.u1',
      'chatHistory/v1/u1/t1',
    ];

    for (let round = 0; round < 20; round++) {
      const { erase, keep } = planKeys(store, 'cache');
      store = keep;
      // Every round after the first has nothing left to delete, which is
      // itself the assertion: a clear must be idempotent.
      if (round > 0) expect(erase).toEqual([]);
      expect(store).toEqual(protectedKeys);
    }
  });
});

describe('naming the secure keys a full erase must remove', () => {
  const IDENTITY = 'user-1:dev-1';

  it('CONTRACT: orphan roots are included even though the manifest never lists them', () => {
    /*
     * `takSession.orphanRootKey` is written deliberately outside the manifest so
     * it can never reach the server backup. A wipe driven by the manifest alone
     * therefore leaves the one key family that no backup could have replaced.
     */
    const keys = secureEraseKeys({ identity: IDENTITY, topicIds: ['t1', 't2'], takKeys: [] });
    expect(keys).toContain('tak.root.orphan.t1');
    expect(keys).toContain('tak.root.orphan.t2');
  });

  it('CONTRACT: the fixed keys, the group states and the manifest keys are all named', () => {
    const keys = secureEraseKeys({
      identity: IDENTITY,
      topicIds: ['t1'],
      takKeys: ['tak.root.t1', 'tak.epoch.t1.0', 'tak.epoch.t1.1'],
    });
    for (const expected of [
      'mls.identity',
      'openstoa.masterKey.v1',
      'openstoa.masterKey.retired.v1',
      DEVICE_KEY_STORE_KEY,
      INSTALL_DEVICE_ID_KEY,
      RECOVERY_SHOWN_KEY,
      'tak.manifest',
      'tak.root.t1',
      'tak.epoch.t1.0',
      'tak.epoch.t1.1',
      `mls.state.${IDENTITY}.t1`,
    ]) {
      expect(keys).toContain(expected);
    }
  });

  it('INTEGRITY: every named key passes the same verdict everything else passes', () => {
    const keys = secureEraseKeys({
      identity: IDENTITY,
      topicIds: ['t1', '한국어', '🔑'],
      takKeys: ['tak.root.t1'],
    });
    for (const k of keys) expect(keyVerdict(k, 'device')).toBe('erase');
    expect(new Set(keys).size).toBe(keys.length); // no duplicates
  });

  it('EXTERNAL: a manifest naming something outside every family is dropped, not obeyed', () => {
    /*
     * The manifest is JSON written by another module and read back. If it ever
     * carried a foreign key — corruption, a future family, a bug — this is the
     * one code path that would delete an unrecognised entry from the host's
     * Keychain.
     */
    const keys = secureEraseKeys({
      identity: IDENTITY,
      topicIds: [],
      takKeys: ['openstoa.token.v1', 'privy:session', '', 'tak.root.t9'],
    });
    expect(keys).not.toContain('openstoa.token.v1');
    expect(keys).not.toContain('privy:session');
    expect(keys).not.toContain('');
    expect(keys).toContain('tak.root.t9');
  });

  it('EMPTY: no identity means no group-state keys, and nothing else is lost', () => {
    const keys = secureEraseKeys({ identity: null, topicIds: ['t1'], takKeys: [] });
    expect(keys.some((k) => k.startsWith('mls.state.'))).toBe(false);
    expect(keys).toContain('mls.identity');
    expect(keys).toContain('tak.root.orphan.t1');

    // '' is a distinct case from null and must behave the same.
    const blank = secureEraseKeys({ identity: '', topicIds: ['t1'], takKeys: [] });
    expect(blank.some((k) => k.startsWith('mls.state.'))).toBe(false);
  });

  it('EMPTY: no topics at all still erases the fixed keys', () => {
    const keys = secureEraseKeys({ identity: IDENTITY, topicIds: [], takKeys: [] });
    expect(keys).toContain('openstoa.masterKey.v1');
    expect(keys.length).toBeGreaterThan(0);
  });

  it('BOUNDARY: many topics produce one state key and two root keys each', () => {
    const topicIds = Array.from({ length: 200 }, (_, i) => `t${i}`);
    const keys = secureEraseKeys({ identity: IDENTITY, topicIds, takKeys: [] });
    expect(keys.filter((k) => k.startsWith('mls.state.')).length).toBe(200);
    expect(keys.filter((k) => k.startsWith('tak.root.orphan.')).length).toBe(200);
  });

  it('HOSTILE: junk topic ids are skipped rather than turned into keys', () => {
    const keys = secureEraseKeys({
      identity: IDENTITY,
      topicIds: ['', null as unknown as string, undefined as unknown as string, 'ok'],
      takKeys: [],
    });
    expect(keys).toContain(`mls.state.${IDENTITY}.ok`);
    expect(keys).not.toContain(`mls.state.${IDENTITY}.`);
    expect(keys).not.toContain(`mls.state.${IDENTITY}.null`);
    expect(keys).not.toContain(`mls.state.${IDENTITY}.undefined`);
  });
});

describe('cached media files', () => {
  it('CONTRACT: both real filenames match, built by the module that names them', () => {
    expect(isMediaCacheFile(chatMediaCiphertextFilename('a'.repeat(32)))).toBe(true);
    expect(isMediaCacheFile(chatMediaCacheFilename('image/jpeg', 'a'.repeat(32)))).toBe(true);
  });

  it('AUTHZ: files the host put in the shared cache directory are left alone', () => {
    for (const name of ['RCTAsyncLocalStorage', 'com.apple.nsurlsessiond', 'snapshot.png', '.DS_Store']) {
      expect(isMediaCacheFile(name)).toBe(false);
    }
  });

  it('EMPTY: empty and non-string names are not files of ours', () => {
    expect(isMediaCacheFile('')).toBe(false);
    expect(isMediaCacheFile(null as unknown as string)).toBe(false);
    expect(isMediaCacheFile(undefined as unknown as string)).toBe(false);
  });
});

describe('what to ask before erasing', () => {
  const NOW = 1_800_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  it('CONTRACT: a cache clear is never gated', () => {
    const c = eraseConfirm('cache', null, NOW);
    expect(c.requiresSecondConfirm).toBe(false);
    expect(c.standing).toBeNull();
  });

  it('INTEGRITY: no backup demands the second confirmation', () => {
    const c = eraseConfirm('device', { hasBackup: false, backupUpdatedAt: null }, NOW);
    expect(c.standing).toBe('none');
    expect(c.requiresSecondConfirm).toBe(true);
  });

  it('INTEGRITY: a backup means one confirmation, not two', () => {
    const c = eraseConfirm('device', { hasBackup: true, backupUpdatedAt: NOW - DAY }, NOW);
    expect(c.standing).toBe('fresh');
    expect(c.requiresSecondConfirm).toBe(false);
  });

  it('EXTERNAL: facts we could not fetch are treated as no backup, not as a backup', () => {
    /*
     * The session request can fail — offline, expired token. "We do not know"
     * must resolve to the cautious answer; the other direction would let
     * someone erase their only copy on one tap because a request timed out.
     */
    for (const unknown of [null, undefined]) {
      const c = eraseConfirm('device', unknown, NOW);
      expect(c.standing).toBe('none');
      expect(c.requiresSecondConfirm).toBe(true);
    }
  });

  it('BOUNDARY: the stale window is exact on both sides', () => {
    const at = eraseConfirm('device', { hasBackup: true, backupUpdatedAt: NOW - BACKUP_STALE_AFTER_MS }, NOW);
    const past = eraseConfirm(
      'device',
      { hasBackup: true, backupUpdatedAt: NOW - BACKUP_STALE_AFTER_MS - 1 },
      NOW,
    );
    expect(at.standing).toBe('fresh');
    expect(past.standing).toBe('stale');
    expect(past.bodyValues.days).toBe(30);
  });

  it('HOSTILE: a backup timestamp in the future is never called fresh', () => {
    /*
     * Clock skew, or a phone set wrong. A negative age would otherwise compute
     * as "made moments ago" — the one answer that must never be given by
     * mistake, because it is the one that skips the warning.
     */
    for (const ts of [NOW + DAY, Number.NaN, Number.POSITIVE_INFINITY]) {
      const c = eraseConfirm('device', { hasBackup: true, backupUpdatedAt: ts }, NOW);
      expect(c.standing).not.toBe('fresh');
    }
  });

  it('HOSTILE: hasBackup true with no timestamp is treated as no backup', () => {
    const c = eraseConfirm('device', { hasBackup: true, backupUpdatedAt: null }, NOW);
    expect(c.standing).toBe('none');
    expect(c.requiresSecondConfirm).toBe(true);
  });

  it('CONTRACT: every branch names i18n keys, never rendered text', () => {
    for (const c of [
      eraseConfirm('cache', null, NOW),
      eraseConfirm('device', { hasBackup: false, backupUpdatedAt: null }, NOW),
      eraseConfirm('device', { hasBackup: true, backupUpdatedAt: NOW - 90 * DAY }, NOW),
      eraseConfirm('device', { hasBackup: true, backupUpdatedAt: NOW }, NOW),
    ]) {
      expect(c.titleKey.startsWith('openstoa.deviceData.')).toBe(true);
      expect(c.bodyKey.startsWith('openstoa.deviceData.')).toBe(true);
    }
  });
});
