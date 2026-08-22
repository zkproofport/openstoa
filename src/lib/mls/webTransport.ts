/**
 * Browser wiring for the MLS session manager: an HTTP transport over the
 * Delivery Service REST endpoints (cookie-authenticated) + a lazy per-device
 * singleton store. Browser-only — every entry point is called from client
 * event handlers / effects, never during SSR.
 */
import { apiFetch } from '@/lib/apiFetch';
import { MlsSessionStore, type MlsTransport, type SecureKVStore } from './mlsSession';
import { TakSessionStore, type TakTransport, type TakBundleRow, type ArchiveEntry } from './takSession';
import * as km from './keyManager';
import { b64, unb64 } from './keyBackup';
import { getPasskeyPrf } from '@/lib/passkeyPrf';

function httpTransport(): MlsTransport {
  const base = (t: string) => `/api/topics/${t}/mls`;
  const json = { 'Content-Type': 'application/json' };
  return {
    async getGroupInfo(topicId) {
      const r = await apiFetch(`${base(topicId)}/group-info`, { credentials: 'include' });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`group-info GET ${r.status}`);
      return (await r.json()).groupInfo as string;
    },
    async postGroupInfo(topicId, groupInfoB64, groupIdB64) {
      const r = await apiFetch(`${base(topicId)}/group-info`, {
        method: 'POST',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ groupInfo: groupInfoB64, groupId: groupIdB64 }),
      });
      if (!r.ok) throw new Error(`group-info POST ${r.status}`);
      return (await r.json()).created as boolean;
    },
    async postCommit(topicId, commitB64, groupInfoB64) {
      const r = await apiFetch(`${base(topicId)}/commit`, {
        method: 'POST',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ commit: commitB64, groupInfo: groupInfoB64 }),
      });
      if (r.status === 409) return { ok: false }; // epoch-CAS conflict → caller rebases
      if (!r.ok) throw new Error(`commit POST ${r.status}`);
      return { ok: true, epoch: (await r.json()).epoch as number };
    },
    async getCommitsSince(topicId, sinceEpoch) {
      const r = await apiFetch(`${base(topicId)}/commit?sinceEpoch=${sinceEpoch}`, { credentials: 'include' });
      if (!r.ok) throw new Error(`commit GET ${r.status}`);
      return (await r.json()).commits;
    },
  };
}

// Stable per-browser-device MLS identity (the leaf credential). Device-scoped,
// not user-scoped — a user's devices are distinct MLS leaves by design.
function deviceIdentity(): string {
  const KEY = 'openstoa.mls.device';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    localStorage.setItem(KEY, id);
  }
  return id;
}

// IndexedDB-backed persistence for the live MLS ClientState (~1.7KB/topic), so
// a page reload restores the same leaf instead of re-joining (which dropped
// pre-reload history). Web-only; called lazily from client code.
function indexedDbStore(): SecureKVStore {
  const DB_NAME = 'openstoa-mls';
  const STORE = 'state';
  let dbp: Promise<IDBDatabase> | null = null;
  function openDb(): Promise<IDBDatabase> {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  return {
    async get(key) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
        req.onerror = () => reject(req.error);
      });
    },
    async set(key, value) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
  };
}

// Single memoized IndexedDB handle shared by the root (master_key) store and the
// encrypting wrapper — avoids opening multiple connections to the same DB.
let _idb: SecureKVStore | null = null;
function idbStore(): SecureKVStore {
  if (!_idb) _idb = indexedDbStore();
  return _idb;
}

// Phase 4: the device master_key lives (plaintext bytes) in the raw idb under a
// reserved key; everything else (MLS state, TAK keys, message cache) is written
// through EncryptingKVStore, sealed under HKDF(master_key,"local-store"). Memoized.
let _masterKeyPromise: Promise<Uint8Array> | null = null;
function masterKey(): Promise<Uint8Array> {
  if (!_masterKeyPromise) _masterKeyPromise = km.loadOrCreateMasterKey(idbStore());
  return _masterKeyPromise;
}

let _encStore: SecureKVStore | null = null;
function encStore(): SecureKVStore {
  // The root store is passed so reads can fall back to the key this device used
  // before it recovered — otherwise recovery silently empties its own history.
  if (!_encStore) _encStore = km.EncryptingKVStore.lazy(idbStore(), masterKey, idbStore());
  return _encStore;
}

