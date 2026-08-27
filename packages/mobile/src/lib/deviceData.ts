/**
 * What "clear the cache" may touch, and what "erase this device" must touch.
 *
 * TWO ACTIONS THAT LOOK ALIKE AND ARE NOT. One frees space and costs a slow
 * reload; the other ends this device's ability to read anything it has ever
 * been sent. The distance between them is a single string prefix, and getting
 * that prefix wrong is not a bug that shows up in a crash report — it shows up
 * as a room that reopens empty, weeks later, with no way back.
 *
 * THE PREFIX. Three families live under `mls.`:
 *
 *     mls.identity                    this device's leaf. Losing it does not
 *                                     lose history directly; it mints a NEW
 *                                     leaf, which orphans every group state
 *                                     keyed under the old one and leaves a
 *                                     ghost leaf in every group.
 *     mls.state.<identity>.<topicId>  the group state. Losing it means
 *                                     re-joining, and a re-join starts at the
 *                                     current epoch — the room's history
 *                                     before that point is gone for this
 *                                     device.
 *     mls.msg.<topicId>.<msgId>       decrypted plaintext. Re-derivable: the
 *                                     ciphertext is on the server and the key
 *                                     to open it is in the archive keychain.
 *
 * Only the third is a cache. `store.startsWith('mls.')` erases all three, and
 * two of them are the thing the user was told they were keeping. So the match
 * here is on the FULL family prefix including its trailing dot, the protected
 * families are checked FIRST, and anything unrecognised is KEPT.
 *
 * DEFAULT-KEEP IS LOAD-BEARING, and for a second reason beyond caution: these
 * stores are the HOST's. `localStore` is the ZKProofport app's AsyncStorage and
 * `secureStore` is its Keychain — the host keeps its own OpenStoa auth cache
 * (`openstoa.token.v1`, `openstoa.loggedOut.v1`, …) in the same namespace, and
 * a wallet app's unrelated keys live there too. "Erase everything the mini-app
 * can see" would reach well past the mini-app. Signing out is the host's job
 * and is done through `logoutFromOpenStoa`, not by deleting its rows.
 *
 * PURE ON PURPOSE. Nothing here reads a store, draws anything, or knows what a
 * React component is. `deviceDataErase.ts` applies a decision; this file only
 * makes one, so the boundary can be tested without a device, a renderer, or a
 * store that might quietly answer null.
 */

import { backupStanding as standing } from './deviceTakeover';

/** Which of the two actions is being taken. */
export type EraseScope =
  /** Re-downloadable copies only. Everything sealed stays. */
  | 'cache'
  /** Everything this device holds for OpenStoa, keys included. Irreversible. */
  | 'device';

export type KeyVerdict = 'erase' | 'keep';

/**
 * One recognised family of keys, and what it costs to lose.
 *
 * `cache: true` means the value can be rebuilt from the server with the keys
 * this device keeps. Everything else is `cache: false` and survives a cache
 * clear no matter how large it is.
 */
interface Family {
  /** Matched with `startsWith`, INCLUDING any trailing separator. */
  prefix?: string;
  /** Matched with `===`. */
  exact?: string;
  cache: boolean;
  /** For diagnostics and for the report the screen shows. */
  id: string;
}

/*
 * Ordered most-specific-first, and the protected families lead.
 *
 * The ordering is belt and braces: the prefixes below are disjoint (a test
 * asserts it), so a later entry cannot shadow an earlier one — but if a future
 * family is added carelessly as a prefix of a protected one, the protected
 * answer is the one that wins.
 */
