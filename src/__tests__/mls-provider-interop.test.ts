/**
 * Cross-provider MLS interop regression (P2-21).
 *
 * The mobile client (packages/mobile/src/crypto/groupClient) uses ts-mls's
 * `nobleCryptoProvider` (pure-JS @noble/ciphers AES-GCM); the web client
 * (src/lib/mls/groupClient) uses the default provider (crypto.subtle AES-GCM).
 * react-native-quick-crypto's subtle AES-GCM *encrypt* once produced ciphertext
 * standard WebCrypto could not decrypt, breaking mobile->web. This test locks
 * the fix: application messages must seal on one provider and open on the other
 * in BOTH directions, so a future provider/ciphersuite change can't silently
 * re-break cross-platform chat.
 */
import { describe, it, expect } from 'vitest';
import * as web from '@/lib/mls/groupClient';
import * as mob from '../../packages/mobile/src/crypto/groupClient';

describe('MLS cross-provider interop (noble mobile <-> subtle web)', () => {
  it('seals on each provider and opens on the other, both directions + UTF-8', async () => {
    const topic = 'provider-interop-test';

    // MOBILE (noble) genesis; WEB (subtle) joins via External Commit.
    const mDev = await mob.createDevice('mobile-noble');
    const gen = await mob.createTopicGroup(topic, mDev);
    let mState = gen.state;

    const wDev = await web.createDevice('web-subtle');
    const wJoin = await web.joinTopicGroup(wDev, gen.groupInfoB64);
    let wState = wJoin.state;
    mState = await mob.processCommit(mState, wJoin.commitB64);

    expect(mob.currentEpoch(mState)).toBe(web.currentEpoch(wState));

    // MOBILE(noble) -> WEB(subtle)
    const m1 = await mob.sealMessage(mState, 'from-mobile-noble');
    mState = m1.state;
    const w1 = await web.openMessage(wState, m1.sealed);
    wState = w1.state;
    expect(w1.kind).toBe('message');
    expect(w1.kind === 'message' && w1.plaintext).toBe('from-mobile-noble');

    // WEB(subtle) -> MOBILE(noble)
    const w2 = await web.sealMessage(wState, 'from-web-subtle');
    wState = w2.state;
    const m2 = await mob.openMessage(mState, w2.sealed);
    mState = m2.state;
    expect(m2.kind).toBe('message');
    expect(m2.kind === 'message' && m2.plaintext).toBe('from-web-subtle');

    // UTF-8 round-trip MOBILE(noble) -> WEB(subtle)
    const utf = '한글-이모지-😀-mobile';
    const m3 = await mob.sealMessage(mState, utf);
    mState = m3.state;
    const w3 = await web.openMessage(wState, m3.sealed);
    expect(w3.kind === 'message' && w3.plaintext).toBe(utf);
  });
});