/**
 * The signed-in account, for naming this device's MLS leaf.
 *
 * Resolved lazily and only once, because the store is built before the session
 * lookup has answered and the answer is only needed the first time this device
 * publishes a credential. A guest, or a lookup that fails, yields null — the
 * leaf falls back to the bare device id and chat still works.
 */
async function sessionUserId(): Promise<string | null> {
  try {
    const r = await apiFetch('/api/auth/session');
    if (!r.ok) return null;
    const d = (await r.json()) as { userId?: string };
    return d?.userId ?? null;
  } catch {
    return null;
  }
}

let _store: MlsSessionStore | null = null;
export function getMlsSessionStore(): MlsSessionStore {
  if (!_store) {
    // MLS ClientState + decrypted message cache, both at-rest encrypted under the
    // master_key. Keys are namespaced (mls.state.* / mls.identity / mls.msg.*).
    const s = encStore();
    _store = new MlsSessionStore(httpTransport(), deviceIdentity(), s, s, sessionUserId);
  }
  return _store;
}

// HTTP transport for the Phase 3 TAK layer (archive + bundle endpoints). The
// server is crypto-free — this only moves opaque ciphertext.
function httpTakTransport(): TakTransport {
  const base = (t: string) => `/api/topics/${t}`;
  const json = { 'Content-Type': 'application/json' };
  return {
    async postArchive(topicId, messageId, takVersion, archiveB64) {
      const r = await apiFetch(`${base(topicId)}/archive`, {
        method: 'POST',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ messageId, takVersion, archive: archiveB64 }),
      });
      if (!r.ok && r.status !== 200) throw new Error(`archive POST ${r.status}`);
    },
    async getArchive(topicId) {
      // Walk the keyset cursor to completion so callers get the full archive.
      const out: ArchiveEntry[] = [];
      let cursor = '';
      for (;;) {
        const r = await apiFetch(`${base(topicId)}/archive?limit=500${cursor}`, { credentials: 'include' });
        if (!r.ok) throw new Error(`archive GET ${r.status}`);
        const page = (await r.json()).archive as ArchiveEntry[];
        out.push(...page);
        if (page.length < 500) break;
        const last = page[page.length - 1];
        cursor = `&since=${encodeURIComponent(last.createdAt)}&sinceMsg=${last.messageId}`;
      }
      return out;
    },
    async postBundle(topicId, recipientUserId, recipientDeviceId, bundleB64, scope) {
      const r = await apiFetch(`${base(topicId)}/tak/bundles`, {
        method: 'POST',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ recipientUserId, recipientDeviceId, bundle: bundleB64, scope }),
      });
      if (!r.ok) throw new Error(`bundle POST ${r.status}`);
    },
    async getBundles(topicId, deviceId) {
      const r = await apiFetch(`${base(topicId)}/tak/bundles?deviceId=${encodeURIComponent(deviceId)}`, {
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`bundle GET ${r.status}`);
      return (await r.json()).bundles as TakBundleRow[];
    },
    async ackBundles(topicId, deviceId, ids) {
      const r = await apiFetch(`${base(topicId)}/tak/bundles`, {
        method: 'DELETE',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ deviceId, ids }),
      });
      if (!r.ok) throw new Error(`bundle DELETE ${r.status}`);
    },
    async getServerRoot(topicId) {
      const r = await apiFetch(`${base(topicId)}/archive/root`, { credentials: 'include' });
      // 204 = nothing deposited yet; 403 = a tier that keeps its key on devices.
      // Neither is a failure — both mean "the server has nothing for you", and
      // throwing would turn an ordinary answer into a broken room.
      if (r.status === 204 || r.status === 403 || r.status === 404) return null;
      if (!r.ok) throw new Error(`archive root GET ${r.status}`);
      const { rootKey } = await r.json();
      return typeof rootKey === 'string' && rootKey.length > 0 ? unb64(rootKey) : null;
    },
    async putServerRoot(topicId, root) {
      const r = await apiFetch(`${base(topicId)}/archive/root`, {
        method: 'PUT',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ rootKey: b64(root) }),
      });
      // 409 = somebody deposited a different key first. That is a normal race,
      // not an error: the caller reads theirs instead of keeping a key that
      // nothing was ever sealed under.
      if (r.status === 409) return false;
      if (!r.ok) throw new Error(`archive root PUT ${r.status}`);
      return true;
    },
    async getRootFingerprint(topicId) {
      const r = await apiFetch(`${base(topicId)}/tak/root-fingerprint`, { credentials: 'include' });
      // 400 = not a public topic, 404 = topic gone. Neither is a failure to
      // report: those topics have no shared archive root at all, so the honest
      // answer is "nothing published". Throwing here would abort the keychain
      // backup for a stray root key on a non-public topic.
      if (r.status === 400 || r.status === 404) return { fingerprint: null, archiveCount: 0 };
      if (!r.ok) throw new Error(`root-fingerprint GET ${r.status}`);
      return await r.json();
    },
    async setRootFingerprint(topicId, fingerprint) {
      const r = await apiFetch(`${base(topicId)}/tak/root-fingerprint`, {
        method: 'PUT',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ fingerprint }),
      });
      if (!r.ok) throw new Error(`root-fingerprint PUT ${r.status}`);
      return await r.json();
    },
  };
}