const FAMILIES: readonly Family[] = [
  // ── Never a cache. Losing any of these loses history. ────────────────────
  /** This device's MLS leaf credential. See `mlsSession.mintIdentity`. */
  { exact: 'mls.identity', cache: false, id: 'mls-identity' },
  /** Per-topic MLS group state. Re-joining without it drops the room's past. */
  { prefix: 'mls.state.', cache: false, id: 'mls-state' },
  /**
   * Archive keys: `tak.root.<t>`, `tak.root.orphan.<t>`, `tak.epoch.<t>.<n>`
   * and the `tak.manifest` that lists them. Without these the archive is
   * ciphertext forever — the server never had the keys.
   */
  { prefix: 'tak.', cache: false, id: 'tak' },
  /**
   * `openstoa.masterKey.v1` and `openstoa.masterKey.retired.v1`.
   *
   * The root of everything above. `EncryptingKVStore` reports a value it
   * cannot open as ABSENT, so deleting this does not read as an error — it
   * reads as an empty device, which is the failure mode hardest to notice and
   * impossible to undo.
   */
  { prefix: 'openstoa.masterKey.', cache: false, id: 'master-key' },
  /** The device signing key the server knows this install by. */
  { exact: 'openstoa.device.key.v1', cache: false, id: 'device-key' },
  /** The install id carried on every request as `x-openstoa-device-id`. */
  { exact: 'openstoa.device.id', cache: false, id: 'device-id' },
  /**
   * "This install has already been shown its recovery code."
   *
   * Not a cache, though it holds nothing secret: clearing it makes the app ask
   * again, and a duplicate prompt is noise. It goes only on a full erase, where
   * a fresh start is the whole point.
   */
  { exact: 'openstoa.recovery.shown.v1', cache: false, id: 'recovery-shown' },
  /*
   * Messages this device tried to send and could not, kept so a phone the OS
   * killed does not silently swallow what the person wrote. What is stored is
   * the SEALED body and an object key, never the plaintext or the picture.
   *
   * Not a cache: clearing the cache must not throw away an unsent message,
   * which is the one thing this file exists to prevent. A full erase does take
   * it — and it has to, because the KEY of each entry is a room id. Left
   * behind, they say which rooms this person was in, on a phone that was just
   * told everything was wiped.
   *
   * This is the mini-app's own row, not the host's. `openstoa.push.handle.v1`
   * and the session rows next to it live in the same store and look the same,
   * but the host writes those and `logoutFromOpenStoa` clears them — a
   * mini-app erase must not reach across that line.
   *
   * It was left behind. Seen on a device on 2026-08-27: three of these
   * survived `이 기기에서 완전히 지우기`, because an unrecognised key is kept
   * and nobody had ever recognised this one.
   */
  { prefix: 'openstoa.failedSend.', cache: false, id: 'failed-send' },


  // ── Caches. Deleting these costs a reload and nothing else. ──────────────
  /** Decrypted message plaintext. The ciphertext and its key both survive. */
  { prefix: 'mls.msg.', cache: true, id: 'message-plaintext' },
  /** Room list routing metadata — ids, titles, timestamps. No bodies. */
  { prefix: 'openstoa.chatList.v1.', cache: true, id: 'chat-list' },
  /**
   * Decrypted room history, plus the eviction index over it.
   *
   * The index MUST go with the rooms. An index left pointing at rooms that no
   * longer exist reports bytes that are not there and evicts against a budget
   * it is wrong about.
   */
  { prefix: 'chatHistory/v1/', cache: true, id: 'chat-history' },
];

/** The family `key` belongs to, or null when the mini-app does not own it. */
function familyOf(key: string): Family | null {
  if (typeof key !== 'string' || key === '') return null;
  for (const f of FAMILIES) {
    if (f.exact !== undefined && key === f.exact) return f;
    if (f.prefix !== undefined && key.startsWith(f.prefix)) return f;
  }
  return null;
}

/** Exposed for the disjointness test, and for reporting what was recognised. */
export function keyFamilyId(key: string): string | null {
  return familyOf(key)?.id ?? null;
}

/** Every family id, so a test can assert nothing was added without a verdict. */
export const KEY_FAMILY_IDS: readonly string[] = FAMILIES.map((f) => f.id);

/**
 * May this key be deleted under this scope?
 *
 * An unrecognised key is ALWAYS kept, under both scopes. The stores belong to
 * the host, not to us.
 */
