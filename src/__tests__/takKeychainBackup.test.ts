// @vitest-environment jsdom
/**
 * `uploadTakKeychainNow()` / `ensureTakKeychainBackup()` — the ONE uploader and
 * the session-start repair that fixes every account already broken by the bug.
 *
 * THE BUG. `tak_key_backups` is one row per user and covers EVERY topic, but the
 * only thing that ever wrote it was the TAK key-CHANGE hook, which fires when a
 * key is newly WRITTEN. So a user who already held their keys and then set
 * recovery up got a wrapped master_key in `key_backups` and an EMPTY
 * `tak_key_backups`. Recovery "succeeded" and unlocked nothing, and opening a
 * chat wrote no new key so the hook never fired again — the account could not
 * heal itself. `ensureTakKeychainBackup` is the trigger that does not depend on
 * writing a key.
 *
 * Edge-case matrix rows covered here:
 *   empty      — no TAK keys on this device → 'empty', successful NO-OP, no POST
 *   boundary   — 0 / 1 / many keys; 1 and many upload, 0 does not
 *   integrity  — the payload is the whole keychain, sealed, byte-for-byte
 *   authz      — a device holding a throwaway key NEVER clobbers the account's
 *                real backup ('untrusted'); a dead backup nothing can recover IS
 *                replaced
 *   hostile    — an unverifiable/orphan root aborts the export → no POST, so a
 *                bad root can never reach the account's single backup row
 *   ext-dep    — offline GET, POST 500 → 'failed', never a false success
 *   contract   — 'present' short-circuits BEFORE exportKeychain, so the repair
 *                cannot become an upload storm on every page load
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const km = vi.hoisted(() => ({
  restoreTakKeychain: vi.fn(),
  loadOrCreateMasterKey: vi.fn(async () => new Uint8Array(32)),
  installMasterKey: vi.fn(async () => {}),
  hasMasterKey: vi.fn(async () => true),
  uploadTakKeychain: vi.fn(async (_mk: Uint8Array, keychain: Record<string, string>, post: (c: string) => Promise<void>) => {
    await post(`sealed:${JSON.stringify(keychain)}`);
  }),
  EncryptingKVStore: { lazy: () => ({ get: async () => null, set: async () => {} }) },
}));
const store = vi.hoisted(() => ({ exportKeychain: vi.fn(async () => ({}) as Record<string, string>) }));

vi.mock('@/lib/mls/keyManager', () => km);
vi.mock('@/lib/passkeyPrf', () => ({ getPasskeyPrf: vi.fn() }));
vi.mock('@/lib/mls/mlsSession', () => ({ MlsSessionStore: class {} }));
vi.mock('@/lib/mls/takSession', () => ({
  TakSessionStore: class {
    exportKeychain = store.exportKeychain;
  },
}));

const server = {
  takBlob: null as string | null,
  passkeys: [] as unknown[],
  wrappedMaster: null as string | null,
  takGetThrows: false,
  postStatus: 200,
};
let posts: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules(); // webTransport memoizes its stores — every test gets a fresh module
  store.exportKeychain.mockResolvedValue({});
  km.loadOrCreateMasterKey.mockResolvedValue(new Uint8Array(32));
  // A realistic server round-trip: the fake uploader seals as `sealed:<json>`, so
  // opening a blob returns exactly what was last uploaded. Merge semantics are
  // untestable against a mock that always says "opened nothing".
  km.restoreTakKeychain.mockImplementation(async (_mk: Uint8Array, fetchBlob: () => Promise<string | null>) => {
    const blob = await fetchBlob();
    if (!blob) return null;
    return blob.startsWith('sealed:') ? (JSON.parse(blob.slice(7)) as Record<string, string>) : null;
  });
  server.takBlob = null;
  server.passkeys = [];
  server.wrappedMaster = null;
  server.takGetThrows = false;
  server.postStatus = 200;
  posts = [];

  vi.stubGlobal('indexedDB', { open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }) });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/keys/tak-backup')) {
        if (init?.method === 'POST') {
          posts.push(String(init.body));
          return Promise.resolve(new Response('{}', { status: server.postStatus }));
        }
        if (server.takGetThrows) return Promise.reject(new Error('offline'));
        return Promise.resolve(new Response(JSON.stringify({ ciphertext: server.takBlob }), { status: 200 }));
      }
      if (url.includes('/api/keys/backup')) {
        return Promise.resolve(
          new Response(JSON.stringify({ passkeys: server.passkeys, wrappedMaster: server.wrappedMaster }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    }),
  );
});

async function mod() {
  return import('@/lib/mls/webTransport');
}

describe('uploadTakKeychainNow', () => {
  it('EMPTY keychain is a successful no-op, not an error and not a POST', async () => {
    store.exportKeychain.mockResolvedValue({});
    const { uploadTakKeychainNow } = await mod();

    expect(await uploadTakKeychainNow()).toBe('empty');
    expect(posts).toEqual([]);
  });

  it('BOUNDARY: exactly one key uploads', async () => {
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { uploadTakKeychainNow } = await mod();

    expect(await uploadTakKeychainNow()).toBe('uploaded');
    expect(posts).toHaveLength(1);
  });

  it('INTEGRITY: the whole keychain is sealed and sent verbatim', async () => {
    const keychain = {
      'tak.root.t1': 'AAA',
      'tak.epoch.t1.0': 'BBB',
      'tak.epoch.t1.1': 'CCC',
      'tak.root.t2': 'DDD',
    };
    store.exportKeychain.mockResolvedValue(keychain);
    const { uploadTakKeychainNow } = await mod();

    expect(await uploadTakKeychainNow()).toBe('uploaded');
    expect(km.uploadTakKeychain).toHaveBeenCalledTimes(1);
    expect(km.uploadTakKeychain.mock.calls[0][1]).toEqual(keychain);
    // The server only ever sees ciphertext — the plaintext keychain never goes
    // over the wire (SI-8, "no escrow").
    expect(JSON.parse(posts[0]).ciphertext).toBe(`sealed:${JSON.stringify(keychain)}`);
  });

  it('AUTHZ: a device holding a throwaway key never clobbers the real backup', async () => {
    // Server has a keychain this device's key cannot open, and a passkey wrap
    // can still produce the real key → uploading would destroy the only
    // recoverable snapshot the account has.
    server.takBlob = 'sealed-under-the-real-key';
    server.passkeys = [{ credentialId: 'c1', prfWrapped: 'w' }];
    km.restoreTakKeychain.mockResolvedValue(null);
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { uploadTakKeychainNow } = await mod();

    expect(await uploadTakKeychainNow()).toBe('untrusted');
    expect(posts).toEqual([]);
    expect(store.exportKeychain).not.toHaveBeenCalled();
  });

  it('AUTHZ: a backup nothing can recover IS replaced — it is already dead weight', async () => {
    server.takBlob = 'sealed-under-a-key-that-is-gone';
    server.passkeys = [];
    server.wrappedMaster = null;
    km.restoreTakKeychain.mockResolvedValue(null);
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { uploadTakKeychainNow } = await mod();

    expect(await uploadTakKeychainNow()).toBe('uploaded');
    expect(posts).toHaveLength(1);
  });

  it('HOSTILE: an unverifiable root aborts the export → nothing is uploaded', async () => {
    // `exportKeychain` THROWS when it cannot decide whether a root is an orphan.
    // Uploading a partial keychain here would replace a good backup with one
    // missing the root that opens the archive.
    store.exportKeychain.mockRejectedValue(new Error('root-fingerprint GET 500'));
    const { uploadTakKeychainNow } = await mod();

    expect(await uploadTakKeychainNow()).toBe('failed');
    expect(posts).toEqual([]);
  });

  it('EXTERNAL FAILURE: a rejected POST reports failure, never a false success', async () => {
    server.postStatus = 500;
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { uploadTakKeychainNow } = await mod();

    expect(await uploadTakKeychainNow()).toBe('failed');
  });

  it('EXTERNAL FAILURE: a fully offline client never throws at the caller', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { uploadTakKeychainNow } = await mod();

    await expect(uploadTakKeychainNow()).resolves.toBe('failed');
  });
});

describe('ensureTakKeychainBackup — the repair path for already-broken accounts', () => {
  it('REGRESSION: an account with keys and NO server row gets one, with no key write', async () => {
    // Exactly the reported state: recovery was set up, `tak_key_backups` is
    // empty, and the user has no reason to write a new key so the change hook
    // will never fire. This is the only thing that can heal it.
    server.takBlob = null;
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA', 'tak.epoch.t1.3': 'BBB' });
    const { ensureTakKeychainBackup } = await mod();

    expect(await ensureTakKeychainBackup()).toBe('uploaded');
    expect(posts).toHaveLength(1);
  });

  it('REGRESSION: a snapshot MISSING keys this device holds is merged, never replaced', async () => {
    // The 6-keys-to-2 loss, reproduced. A browser that has just recovered holds
    // the account's real key, so every trust check passes — and then it uploads
    // only its own two keys over the account's six, deleting four the user could
    // read minutes earlier. The upload must be a union.
    server.takBlob = `sealed:${JSON.stringify({ 'tak.root.t1': 'AAA', 'tak.epoch.t1.0': 'BBB', 'tak.epoch.t1.1': 'CCC' })}`;
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA', 'tak.epoch.t2.0': 'DDD' });
    const { ensureTakKeychainBackup } = await mod();

    expect(await ensureTakKeychainBackup()).toBe('uploaded');
    expect(posts).toHaveLength(1);
    const sent = JSON.parse(
      (JSON.parse(posts[0] as string) as { ciphertext: string }).ciphertext.slice(7),
    ) as Record<string, string>;
    expect(Object.keys(sent).sort()).toEqual(['tak.epoch.t1.0', 'tak.epoch.t1.1', 'tak.epoch.t2.0', 'tak.root.t1']);
  });

  it('CONTRACT: a snapshot that already covers this device is left alone — no upload storm', async () => {
    server.takBlob = `sealed:${JSON.stringify({ 'tak.root.t1': 'AAA', 'tak.epoch.t1.0': 'BBB' })}`;
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { ensureTakKeychainBackup } = await mod();

    expect(await ensureTakKeychainBackup()).toBe('present');
    // The export now runs on every call — it is the only way to know whether we
    // hold anything the snapshot lacks. What must NOT happen is the write.
    expect(posts).toEqual([]);
  });

  it('a device with no keys yet reports empty rather than uploading nothing', async () => {
    server.takBlob = null;
    store.exportKeychain.mockResolvedValue({});
    const { ensureTakKeychainBackup } = await mod();

    expect(await ensureTakKeychainBackup()).toBe('empty');
    expect(posts).toEqual([]);
  });

  it('EXTERNAL FAILURE: an unreadable server never triggers an upload on a guess', async () => {
    server.takGetThrows = true;
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { ensureTakKeychainBackup } = await mod();

    expect(await ensureTakKeychainBackup()).toBe('failed');
    expect(posts).toEqual([]);
  });

  it('RACE: repeated calls converge — the second one finds the row and sends nothing', async () => {
    server.takBlob = null;
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { ensureTakKeychainBackup } = await mod();

    expect(await ensureTakKeychainBackup()).toBe('uploaded');
    server.takBlob = 'now-there'; // the upsert landed
    km.restoreTakKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    expect(await ensureTakKeychainBackup()).toBe('present');
    expect(posts).toHaveLength(1);
  });
});
