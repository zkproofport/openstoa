/**
 * Encrypted chat attachments, END-TO-END against a REAL running container over
 * HTTP — and, more importantly, ACROSS THE TWO CRYPTO PROVIDERS.
 *
 * Everything else about this feature is proven by unit and route tests with a
 * mocked database and object store. What no amount of that can prove is the one
 * thing that has actually broken this project before: the web client and the
 * mini-app run DIFFERENT AES-GCM implementations — the mobile copy swaps in
 * `@noble/ciphers` because Hermes' `crypto.subtle` (react-native-quick-crypto)
 * produced output standard WebCrypto could not read. Every unit test on both
 * sides passed while mobile→web was broken, because each side only ever talked
 * to itself.
 *
 * So device A here is the WEB stack (`src/lib/mls/*`, Node/browser WebCrypto)
 * and device B is the MOBILE stack (`packages/mobile/src/crypto/*`, noble).
 * Same topic, same server, opposite directions. If the providers ever diverge
 * again, this fails and nothing else does.
 *
 * TWO MODULE INSTANCES, ON PURPOSE. Both trees now re-export ONE implementation
 * (`packages/mls/src`), and the runtime is selected by `configureMlsRuntime` —
 * module-level state: one `runtime`, one memoized ciphersuite per module
 * instance. Imported plainly, `MobileMlsSessionStore` IS `MlsSessionStore`, the
 * mini-app's `groupClient` is never loaded so noble is never configured, and
 * this file silently becomes one provider talking to itself while every
 * assertion still passes — the exact shape of the bug it exists to catch.
 *
 * `vi.resetModules()` before the mobile import gives the mobile tree its own
 * registry, and the mobile `groupClient` is loaded FIRST so its
 * `configureMlsRuntime` lands on that instance. The `not.toBe` check in case 1
 * is the guard that this stays true.
 *
 * It also asserts what the server is allowed to hold: the stored object is
 * ciphertext, not the picture, and a non-member cannot fetch it at all.
 *
 * Requires the local stack (`./scripts/dev.sh`, never `docker compose`
 * directly) and runs under `vitest.config.e2e.ts`.
 *
 * A FRESH topic per run, deliberately: a reused room accumulates leaves from
 * earlier runs and the epoch-CAS conflicts that follow look exactly like a
 * defect in the code under test.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import * as gc from '@/lib/mls/groupClient';
import { MlsSessionStore, type MlsTransport, type SecureKVStore } from '@/lib/mls/mlsSession';
import { TakSessionStore, type TakTransport, type TakBundleRow, type ArchiveEntry } from '@/lib/mls/takSession';

/**
 * The MOBILE stack — same source, different crypto provider underneath, loaded
 * into a module registry of its own so that stays true (see the header).
 * `groupClient` first: loading it is what runs `configureMlsRuntime`, and the
 * session stores must be built on the instance it configured.
 */
async function loadMobileStack() {
  vi.resetModules();
  const mobileGc = await import('../../../packages/mobile/src/crypto/groupClient');
  const { MlsSessionStore: MobileMlsSessionStore } = await import(
    '../../../packages/mobile/src/crypto/mlsSession'
  );
  const { TakSessionStore: MobileTakSessionStore } = await import(
    '../../../packages/mobile/src/crypto/takSession'
  );
  return { mobileGc, MobileMlsSessionStore, MobileTakSessionStore };
}
import {
  CHAT_MEDIA_CONTENT_TYPE,
  MAX_CHAT_MEDIA_BYTES,
  MAX_CHAT_MEDIA_CIPHERTEXT_BYTES,
  buildChatMediaBody,
  chatMediaObjectKey,
  newMediaId,
  parseChatMediaBody,
} from '@/lib/chatMedia';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';

const WEB_DEVICE = 'e2e-web-device';
const MOBILE_DEVICE = 'e2e-mobile-device';

