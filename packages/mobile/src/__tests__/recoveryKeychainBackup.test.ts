/**
 * Mini-app twin of `src/__tests__/takKeychainBackup.test.ts` — the ONE uploader,
 * the session-start repair, and the nudge decision.
 *
 * THE BUG. `tak_key_backups` is one row per user covering EVERY topic, but the
 * only thing that wrote it was the TAK key-CHANGE hook, which fires when a key
 * is newly WRITTEN. A user who registered a passkey in the mobile app after
 * already holding their keys got a wrapped master_key and an EMPTY keychain row:
 * recovery came back, opened nothing, and opening a chat wrote no new key so the
 * hook never fired again.
 *
 * Edge-case matrix rows covered here:
 *   contract   — recovery setup uploads (asserted on the screen's helper path
 *                via `uploadTakKeychainNow`); the repair runs without any key write
 *   empty      — no TAK keys → 'empty', successful NO-OP, no POST
 *   boundary   — 0 / 1 / many keys
 *   integrity  — the sealed payload carries the whole keychain verbatim
 *   authz      — a device holding a throwaway key never clobbers the account's
 *                recoverable backup; an unrecoverable one IS replaced
 *   hostile    — an unverifiable/orphan root aborts the export → no POST
 *   ext-dep    — offline GET / failing POST → 'failed', never a false success
 *   race       — repeated calls converge on one upload
 *   i18n       — every new key exists in en AND ko, non-empty in both
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const km = vi.hoisted(() => ({
  restoreTakKeychain: vi.fn(),
  loadOrCreateMasterKey: vi.fn(async () => new Uint8Array(32)),
  installMasterKey: vi.fn(async () => {}),
  uploadTakKeychain: vi.fn(
    async (_mk: Uint8Array, keychain: Record<string, string>, post: (c: string) => Promise<void>) => {
      await post(`sealed:${JSON.stringify(keychain)}`);
    },
  ),
  EncryptingKVStore: { lazy: () => ({ get: async () => null, set: async () => {} }) },
}));
const store = vi.hoisted(() => ({ exportKeychain: vi.fn(async () => ({}) as Record<string, string>) }));

vi.mock('../crypto/keyManager', () => km);
vi.mock('../crypto/mlsSession', () => ({ MlsSessionStore: class {} }));
vi.mock('../crypto/takSession', () => ({
  TakSessionStore: class {
    exportKeychain = store.exportKeychain;
  },
}));

const server = {
  takBlob: null as string | null,
  passkeys: [] as unknown[],
  wrappedMaster: null as string | null,
  takGetThrows: false,
  postThrows: false,
};
let posts: unknown[] = [];

const secureStore = {
  getItem: async () => null,
  setItem: async () => {},
};

function fakeClient() {
  return {
    get: async (url: string) => {
      if (url === '/api/keys/tak-backup') {
        if (server.takGetThrows) throw new Error('offline');
        return { ciphertext: server.takBlob };
      }
      if (url === '/api/keys/backup') {
        return { passkeys: server.passkeys, wrappedMaster: server.wrappedMaster };
      }
      throw new Error(`unexpected GET ${url}`);
    },
    post: async (url: string, body: unknown) => {
      if (url === '/api/keys/tak-backup') {
        if (server.postThrows) throw new Error('POST /api/keys/tak-backup → 500: nope');
        posts.push(body);
        return {};
      }
      throw new Error(`unexpected POST ${url}`);
    },
    put: async () => ({}),
    delete: async () => ({}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules(); // mobileTransport memoizes its stores
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
  server.postThrows = false;
  posts = [];
});

async function mod() {
  return import('../crypto/mobileTransport');
}

describe('uploadTakKeychainNow (mobile)', () => {
  it('EMPTY keychain is a successful no-op, not an error and not a POST', async () => {
    const { uploadTakKeychainNow } = await mod();
    expect(await uploadTakKeychainNow(fakeClient(), secureStore)).toBe('empty');
    expect(posts).toEqual([]);
  });

  it('BOUNDARY: exactly one key uploads', async () => {
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { uploadTakKeychainNow } = await mod();
    expect(await uploadTakKeychainNow(fakeClient(), secureStore)).toBe('uploaded');
    expect(posts).toHaveLength(1);
  });

  it('INTEGRITY: the whole keychain is sealed and sent verbatim', async () => {
    const keychain = { 'tak.root.t1': 'AAA', 'tak.epoch.t1.0': 'BBB', 'tak.root.t2': 'CCC' };
    store.exportKeychain.mockResolvedValue(keychain);
    const { uploadTakKeychainNow } = await mod();

    expect(await uploadTakKeychainNow(fakeClient(), secureStore)).toBe('uploaded');
    expect(km.uploadTakKeychain.mock.calls[0][1]).toEqual(keychain);
    // The server only ever sees ciphertext — no escrow (SI-8).
    expect(posts[0]).toEqual({ ciphertext: `sealed:${JSON.stringify(keychain)}` });
  });

  it('AUTHZ: a device holding a throwaway key never clobbers the real backup', async () => {
    server.takBlob = 'sealed-under-the-real-key';
    server.passkeys = [{ credentialId: 'c1', prfWrapped: 'w' }];
    km.restoreTakKeychain.mockResolvedValue(null); // our key does not fit
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { uploadTakKeychainNow } = await mod();

    expect(await uploadTakKeychainNow(fakeClient(), secureStore)).toBe('untrusted');
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

    expect(await uploadTakKeychainNow(fakeClient(), secureStore)).toBe('uploaded');
    expect(posts).toHaveLength(1);
  });

  it('AUTHZ: a device whose key OPENS the existing backup may refresh it', async () => {
    server.takBlob = 'ours';
    km.restoreTakKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA', 'tak.epoch.t1.4': 'NEW' });
    const { uploadTakKeychainNow } = await mod();

    expect(await uploadTakKeychainNow(fakeClient(), secureStore)).toBe('uploaded');
  });

  it('HOSTILE: an unverifiable root aborts the export → nothing is uploaded', async () => {
    store.exportKeychain.mockRejectedValue(new Error('root-fingerprint GET → 500: boom'));
    const { uploadTakKeychainNow } = await mod();

    expect(await uploadTakKeychainNow(fakeClient(), secureStore)).toBe('failed');
    expect(posts).toEqual([]);
  });

  it('EXTERNAL FAILURE: a rejected POST reports failure, never a false success', async () => {
    server.postThrows = true;
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { uploadTakKeychainNow } = await mod();

    expect(await uploadTakKeychainNow(fakeClient(), secureStore)).toBe('failed');
  });

  it('EXTERNAL FAILURE: an unreadable server never throws at the caller', async () => {
    server.takGetThrows = true;
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { uploadTakKeychainNow } = await mod();

    await expect(uploadTakKeychainNow(fakeClient(), secureStore)).resolves.toBe('failed');
  });
});

describe('ensureTakKeychainBackup (mobile) — the repair path', () => {
  it('REGRESSION: an account with keys and NO server row gets one, with no key write', async () => {
    server.takBlob = null;
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA', 'tak.epoch.t1.3': 'BBB' });
    const { ensureTakKeychainBackup } = await mod();

    expect(await ensureTakKeychainBackup(fakeClient(), secureStore)).toBe('uploaded');
    expect(posts).toHaveLength(1);
  });

  it('REGRESSION: a snapshot MISSING keys this device holds is merged, never replaced', async () => {
    // The 6-keys-to-2 loss. A device that has just recovered holds the account's
    // real key, so every trust check passes — and then it uploads only its own
    // two keys over the account's six, deleting four the user could read minutes
    // earlier. The upload must be a union.
    server.takBlob = `sealed:${JSON.stringify({ 'tak.root.t1': 'AAA', 'tak.epoch.t1.0': 'BBB', 'tak.epoch.t1.1': 'CCC' })}`;
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA', 'tak.epoch.t2.0': 'DDD' });
    const { ensureTakKeychainBackup } = await mod();

    expect(await ensureTakKeychainBackup(fakeClient(), secureStore)).toBe('uploaded');
    expect(posts).toHaveLength(1);
    const sent = JSON.parse((posts[0] as { ciphertext: string }).ciphertext.slice(7)) as Record<string, string>;
    expect(Object.keys(sent).sort()).toEqual(['tak.epoch.t1.0', 'tak.epoch.t1.1', 'tak.epoch.t2.0', 'tak.root.t1']);
  });

  it('CONTRACT: a snapshot that already covers this device is left alone — no upload storm', async () => {
    server.takBlob = `sealed:${JSON.stringify({ 'tak.root.t1': 'AAA', 'tak.epoch.t1.0': 'BBB' })}`;
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { ensureTakKeychainBackup } = await mod();

    expect(await ensureTakKeychainBackup(fakeClient(), secureStore)).toBe('present');
    // The export now runs on every call — it is the only way to know whether we
    // hold anything the snapshot lacks. What must NOT happen is the write.
    expect(posts).toEqual([]);
  });

  it('a device with no keys yet reports empty rather than uploading nothing', async () => {
    const { ensureTakKeychainBackup } = await mod();
    expect(await ensureTakKeychainBackup(fakeClient(), secureStore)).toBe('empty');
    expect(posts).toEqual([]);
  });

  it('EXTERNAL FAILURE: an unreadable server never triggers an upload on a guess', async () => {
    server.takGetThrows = true;
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { ensureTakKeychainBackup } = await mod();

    expect(await ensureTakKeychainBackup(fakeClient(), secureStore)).toBe('failed');
    expect(posts).toEqual([]);
  });

  it('RACE: repeated calls converge — the second finds its keys already there and sends nothing', async () => {
    store.exportKeychain.mockResolvedValue({ 'tak.root.t1': 'AAA' });
    const { ensureTakKeychainBackup } = await mod();
    const client = fakeClient();

    expect(await ensureTakKeychainBackup(client, secureStore)).toBe('uploaded');
    server.takBlob = (posts[0] as { ciphertext: string }).ciphertext; // the server now holds what we sent
    expect(await ensureTakKeychainBackup(client, secureStore)).toBe('present');
    expect(posts).toHaveLength(1);
  });
});

describe('shouldNudgeRecovery (mobile copy)', () => {
  const base = { authenticated: true, dismissed: false, hasRecovery: false, backup: 'present' as const };

  it('prompts a signed-in user with history and no recovery', async () => {
    const { shouldNudgeRecovery } = await import('../lib/recoveryNudge');
    expect(shouldNudgeRecovery(base)).toBe(true);
    expect(shouldNudgeRecovery({ ...base, backup: 'uploaded' })).toBe(true);
  });

  it('stays quiet for guests, the already-configured, the dismissed, and the empty', async () => {
    const { shouldNudgeRecovery } = await import('../lib/recoveryNudge');
    expect(shouldNudgeRecovery({ ...base, authenticated: false })).toBe(false);
    expect(shouldNudgeRecovery({ ...base, hasRecovery: true })).toBe(false);
    expect(shouldNudgeRecovery({ ...base, dismissed: true })).toBe(false);
    expect(shouldNudgeRecovery({ ...base, backup: 'empty' })).toBe(false);
    expect(shouldNudgeRecovery({ ...base, backup: 'failed' })).toBe(false);
    expect(shouldNudgeRecovery({ ...base, backup: 'untrusted' })).toBe(false);
  });

  it('the dismissal key is per-account, so one user cannot silence another', async () => {
    const { recoveryNudgeDismissKey } = await import('../lib/recoveryNudge');
    expect(recoveryNudgeDismissKey('a')).not.toBe(recoveryNudgeDismissKey('b'));
  });

  it('is BYTE-IDENTICAL to the web copy, so both clients decide the same way', () => {
    const root = path.resolve(__dirname, '../../../..');
    const web = readFileSync(path.join(root, 'src/lib/recoveryNudge.ts'), 'utf-8');
    const mobile = readFileSync(path.join(root, 'packages/mobile/src/lib/recoveryNudge.ts'), 'utf-8');
    expect(mobile, 'recoveryNudge.ts drifted between web and mobile').toBe(web);
  });
});

describe('i18n: the new copy exists in both locales', () => {
  const root = path.resolve(__dirname, '../../../..');
  const load = (loc: 'en' | 'ko') =>
    JSON.parse(readFileSync(path.join(root, `packages/mobile/src/i18n/locales/${loc}.json`), 'utf-8'))
      .openstoa as Record<string, Record<string, string>>;

  it.each(['en', 'ko'] as const)('%s carries every new key, non-empty', (loc) => {
    const d = load(loc);
    for (const k of ['keychainUploadFailed', 'keychainUntrusted']) {
      expect(d.recovery?.[k]?.trim(), `openstoa.recovery.${k}`).toBeTruthy();
    }
    for (const k of ['title', 'body', 'cta', 'dismiss', 'dismissAria', 'close']) {
      expect(d.recoveryNudge?.[k]?.trim(), `openstoa.recoveryNudge.${k}`).toBeTruthy();
    }
  });

  it('the two locales are not the same string (ko is actually translated)', () => {
    expect(load('ko').recoveryNudge.title).not.toBe(load('en').recoveryNudge.title);
    expect(load('ko').recovery.keychainUntrusted).not.toBe(load('en').recovery.keychainUntrusted);
  });
});