/**
 * What an attempt to put this device's TAK keychain on the server did.
 *
 * Callers that are USER-FACING (recovery setup) must distinguish these: a
 * recovery setup that wrapped the master_key but silently failed to upload the
 * keychain is the exact half-built state that made recovery look configured and
 * unlock nothing. 'empty' is a genuine success — a user with no chat keys yet
 * has nothing to snapshot, and the master_key wrap is still worth having.
 *
 *   'uploaded'  the keychain is on the server, sealed under this device's key
 *   'empty'     this device holds no TAK keys — successful no-op
 *   'present'   a backup already exists (ensure-path only; nothing was sent)
 *   'untrusted' this device's key is a throwaway — uploading would CLOBBER the
 *               account's real backup, so nothing was sent
 *   'failed'    export or upload threw (offline, or the orphan check could not
 *               be completed — see `exportKeychain`)
 */
export type TakBackupOutcome = 'uploaded' | 'empty' | 'present' | 'untrusted' | 'failed';

/**
 * Snapshot this device's TAK keychain, seal it under the master_key, and upload
 * it (design §6.4.1) so a recovered master_key re-reads all archived history
 * with no other member online.
 *
 * The ONE uploader. The debounced key-change hook, recovery setup and the
 * session-boot repair all route through here so the trust guards below can
 * never be bypassed by adding a second call site.
 */
export async function uploadTakKeychainNow(): Promise<TakBackupOutcome> {
  try {
    // What this device HOLDS — reported FIRST, ahead of every guard below.
    // Placed after them it never ran on the device that mattered: a browser
    // whose key cannot open the account backup returns 'untrusted' immediately,
    // which is exactly the device whose contents are in question. A device that
    // may not upload can still be the only one holding the root that opens the
    // locked rows. Names and presence only.
    try {
      report('diagnose', await getTakSessionStore().diagnoseKeychain(await joinedTopicIds()));
    } catch (e) {
      report('diagnose-failed', { error: String(e) });
    }

    // Do NOT overwrite the account's backup from a device whose master_key
    // is a throwaway. `POST /api/keys/tak-backup` upserts a single row per
    // user, so a second device that minted its own key would replace a
    // keychain sealed under the REAL key with one only it can open — and
    // the user's recovery code would then restore a keychain that decrypts
    // to nothing. Uploading is only safe once this device holds the
    // account's key, i.e. after recovery or first-run induction.
    if ((await getDeviceKeyState()) === 'recoverable') return 'untrusted';

    // MERGE, NEVER REPLACE. The row is one per user and the POST overwrites it
    // whole, so a device that uploads only what it happens to hold DELETES every
    // key it does not — and holding the account's real key makes that device look
    // maximally trustworthy while it does so. That is not hypothetical: a browser
    // that had just recovered wrote its 2 keys over the account's 6 and re-locked
    // history the user could read minutes earlier.
    const base = await readBackedUpKeychain();

    // `exportKeychain` drops orphan roots and skips any it cannot check, so an
    // unverified root can never reach the account's single backup row.
    const mine = await getTakSessionStore().exportKeychain();
    const merged = { ...base, ...mine };
    const count = Object.keys(merged).length;
    if (count === 0) return 'empty';
    // Nothing of ours was missing from the snapshot. Uploading an identical map
    // would only add churn (and another chance to lose the race with a device
    // that does hold more).
    if (count === Object.keys(base).length) {
      report('upload/already-covered', { count });
      return 'present';
    }

    await km.uploadTakKeychain(await masterKey(), merged, async (ciphertext) => {
      const r = await apiFetch('/api/keys/tak-backup', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext }),
      });
      if (!r.ok) throw new Error(`tak-backup POST ${r.status}`);
    });
    report('upload/merged', { was: Object.keys(base).length, now: count });
    return 'uploaded';
  } catch (e) {
    report('upload/failed', { error: String(e) });
    return 'failed';
  }
}

