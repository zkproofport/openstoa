/**
 * Mobile AES-GCM host-independence regression.
 *
 * On Hermes `crypto.subtle` is react-native-quick-crypto, whose AES-GCM
 * *encrypt* produces ciphertext standard WebCrypto cannot decrypt (documented
 * on-device finding). ts-mls's `nobleCryptoProvider` only replaces the MLS
 * application-message AEAD — HPKE (Commit UpdatePath secrets, Welcome, and
 * every TAK bundle sealed via `cs.hpke.seal`) is built on @hpke/core's
 * `Aes128Gcm`, which calls `crypto.subtle` directly. A mobile-produced External
 * Commit therefore carried a path secret other members could not HPKE-open:
 * their processCommit threw → catchUp threw → every later mobile message
 * rendered "[unable to decrypt]" for them, one direction only.
 *
 * INVARIANT LOCKED HERE: no AES-GCM operation performed by the mobile MLS
 * client may reach the host's WebCrypto. The probe below wraps crypto.subtle
 * BEFORE the mobile client installs its interop shim, so it observes only the
 * calls that actually fall through to the platform.
 *
 * Also covers the direction the pre-existing cross-provider test never did:
 * WEB processing a MOBILE-produced External Commit.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as mob from '../../packages/mobile/src/crypto/groupClient';
import * as web from '@/lib/mls/groupClient';

const hostCalls: string[] = [];

beforeAll(() => {
  // Installed FIRST → the mobile client's shim wraps this one, so anything
  // recorded here genuinely reached the host WebCrypto.
  const sc = globalThis.crypto.subtle as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const op of ['encrypt', 'decrypt'] as const) {
    const orig = sc[op].bind(globalThis.crypto.subtle);
    sc[op] = (...args: unknown[]) => {
      const a = args[0] as { name?: string } | string;
      hostCalls.push(`${op}:${typeof a === 'string' ? a : (a?.name ?? '?')}`);
      return orig(...args);
    };
  }
});

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('mobile MLS client keeps AES-GCM off the host WebCrypto', () => {
  it('full lifecycle + web<->mobile interop, with zero host AES-GCM', async () => {
    const topic = 'aesgcm-interop';

    // Initialize the mobile ciphersuite first (this is where the interop shim
    // installs), then ignore anything before it — the invariant is about what
    // happens once the mobile client is live.
    await mob.ciphersuiteImpl();
    hostCalls.length = 0;

    // WEB is genesis; MOBILE joins via External Commit (the mobile-produced
    // Commit path the old interop test never exercised).
    const wDev = await web.createDevice('web-founder');
    const genesis = await web.createTopicGroup(topic, wDev);
    let wState = genesis.state;

    const mDev = await mob.createDevice('mobile-joiner');
    const mJoin = await mob.joinTopicGroup(mDev, genesis.groupInfoB64);
    let mState = mJoin.state;

    // Producing an External Commit HPKE-seals an UpdatePath secret. Before the
    // interop shim this call alone leaked one AES-GCM encrypt to the host.
    expect(
      hostCalls.filter((c) => c.endsWith(':AES-GCM')),
      'mobile External Commit leaked AES-GCM to the host WebCrypto',
    ).toEqual([]);

    // The existing member must be able to process the mobile's External Commit
    // (HPKE-open the UpdatePath secret the mobile sealed).
    wState = await web.processCommit(wState, mJoin.commitB64);
    expect(web.currentEpoch(wState)).toBe(mob.currentEpoch(mState));

    // MOBILE -> WEB application message (incl. UTF-8).
    const m1 = await mob.sealMessage(mState, '모바일에서 보냄 😀');
    mState = m1.state;
    const w1 = await web.openMessage(wState, m1.sealed);
    wState = w1.state;
    expect(w1.kind === 'message' && w1.plaintext).toBe('모바일에서 보냄 😀');

    // WEB -> MOBILE application message.
    const w2 = await web.sealMessage(wState, 'from-web');
    wState = w2.state;
    const m2 = await mob.openMessage(mState, w2.sealed);
    mState = m2.state;
    expect(m2.kind === 'message' && m2.plaintext).toBe('from-web');

    // TAK layer: a bundle HPKE-sealed on MOBILE must open on WEB. This is how
    // archived history reaches later joiners (takClient.wrapBundleToLeaf).
    const wcs = await web.ciphersuiteImpl();
    const mcs = await mob.ciphersuiteImpl();
    const kp = await wcs.hpke.generateKeyPair();
    const pubBytes = await wcs.hpke.exportPublicKey(kp.publicKey);
    const info = enc.encode('openstoa:tak');
    const sealedBundle = await mcs.hpke.seal(await mcs.hpke.importPublicKey(pubBytes), enc.encode('tak-secret'), info);
    const openedBundle = await wcs.hpke.open(kp.privateKey, sealedBundle.enc, sealedBundle.ct, info);
    expect(dec.decode(openedBundle)).toBe('tak-secret');

    // THE INVARIANT: nothing above may have used the host's AES-GCM.
    const hostAesGcm = hostCalls.filter((c) => c.endsWith(':AES-GCM'));
    expect(hostAesGcm, `mobile client leaked AES-GCM to host WebCrypto: ${hostAesGcm.join(', ')}`).toEqual([]);
    expect(mob.aesGcmInteropInstalled()).toBe(true);
  }, 60_000);
});