async function devLogin(prefix: string): Promise<{ token: string; userId: string }> {
  const nickname = `e2e_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const bearer = (token: string) => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });

/**
 * Join, and get through the door.
 *
 * A PRIVATE topic is invite-only: `POST /join` answers 403, and the request /
 * approve flow this helper used to drive no longer exists (I-1 removed it —
 * approving a request admits a member the inviter never handed keys to). The
 * way in is a SINGLE-USE token minted by the owner; the topic's fixed
 * `inviteCode` is deliberately refused for non-public tiers, so there is no
 * shortcut here that is not also a permanent skeleton key.
 */
async function joinByInvite(
  memberToken: string,
  ownerToken: string,
  topicId: string,
): Promise<void> {
  const direct = await fetch(`${BASE}/api/topics/${topicId}/join`, { method: 'POST', headers: bearer(memberToken) });
  if ([200, 201].includes(direct.status)) return; // public: straight in
  if (direct.status !== 403) throw new Error(`join failed: ${direct.status} ${await direct.text()}`);

  const minted = await fetch(`${BASE}/api/topics/${topicId}/invite`, {
    method: 'POST',
    headers: bearer(ownerToken),
    body: JSON.stringify({ expiresInHours: 1 }),
  });
  if (minted.status !== 201) throw new Error(`invite mint failed: ${minted.status} ${await minted.text()}`);
  const { token } = (await minted.json()) as { token: string };

  const joined = await fetch(`${BASE}/api/topics/join/${token}`, { method: 'POST', headers: bearer(memberToken) });
  if (joined.status !== 201) throw new Error(`invite join failed: ${joined.status} ${await joined.text()}`);
}

function httpMls(token: string): MlsTransport {
  const base = (t: string) => `${BASE}/api/topics/${t}/mls`;
  const h = bearer(token);
  return {
    async getGroupInfo(topicId) {
      const r = await fetch(`${base(topicId)}/group-info`, { headers: h });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`group-info GET ${r.status}`);
      return (await r.json()).groupInfo as string;
    },
    async postGroupInfo(topicId, groupInfoB64, groupIdB64) {
      const r = await fetch(`${base(topicId)}/group-info`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ groupInfo: groupInfoB64, groupId: groupIdB64 }),
      });
      if (!r.ok) throw new Error(`group-info POST ${r.status}`);
      return (await r.json()).created as boolean;
    },
    async postCommit(topicId, commitB64, groupInfoB64) {
      const r = await fetch(`${base(topicId)}/commit`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ commit: commitB64, groupInfo: groupInfoB64 }),
      });
      if (r.status === 409) return { ok: false };
      if (!r.ok) throw new Error(`commit POST ${r.status}`);
      return { ok: true, epoch: (await r.json()).epoch as number };
    },
    async getCommitsSince(topicId, sinceEpoch) {
      const r = await fetch(`${base(topicId)}/commit?sinceEpoch=${sinceEpoch}`, { headers: h });
      if (!r.ok) throw new Error(`commit GET ${r.status}`);
      return (await r.json()).commits;
    },
  };
}

function httpTak(token: string): TakTransport {
  const base = (t: string) => `${BASE}/api/topics/${t}`;
  const h = bearer(token);
  return {
    async postArchive(topicId, messageId, takVersion, archiveB64) {
      const r = await fetch(`${base(topicId)}/archive`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ messageId, takVersion, archive: archiveB64 }),
      });
      if (!r.ok && r.status !== 200) throw new Error(`archive POST ${r.status}`);
    },
    async getArchive(topicId) {
      const r = await fetch(`${base(topicId)}/archive?limit=500`, { headers: h });
      if (!r.ok) throw new Error(`archive GET ${r.status}`);
      return (await r.json()).archive as ArchiveEntry[];
    },
    async postBundle(topicId, recipientUserId, recipientDeviceId, bundleB64, scope) {
      const r = await fetch(`${base(topicId)}/tak/bundles`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ recipientUserId, recipientDeviceId, bundle: bundleB64, scope }),
      });
      if (!r.ok) throw new Error(`bundle POST ${r.status}`);
    },
    async getBundles(topicId, deviceId) {
      const r = await fetch(`${base(topicId)}/tak/bundles?deviceId=${encodeURIComponent(deviceId)}`, { headers: h });
      if (!r.ok) throw new Error(`bundle GET ${r.status}`);
      return (await r.json()).bundles as TakBundleRow[];
    },
    async ackBundles(topicId, deviceId, ids) {
      const r = await fetch(`${base(topicId)}/tak/bundles`, {
        method: 'DELETE',
        headers: h,
        body: JSON.stringify({ deviceId, ids }),
      });
      if (!r.ok) throw new Error(`bundle DELETE ${r.status}`);
    },
    async getServerRoot() {
      return null;
    },
    async putServerRoot() {
      return true;
    },
    async getRootFingerprint(topicId) {
      const r = await fetch(`${base(topicId)}/tak/root-fingerprint`, { headers: h });
      if (r.status === 400 || r.status === 404) return { fingerprint: null, archiveCount: 0 };
      if (!r.ok) throw new Error(`root-fingerprint GET ${r.status}`);
      return await r.json();
    },
    async setRootFingerprint(topicId, fingerprint) {
      const r = await fetch(`${base(topicId)}/tak/root-fingerprint`, {
        method: 'PUT',
        headers: h,
        body: JSON.stringify({ fingerprint }),
      });
      if (!r.ok) throw new Error(`root-fingerprint PUT ${r.status}`);
      return await r.json();
    },
  };
}

function memKv(): SecureKVStore {
  const m = new Map<string, string>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

/**
 * Upload ciphertext through the REAL route: RAW BYTES, id in the query string.
 *
 * Not `{ mediaId, ciphertext: '<base64>' }` any more. That framing spent a
 * third of the 10MB transport ceiling on base64's 4/3 expansion, which put the
 * advertised attachment cap out of reach — the boundary cases below are what
 * hold the new one honest against a running server rather than against
 * arithmetic.
 */
async function uploadRaw(
  token: string,
  topicId: string,
  mediaId: string,
  ct: Uint8Array,
  over: { contentType?: string } = {},
): Promise<Response> {
  return fetch(`${BASE}/api/topics/${topicId}/chat/media?mediaId=${encodeURIComponent(mediaId)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': over.contentType ?? CHAT_MEDIA_CONTENT_TYPE,
    },
    body: ct as unknown as BodyInit,
  });
}