/**
 * The account's server-side keychain as this device can read it.
 *
 * `{}` means there is nothing to merge into: either nothing is backed up yet, or
 * a snapshot exists that no key on this account can open. The second case is
 * dead weight — the `'recoverable'` guard above already declined the case where
 * something CAN still produce the real key — so letting our keys replace it is
 * strictly better than preserving bytes nobody will ever read.
 */
/**
 * Topic ids to probe for keys the manifest never recorded, and for orphan roots
 * this device holds read-only. `/api/topics` returns exactly the caller's joined
 * topics. Best-effort: a failure narrows the diagnosis, it does not stop the
 * backup.
 */
async function joinedTopicIds(): Promise<string[]> {
  try {
    const r = await apiFetch('/api/topics', { credentials: 'include' });
    if (!r.ok) return [];
    const body = (await r.json()) as { topics?: { id: string }[] } | { id: string }[];
    const list = Array.isArray(body) ? body : (body.topics ?? []);
    return list.map((t) => t.id).filter(Boolean);
  } catch {
    return [];
  }
}

async function readBackedUpKeychain(): Promise<Record<string, string>> {
  const blob = await keyBackupHttp().getTakBackup();
  if (!blob) return {};
  return (await km.restoreTakKeychain(await masterKey(), async () => blob)) ?? {};
}

/**
 * Idempotent repair: make sure the account HAS a TAK-keychain backup.
 *
 * The defect this exists for: `tak_key_backups` was only ever written by the
 * key-CHANGE hook below, which fires when a key is newly WRITTEN. A user who
 * already held their keys and then set recovery up got a `key_backups` row and
 * an EMPTY `tak_key_backups` — recovery came back, opened nothing, and opening
 * a chat wrote no new key so the change hook never fired again. Every account
 * already in that state needs a trigger that does not depend on writing a key;
 * this is it.
 *
 * Runs when the session is established, NOT on chat-room entry: the backup is
 * account-level (one row per user, covering every topic), so binding its repair
 * to entering one room is what let the gap persist.
 */
export async function ensureTakKeychainBackup(): Promise<TakBackupOutcome> {
  try {
    // Deliberately NOT "a row exists, so we are done". That short-circuit is a
    // one-way door: once any device writes a partial snapshot, every device
    // holding the missing keys sees a row and stays quiet, so the account can
    // never climb back out. `uploadTakKeychainNow` merges and reports 'present'
    // by itself when it finds nothing to add, which is the same cheap outcome
    // without the trap.
    await keyBackupHttp().getTakBackup();
  } catch (e) {
    // Claim nothing when the server cannot be read — never upload on a guess.
    report('ensure/read-failed', { error: String(e) });
    return 'failed';
  }
  return uploadTakKeychainNow();
}

// Debounced upload of the master_key-encrypted TAK keychain to the server.
// Fired after any TAK write; best-effort (a failure never breaks chat — the
// local keychain is still authoritative).
let _takBackupTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTakKeychainBackup(): void {
  if (_takBackupTimer) clearTimeout(_takBackupTimer);
  _takBackupTimer = setTimeout(() => {
    void uploadTakKeychainNow(); // retried on the next keychain change
  }, 1500);
}

let _takStore: TakSessionStore | null = null;
export function getTakSessionStore(): TakSessionStore {
  if (!_takStore) {
    // Reuse the encrypting store (TAK keys namespaced tak.root.* / tak.epoch.*)
    // and the live MLS session store for group-state reads. onKeychainChange
    // schedules the encrypted server backup.
    _takStore = new TakSessionStore(getMlsSessionStore(), httpTakTransport(), encStore(), scheduleTakKeychainBackup);
  }
  return _takStore;
}

/**
 * The TAK transport on its own, for callers that need the archive INDEX rather
 * than its contents — the invite dialog counts how many messages the epochs it
 * is about to share actually open, and that is a read of `takVersion` and
 * `createdAt`, not of any key. Nothing here decrypts anything.
 */
let _takTransport: TakTransport | null = null;
export function getTakTransport(): TakTransport {
  if (!_takTransport) _takTransport = httpTakTransport();
  return _takTransport;
}

// ---------------------------------------------------------------------------
// Phase 4 key-backup client (used by the recovery / induction UI, P4-05)
// ---------------------------------------------------------------------------