export function keyVerdict(key: string, scope: EraseScope): KeyVerdict {
  const f = familyOf(key);
  if (!f) return 'keep';
  if (scope === 'device') return 'erase';
  return f.cache ? 'erase' : 'keep';
}

/** Split a store's keys into what goes and what stays. Order is preserved. */
export function planKeys(
  keys: readonly string[],
  scope: EraseScope,
): { erase: string[]; keep: string[] } {
  const erase: string[] = [];
  const keep: string[] = [];
  for (const k of keys) (keyVerdict(k, scope) === 'erase' ? erase : keep).push(k);
  return { erase, keep };
}

// ---------------------------------------------------------------------------
// The secure store cannot be enumerated
// ---------------------------------------------------------------------------

/**
 * Every secure-store key a full erase must remove, named explicitly.
 *
 * THE KEYCHAIN HAS NO `list`. iOS Keychain and Android Keystore cannot be
 * asked what is in them, which is why `takSession` keeps a `tak.manifest` at
 * all. So a full erase cannot sweep — it has to NAME each key, and a key it
 * cannot name survives the wipe.
 *
 * Three sources, and all three are needed:
 *   - fixed keys, which are the same on every device;
 *   - the TAK manifest, which lists the roots and epochs this device recorded;
 *   - the topic ids, which produce the group-state keys and the ORPHAN roots.
 *
 * ORPHAN ROOTS ARE THE ONE THAT BITES. `tak.root.orphan.<topicId>` is written
 * deliberately outside the manifest — it must never reach the server backup —
 * so a wipe driven by the manifest alone leaves the one key family that a
 * backup could never have replaced sitting on the device. It is derived here
 * from the topic ids instead, which is the same trick `diagnoseKeychain` uses
 * to find unlisted roots.
 *
 * `identity` may be null on a device that never joined anything. Group-state
 * keys are then simply not derivable, and there are none to derive.
 */
export function secureEraseKeys(ctx: {
  identity: string | null | undefined;
  topicIds: readonly string[];
  /** Key NAMES from `TakSessionStore.diagnoseKeychain` (manifest + unlisted). */
  takKeys?: readonly string[];
}): string[] {
  const out = new Set<string>([
    'mls.identity',
    'openstoa.masterKey.v1',
    'openstoa.masterKey.retired.v1',
    'openstoa.device.key.v1',
    'openstoa.device.id',
    'openstoa.recovery.shown.v1',
    'tak.manifest',
  ]);

  for (const k of ctx.takKeys ?? []) {
    if (typeof k === 'string' && k !== '') out.add(k);
  }

  const identity = typeof ctx.identity === 'string' && ctx.identity !== '' ? ctx.identity : null;
  for (const t of ctx.topicIds) {
    if (typeof t !== 'string' || t === '') continue;
    out.add(`tak.root.${t}`);
    out.add(`tak.root.orphan.${t}`);
    if (identity) out.add(`mls.state.${identity}.${t}`);
  }

  /*
   * Filtered through the same verdict everything else goes through.
   *
   * This is not defensive noise. `takKeys` comes from a manifest written by
   * another module, and the topic ids come from a cache and a server response.
   * If any of those ever produced a key outside the families above, this list
   * would be the one place that deleted an unrecognised key from the host's
   * Keychain — so it is held to the rule rather than trusted to follow it.
   */
  return [...out].filter((k) => keyVerdict(k, 'device') === 'erase');
}

// ---------------------------------------------------------------------------
// Cached media files
// ---------------------------------------------------------------------------

/**
 * Files this app parked in the OS cache directory.
 *
 * `chatMedia` names both of them from the media id and a fixed prefix —
 * `openstoa-<id>.enc` for the downloaded ciphertext and
 * `openstoa-view-<id>.<ext>` for the decrypted copy `<Image>` reads — so the
 * prefix is the whole test. Both are caches under either scope: the bytes are
 * on the server and the key to open them is in the archive keychain.
 *
 * The cache directory is SHARED with the host app, which is why this is a
 * prefix match and not "delete the directory".
 */
export const MEDIA_CACHE_PREFIX = 'openstoa-';