async function uploadCiphertext(token: string, topicId: string, mediaId: string, ct: Uint8Array): Promise<string> {
  const r = await uploadRaw(token, topicId, mediaId, ct);
  if (!r.ok) throw new Error(`media POST ${r.status} ${await r.text()}`);
  return (await r.json()).key as string;
}

/** Fetch ciphertext back through the membership-gated route. Octets, not JSON. */
async function fetchCiphertext(token: string, topicId: string, key: string): Promise<Uint8Array> {
  const r = await fetch(`${BASE}/api/topics/${topicId}/chat/media?key=${encodeURIComponent(key)}`, {
    headers: bearer(token),
  });
  if (!r.ok) throw new Error(`media GET ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** A picture, as far as this test is concerned: PNG magic + a byte pattern. */
function picture(seed: number, size = 2048): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 8; i < size; i++) b[i] = (i * seed) % 256;
  return b;
}

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');

describe('encrypted attachments across web and mobile, against a real container', () => {
  let web: { token: string; userId: string };
  let mobile: { token: string; userId: string };
  let stranger: { token: string; userId: string };
  let topicId: string;
  let webMls: MlsSessionStore;
  let webTak: TakSessionStore;
  // Same TYPES as the web stores (one implementation), different INSTANCES of
  // the module — which is the whole point of this file.
  let mobileMls: MlsSessionStore;
  let mobileTak: TakSessionStore;
  let mobileGc: typeof gc;

  /** web → mobile, filled in by the first case and read by the second. */
  let fromWeb: { body: string; bytes: Uint8Array; ciphertext: Uint8Array; mediaId: string; takVersion: number };
  /**
   * Whether this environment can STORE an object at all.
   *
   * R2 credentials are GitHub Secrets, so a local stack has none and the upload
   * route answers 500. That is a real gap — encrypted media cannot be exercised
   * end to end on a developer machine — and it is reported rather than worked
   * around: where storage is unavailable the ciphertext is handed between the
   * two devices directly, so the CROSS-PROVIDER assertion (the thing that has
   * actually broken before) still runs for real.
   */
  let storageAvailable = false;

  beforeAll(async () => {
    const health = await fetch(`${BASE}/api/health`).catch(() => null);
    if (!health || !health.ok) throw new Error(`container not reachable at ${BASE} — start it with ./scripts/dev.sh`);

    web = await devLogin('web');
    mobile = await devLogin('mobile');
    stranger = await devLogin('stranger');

    const cats = await fetch(`${BASE}/api/categories`, { headers: bearer(web.token) });
    const categoryId = (await cats.json()).categories[0].id;
    const res = await fetch(`${BASE}/api/topics`, {
      method: 'POST',
      headers: bearer(web.token),
      // FRESH topic, private: the tier whose archive key the server may not hold.
      body: JSON.stringify({
        title: `E2E media ${Date.now()}`,
        description: 'two-device encrypted media',
        visibility: 'private',
        categoryId,
      }),
    });
    expect(res.status).toBe(201);
    topicId = (await res.json()).topic.id;

    await joinByInvite(mobile.token, web.token, topicId);

    webMls = new MlsSessionStore(httpMls(web.token), WEB_DEVICE, memKv());
    webTak = new TakSessionStore(webMls, httpTak(web.token), memKv());
    const mobileStack = await loadMobileStack();
    mobileGc = mobileStack.mobileGc;
    mobileMls = new mobileStack.MobileMlsSessionStore(httpMls(mobile.token), MOBILE_DEVICE, memKv());
    mobileTak = new mobileStack.MobileTakSessionStore(mobileMls, httpTak(mobile.token), memKv());

    // One probe, so every case knows whether the object store is usable.
    const probe = await uploadRaw(web.token, topicId, newMediaId(), new Uint8Array([1, 2, 3]));
    storageAvailable = probe.ok;
    if (!storageAvailable) {
      // eslint-disable-next-line no-console
      console.warn(
        `[e2e] object storage unavailable (${probe.status}) — the upload/fetch hop is skipped; ` +
          'cross-provider decryption still runs. See the report for the R2-in-local-dev gap.',
      );
    }
  });

  it('1. both devices are in one MLS group — web genesis, mobile external-commit join', async () => {
    /*
     * The guard on the guard, before anything else runs. The two devices are
     * only two providers while they are two MODULE INSTANCES; if they collapse,
     * every cross-provider assertion below compares a client against itself and
     * passes for free.
     */
    expect(
      mobileGc.sealMessage,
      'the mobile stack resolved to the web module — this file is no longer cross-provider',
    ).not.toBe(gc.sealMessage);
    expect(await mobileGc.ciphersuiteImpl()).not.toBe(await gc.ciphersuiteImpl());

    await webMls.seal(topicId, 'genesis'); // bootstraps the group at epoch 0
    await mobileMls.sync(topicId); // joins → epoch 1
    await webMls.sync(topicId); // web sees the mobile leaf

    const webEpoch = await webMls.readState(topicId, async (s) => gc.currentEpoch(s));
    expect(webEpoch).toBe(1);
  });

  it('2. WEB seals a picture — and what leaves the device is not the picture', async () => {
    const plain = picture(7);
    const mediaId = newMediaId();

    const sealed = await webTak.sealMedia(topicId, mediaId, plain, 'private');
    expect(sealed, 'the web device must hold a key it may seal under').not.toBeNull();

    // The property that matters wherever the bytes end up.
    expect(hex(sealed!.ciphertext)).not.toContain(hex(plain));
    expect(Array.from(sealed!.ciphertext.slice(0, 8)), 'PNG magic must not survive the seal').not.toEqual(
      Array.from(plain.slice(0, 8)),
    );
    expect(sealed!.ciphertext.length).toBe(plain.length + 28); // 12-byte nonce + 16-byte tag

    let key = chatMediaObjectKey(topicId, web.userId, mediaId);
    if (storageAvailable) {
      key = await uploadCiphertext(web.token, topicId, mediaId, sealed!.ciphertext);
      expect(key).toBe(chatMediaObjectKey(topicId, web.userId, mediaId));
      // Read it back through the real route: the server hands back what it was
      // given, and what it was given is ciphertext.
      const stored = await fetchCiphertext(web.token, topicId, key);
      expect(hex(stored)).toBe(hex(sealed!.ciphertext));
      expect(hex(stored)).not.toContain(hex(plain));
    }

    fromWeb = {
      body: buildChatMediaBody({
        v: 1,
        key,
        mediaId,
        takVersion: sealed!.takVersion,
        mime: 'image/png',
        size: plain.length,
      }),
      bytes: plain,
      ciphertext: sealed!.ciphertext,
      mediaId,
      takVersion: sealed!.takVersion,
    };
  });

  it('3. MOBILE opens the web device picture — byte for byte, on the OTHER provider', async () => {
    /*
     * The assertion this whole file exists for. `@noble/ciphers` on this side,
     * WebCrypto on the other, one AEAD key derived from the same TAK.
     */
    await mobileTak.ingestBundles(topicId).catch(() => {});
    const envelope = parseChatMediaBody(fromWeb.body);
    expect(envelope).not.toBeNull();

    const ct = storageAvailable
      ? await fetchCiphertext(mobile.token, topicId, envelope!.key)
      : fromWeb.ciphertext;
    const opened = await mobileTak.openMedia(topicId, envelope!.mediaId, envelope!.takVersion, ct, 'private');

    expect(opened.ok, `mobile could not open the web attachment: ${JSON.stringify(opened)}`).toBe(true);
    expect(hex((opened as { ok: true; bytes: Uint8Array }).bytes)).toBe(hex(fromWeb.bytes));
  });

  it('4. MOBILE seals a picture and WEB opens it — the reverse direction', async () => {
    const plain = picture(13, 4096);
    const mediaId = newMediaId();

    const sealed = await mobileTak.sealMedia(topicId, mediaId, plain, 'private');
    expect(sealed, 'the mobile device must hold a key it may seal under').not.toBeNull();

    let ct = sealed!.ciphertext;
    if (storageAvailable) {
      const key = await uploadCiphertext(mobile.token, topicId, mediaId, sealed!.ciphertext);
      ct = await fetchCiphertext(web.token, topicId, key);
    }
    const opened = await webTak.openMedia(topicId, mediaId, sealed!.takVersion, ct, 'private');

    expect(opened.ok, `web could not open the mobile attachment: ${JSON.stringify(opened)}`).toBe(true);
    expect(hex((opened as { ok: true; bytes: Uint8Array }).bytes)).toBe(hex(plain));
  });

  it('5. a NON-MEMBER cannot fetch the object at all', async () => {
    const envelope = parseChatMediaBody(fromWeb.body)!;
    const r = await fetch(`${BASE}/api/topics/${topicId}/chat/media?key=${encodeURIComponent(envelope.key)}`, {
      headers: bearer(stranger.token),
    });
    expect(r.status).toBe(403);
  });

  it('6. an unauthenticated caller cannot fetch it either', async () => {
    const envelope = parseChatMediaBody(fromWeb.body)!;
    const r = await fetch(`${BASE}/api/topics/${topicId}/chat/media?key=${encodeURIComponent(envelope.key)}`);
    expect(r.status).toBe(401);
  });

  it('8. TAMPERED ciphertext is a decrypt failure, not a picture and not a crash', async () => {
    /*
     * The property the AEAD exists for, exercised against real bytes from the
     * real store rather than a mocked `open` that was told to say no. One
     * flipped bit anywhere in the object and the tag no longer authenticates.
     *
     * It matters more with a binary transport than it did with base64: a body
     * that is not valid base64 used to be rejected by the decoder before the
     * AEAD ever saw it, which meant some corruption was caught by the encoding
     * rather than by the crypto. Every byte sequence is now a legal body, so
     * the AEAD is the only thing standing there.
     */
    const plain = picture(21, 1024);
    const mediaId = newMediaId();
    const sealed = await webTak.sealMedia(topicId, mediaId, plain, 'private');
    expect(sealed).not.toBeNull();

    const corrupted = new Uint8Array(sealed!.ciphertext.length);
    corrupted.set(sealed!.ciphertext);
    corrupted[corrupted.length - 1] ^= 0xff; // the tag
    corrupted[20] ^= 0x01; // and the body

    let ct: Uint8Array = corrupted;
    if (storageAvailable) {
      const key = await uploadCiphertext(web.token, topicId, mediaId, corrupted);
      ct = await fetchCiphertext(web.token, topicId, key);
      // The server stored what it was given, byte for byte — it cannot tell.
      expect(hex(ct)).toBe(hex(corrupted));
    }
    const opened = await webTak.openMedia(topicId, mediaId, sealed!.takVersion, ct, 'private');
    expect(opened.ok, 'tampered bytes must never open').toBe(false);
    expect((opened as { ok: false; reason: string }).reason).toBe('decrypt');
  });

  it('9. FRAMING: a JSON body is refused with 415 rather than stored as ciphertext', async () => {
    /*
     * There is exactly one shape. A stale client still POSTing
     * `{"mediaId":…,"ciphertext":"…"}` must be told so, not have its JSON
     * document written to storage as if it were ciphertext — an object that
     * would then fail to decrypt on every reader forever, with nothing
     * anywhere saying why.
     */
    const body = new TextEncoder().encode(JSON.stringify({ mediaId: newMediaId(), ciphertext: 'AQID' }));
    const r = await uploadRaw(web.token, topicId, newMediaId(), body, { contentType: 'application/json' });
    expect(r.status).toBe(415);
  });

  it('10. BOUNDARY: an empty body is 400, and says so', async () => {
    const r = await uploadRaw(web.token, topicId, newMediaId(), new Uint8Array(0));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/empty/i);
  });

  it('11. BOUNDARY: a malformed mediaId is 400 before any storage is touched', async () => {
    for (const mediaId of ['A'.repeat(32), 'abc', '../../etc']) {
      const r = await fetch(
        `${BASE}/api/topics/${topicId}/chat/media?mediaId=${encodeURIComponent(mediaId)}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${web.token}`, 'Content-Type': CHAT_MEDIA_CONTENT_TYPE },
          body: new Uint8Array([1, 2, 3]) as unknown as BodyInit,
        },
      );
      expect(r.status, mediaId).toBe(400);
    }
  });

  it('12. BOUNDARY: one byte over the ciphertext cap is 413, naming the REAL limit', async () => {
    /*
     * The regression this whole change is downstream of. The cap was a flat
     * 10MB while the transport refused anything over ~7.4MB, so a person was
     * promised a size they could not send and was then told `Body must be
     * JSON` — a sentence about syntax for a file whose only problem was its
     * size. Both the number and the sentence are asserted against a running
     * server, because arithmetic in a unit test is exactly what was right last
     * time while the product was wrong.
     */
    const over = new Uint8Array(MAX_CHAT_MEDIA_CIPHERTEXT_BYTES + 1);
    const r = await uploadRaw(web.token, topicId, newMediaId(), over);
    expect(r.status).toBe(413);
    const { error } = (await r.json()) as { error: string };
    expect(error).toMatch(/too large/i);
    expect(error).toContain(`${Math.floor(MAX_CHAT_MEDIA_BYTES / (1024 * 1024))}MB`);
  });

  it('13. BOUNDARY: an attachment AT the cap goes up and comes back byte-identical', async () => {
    /*
     * The number the composer promises, sent for real. This is the case that
     * could not pass before: at the old framing a cap-sized attachment weighed
     * ~1.34x on the wire and died in the body parser, which is why the cap had
     * to be derived down to ~7.1MB. With raw octets the same 10MB ceiling
     * carries ~9.5MB, and this proves it end to end rather than on paper.
     *
     * Skipped only where object storage is unavailable (R2 credentials are
     * GitHub Secrets, so a developer stack has none) — reported, never
     * silently passed.
     */
    if (!storageAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] skipped: object storage unavailable, see the storageAvailable probe');
      return;
    }
    const mediaId = newMediaId();
    const at = new Uint8Array(MAX_CHAT_MEDIA_BYTES + 28);
    // Not all zeroes: a store that dropped the body would return zeroes too.
    for (let i = 0; i < at.length; i += 997) at[i] = (i % 251) + 1;
    at[at.length - 1] = 0xfe;

    const key = await uploadCiphertext(web.token, topicId, mediaId, at);
    const back = await fetchCiphertext(web.token, topicId, key);
    expect(back.length).toBe(at.length);
    expect(hex(back)).toBe(hex(at));
  }, 120_000);

  it('14. CONTRACT: the read route answers OCTETS whatever the caller accepts', async () => {
    /*
     * The base64-in-JSON shape is gone rather than kept for compatibility.
     * `Accept: application/json` used to select it — and the agent SDK, which
     * sends no Accept at all, was reading the bytes of a JSON document as if
     * they were ciphertext.
     */
    const envelope = parseChatMediaBody(fromWeb.body)!;
    if (!storageAvailable) {
      // eslint-disable-next-line no-console
      console.warn('[e2e] skipped: object storage unavailable, see the storageAvailable probe');
      return;
    }
    for (const accept of ['application/json', 'application/octet-stream', '*/*']) {
      const r = await fetch(
        `${BASE}/api/topics/${topicId}/chat/media?key=${encodeURIComponent(envelope.key)}`,
        { headers: { Authorization: `Bearer ${web.token}`, Accept: accept } },
      );
      expect(r.status, accept).toBe(200);
      expect(r.headers.get('content-type'), accept).toContain(CHAT_MEDIA_CONTENT_TYPE);
      const bytes = new Uint8Array(await r.arrayBuffer());
      expect(hex(bytes), accept).toBe(hex(fromWeb.ciphertext));
    }
  });

  it('7. a member cannot reach ANOTHER topic object through this one', async () => {
    // The key travels inside a sealed body any member could have written, so
    // the route confines it to the topic in the URL.
    const foreign = chatMediaObjectKey('00000000-0000-4000-8000-0000000000ff', web.userId, newMediaId());
    const r = await fetch(`${BASE}/api/topics/${topicId}/chat/media?key=${encodeURIComponent(foreign)}`, {
      headers: bearer(web.token),
    });
    expect(r.status).toBe(400);
  });
});