/** The device's master_key (loaded/created on first call). */
export function getDeviceMasterKey(): Promise<Uint8Array> {
  return masterKey();
}

/**
 * Why a brand-new browser cannot read history, and what can be done about it.
 *
 * A fresh device MINTS its own master_key (`loadOrCreateMasterKey`) — it does
 * not adopt the account's. The TAK keychain on the server is sealed under the
 * ORIGINAL master_key, so this device cannot open it and every pre-join message
 * decrypts to nothing. That is the whole cause of a screen full of
 * "[unable to decrypt]" on a second device.
 *
 *   'ready'        — this device already holds a master_key. Nothing to do.
 *   'recoverable'  — no local key, but the account has a passkey wrap. One
 *                    WebAuthn tap adopts the real key and unlocks history.
 *   'no-backup'    — no local key and nothing to recover from. History from
 *                    before this device existed is genuinely unreachable; the
 *                    honest move is to say so and offer to set recovery up now.
 *
 * Deliberately cheap and SILENT: it only reads local storage and does a GET.
 * It must never call `navigator.credentials.get()` — Safari required a user
 * gesture for that through iOS 17.3, so the actual unlock has to hang off a
 * real tap (see `recoverDeviceWithPasskey`).
 */
export type DeviceKeyState = 'ready' | 'recoverable' | 'no-backup';

/**
 * Narrate the E2EE key path to somewhere READABLE.
 *
 * This path failed for days on a real phone while every layer reported the same
 * thing: nothing. Its outcomes are single words ('no-backup', 'unavailable') and
 * each one has several distinct causes, so on-device symptoms could not tell
 * them apart — and the browser console is not reachable on someone else's phone.
 * Mirroring to the server puts the answer in the same place as the request that
 * produced it.
 *
 * Only counts, byte LENGTHS, booleans, key NAMES and error strings — never key
 * material, ciphertext or message content. Fire-and-forget: diagnosing a failure
 * must never cause one.
 */
function report(step: string, detail: Record<string, unknown>): void {
  try {
    console.log('[E2EE]', step, JSON.stringify(detail));
    void apiFetch('/api/diag/e2ee', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step, detail }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* diagnostics are never allowed to break the flow they observe */
  }
}

export async function getDeviceKeyState(): Promise<DeviceKeyState> {
  const http = keyBackupHttp();
  try {
    const blob = await http.getTakBackup();
    report('state/blob', { bytes: blob?.length ?? 0 });
    // Nothing archived under any key: recovering a master_key would restore an
    // empty keychain, so there is genuinely nothing to offer.
    if (!blob) return 'no-backup';

    // THE question is not "does this device hold a master_key" — it always
    // does, because `loadOrCreateMasterKey` mints one the instant chat touches
    // the encrypting store. Asking that returned 'ready' on a brand-new
    // browser and hid the recovery offer behind the very condition it was
    // meant to detect. The real question is whether the key this device holds
    // can OPEN the account's archive.
    const opened = await km.restoreTakKeychain(await masterKey(), async () => blob);
    if (opened) {
      report('state/ready', { keys: Object.keys(opened).length });
      return 'ready';
    }

    // The archive exists but this device's key does not fit it — it belongs to
    // the account's real key. Offer recovery only if something can actually
    // produce that key.
    const wraps = await http.getBackup();
    const state = wraps.passkeys.length > 0 || wraps.wrappedMaster ? 'recoverable' : 'no-backup';
    report('state/wraps', { passkeys: wraps.passkeys.length, wrappedMaster: !!wraps.wrappedMaster, state });
    return state;
  } catch (e) {
    // Offline, or an endpoint failed: claim nothing. Callers may show this as
    // "no backup" but must never destroy anything on the strength of it.
    report('state/threw', { error: String(e) });
    return 'no-backup';
  }
}

/**
 * Adopt the account's real master_key on this device via passkey, then restore
 * the TAK keychain. MUST be called from a user gesture (click/tap) — see above.
 *
 * Returns false when the account has no passkey wrap to recover from, so the
 * caller can fall back to the recovery-code flow instead of showing a failure.
 */
/**
 * What actually happened, because "the key came back" and "your history came
 * back" are different events and conflating them is what made the unlock button
 * look broken: it returned true whenever the KEY was recovered, reloaded the
 * page, and left the same locked messages on screen with no explanation.
 *
 *   'restored'    key recovered AND the archive opened — history is readable
 *   'no-archive'  key recovered, but nothing on the server opens with it. The
 *                 usual cause is that another device overwrote the account's
 *                 TAK backup with one sealed under ITS OWN key (see the upload
 *                 guard in `scheduleTakKeychainBackup`). Recovering again will
 *                 not help; the device that still holds the real keys has to
 *                 re-upload them.
 *   'unavailable' nothing to recover from at all
 */