export function isMediaCacheFile(name: string): boolean {
  return typeof name === 'string' && name.startsWith(MEDIA_CACHE_PREFIX);
}

// ---------------------------------------------------------------------------
// What to ask before a full erase
// ---------------------------------------------------------------------------

/** What the server knows about this account's key backup. */
export interface BackupFacts {
  hasBackup: boolean;
  /** Epoch ms of the last backup, or null when there has never been one. */
  backupUpdatedAt: number | null;
}

export type BackupStanding =
  /** No backup on file. After a full erase, this device's rooms are unreadable. */
  | 'none'
  /** A backup exists but predates rooms joined since. */
  | 'stale'
  /** A recent backup exists. */
  | 'fresh';

/**
 * How old a backup may be before it stops being evidence about the rooms
 * someone is in now. Shared with the takeover warning — see
 * `deviceTakeover.BACKUP_STALE_AFTER_MS`, which this re-exports rather than
 * re-deciding, so the two screens can never disagree about the same backup.
 */
export { BACKUP_STALE_AFTER_MS, backupStanding } from './deviceTakeover';

/** The step a scope demands before anything is deleted. */
export interface EraseConfirm {
  scope: EraseScope;
  /**
   * A SECOND, separate confirmation, shown only when there is no backup at all.
   *
   * The first confirmation is about intent ("yes, erase"). This one is about a
   * fact the person cannot check from the phone in their hand: that nothing
   * outside this device can open these rooms again. One tap is the right cost
   * for a reversible action and the wrong cost for this one.
   */
  requiresSecondConfirm: boolean;
  /** i18n keys, so this stays free of anything renderable. */
  titleKey: string;
  bodyKey: string;
  bodyValues: Record<string, string | number>;
  /** Present only for a full erase; drives the tone of the sheet. */
  standing: BackupStanding | null;
}

/**
 * What to say, and how hard to make it, before erasing.
 *
 * `now` is a parameter so the stale boundary is testable without the clock.
 */
export function eraseConfirm(
  scope: EraseScope,
  backup: BackupFacts | null | undefined,
  now: number,
): EraseConfirm {
  if (scope === 'cache') {
    /*
     * No gate at all, deliberately. Everything this deletes comes back from the
     * server on the next read, so a confirmation that sounded ominous would
     * teach people to click through the one that is not.
     */
    return {
      scope,
      requiresSecondConfirm: false,
      titleKey: 'openstoa.deviceData.clearCache.confirmTitle',
      bodyKey: 'openstoa.deviceData.clearCache.confirmBody',
      bodyValues: {},
      standing: null,
    };
  }

  /*
   * A backup this device could not ASK about is treated as absent.
   *
   * The facts come from the session response. When it has not arrived — a cold
   * start with no network, a request that failed — the honest answer is "we do
   * not know", and the safe reading of "we do not know" is the one that warns.
   */
  const s = standing(backup ?? { hasBackup: false, backupUpdatedAt: null }, now);

  if (s === 'none') {
    return {
      scope,
      requiresSecondConfirm: true,
      titleKey: 'openstoa.deviceData.eraseDevice.noBackupTitle',
      bodyKey: 'openstoa.deviceData.eraseDevice.noBackupBody',
      bodyValues: {},
      standing: s,
    };
  }

  if (s === 'stale') {
    const age = now - (backup?.backupUpdatedAt ?? 0);
    return {
      scope,
      requiresSecondConfirm: false,
      titleKey: 'openstoa.deviceData.eraseDevice.staleBackupTitle',
      bodyKey: 'openstoa.deviceData.eraseDevice.staleBackupBody',
      bodyValues: { days: Math.max(0, Math.floor(age / (24 * 60 * 60 * 1000))) },
      standing: s,
    };
  }

  return {
    scope,
    requiresSecondConfirm: false,
    titleKey: 'openstoa.deviceData.eraseDevice.confirmTitle',
    bodyKey: 'openstoa.deviceData.eraseDevice.confirmBody',
    bodyValues: {},
    standing: s,
  };
}