export type RecoveryOutcome = 'restored' | 'no-archive' | 'unavailable';

export async function recoverDeviceWithPasskey(): Promise<RecoveryOutcome> {
  const http = keyBackupHttp();
  const backup = await http.getBackup();
  if (backup.passkeys.length === 0) {
    report('recover/no-wraps', { passkeys: 0, wrappedMaster: !!backup.wrappedMaster });
    return 'unavailable';
  }
  let prfOutput: Uint8Array;
  try {
    ({ prfOutput } = await getPasskeyPrf());
  } catch (e) {
    // The most common real-world failure: the browser has no usable PRF (the
    // extension is unsupported, or the gesture was lost). It looks identical to
    // "no passkey registered" from the outside, and it is not.
    report('recover/prf-failed', { passkeys: backup.passkeys.length, error: String(e) });
    throw e;
  }
  const mk = await km.recoverWithPasskey(prfOutput, () => http.getBackup());
  if (!mk) {
    // PRF came back but unwrapped nothing: the wrap belongs to a different
    // passkey (or a different account's master_key).
    report('recover/unwrap-failed', { passkeys: backup.passkeys.length, prfBytes: prfOutput.length });
    return 'unavailable';
  }
  const restored = await recoverDevice(mk);
  report('recover/done', { restored, outcome: restored ? 'restored' : 'no-archive' });
  return restored ? 'restored' : 'no-archive';
}

/** HTTP client for /api/keys/backup + /api/keys/tak-backup (cookie auth). */
export function keyBackupHttp() {
  const json = { 'Content-Type': 'application/json' };
  return {
    async getBackup(): Promise<km.KeyBackupState> {
      const r = await apiFetch('/api/keys/backup', { credentials: 'include' });
      if (!r.ok) throw new Error(`keys/backup GET ${r.status}`);
      return (await r.json()) as km.KeyBackupState;
    },
    async postRecovery(wrappedMasterB64: string): Promise<void> {
      const r = await apiFetch('/api/keys/backup', {
        method: 'POST',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ type: 'recovery', wrappedMaster: wrappedMasterB64 }),
      });
      if (!r.ok) throw new Error(`keys/backup POST recovery ${r.status}`);
    },
    async postPasskey(credentialId: string, prfWrappedB64: string): Promise<void> {
      const r = await apiFetch('/api/keys/backup', {
        method: 'POST',
        credentials: 'include',
        headers: json,
        body: JSON.stringify({ type: 'passkey', credentialId, prfWrapped: prfWrappedB64 }),
      });
      if (!r.ok) throw new Error(`keys/backup POST passkey ${r.status}`);
    },
    async getTakBackup(): Promise<string | null> {
      const r = await apiFetch('/api/keys/tak-backup', { credentials: 'include' });
      if (!r.ok) throw new Error(`keys/tak-backup GET ${r.status}`);
      return (await r.json()).ciphertext as string | null;
    },
  };
}

/**
 * Install a recovered master_key on this device and restore the TAK keychain from
 * the server backup (recovery path). After this, chat re-joins MLS as a new leaf
 * and reads all archived history the recovered keychain covers.
 */
export async function recoverDevice(recoveredMasterKey: Uint8Array): Promise<boolean> {
  await km.installMasterKey(idbStore(), recoveredMasterKey);
  _masterKeyPromise = Promise.resolve(recoveredMasterKey); // refresh memo for the encrypting store
  _encStore = null;
  _store = null;
  _takStore = null; // rebuild stores under the recovered key
  const keychain = await km.restoreTakKeychain(recoveredMasterKey, () => keyBackupHttp().getTakBackup());
  if (!keychain) {
    // The account's key is now on this device, but the server's keychain snapshot
    // does not open with it — so the snapshot was sealed under a DIFFERENT key.
    report('restore/keychain-unopenable', {});
    return false;
  }
  const names = Object.keys(keychain);
  // Names, not values: which topics' roots and which epochs came back is exactly
  // what distinguishes "restored nothing" from "restored the wrong epochs".
  report('restore/keychain', { count: names.length, keys: names });
  await getTakSessionStore().importKeychain(keychain);
  return true;
}
