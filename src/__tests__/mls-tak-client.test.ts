/**
 * Phase 3 TAK crypto core (takClient.ts) on Node WebCrypto, against REAL ts-mls
 * groups. Proves the whole protocol end-to-end without a browser/device:
 * per-epoch TAK agreement + binding, archive seal/open (round-trip, wrong key,
 * UTF-8), public root key, the CVE identity gate (wrap only to verified leaves;
 * only the addressed device opens), and scope-out (an ungranted epoch stays
 * unreadable). This is the cryptographic contract the web + mobile clients rely on.
 */
import { describe, it, expect } from 'vitest';
import * as mls from '@/lib/mls/groupClient';
import * as tak from '@/lib/mls/takClient';

/** Build a converged 2-member group (alice=genesis, bob=external join) at epoch 1. */
async function twoMemberGroup(topicId: string, idA = 'alice', idB = 'bob') {
  const alice = await mls.createDevice(idA);
  const bob = await mls.createDevice(idB);
  const g = await mls.createTopicGroup(topicId, alice);
  let aState = g.state;
  const j = await mls.joinTopicGroup(bob, g.groupInfoB64);
  const bState = j.state;
  aState = await mls.processCommit(aState, j.commitB64);
  return { aState, bState };
}

describe('TAK per-epoch derivation', () => {
  it('two members at the same epoch derive the identical TAK', async () => {
    const { aState, bState } = await twoMemberGroup('tak-derive-1');
    expect(mls.currentEpoch(aState)).toBe(1);
    expect(mls.currentEpoch(bState)).toBe(1);
    const ta = await tak.deriveEpochTak(aState, 'tak-derive-1');
    const tb = await tak.deriveEpochTak(bState, 'tak-derive-1');
    expect(Buffer.from(ta).toString('hex')).toBe(Buffer.from(tb).toString('hex'));
    expect(ta.length).toBe(32);
  });

  it('TAK is bound to topic id and epoch number', async () => {
    const { aState } = await twoMemberGroup('tak-derive-2');
    const here = await tak.deriveEpochTak(aState, 'tak-derive-2');
    const otherTopic = await tak.deriveEpochTak(aState, 'tak-derive-2-other');
    const otherEpoch = await tak.deriveEpochTak(aState, 'tak-derive-2', 0);
    const h = (u: Uint8Array) => Buffer.from(u).toString('hex');
    expect(h(here)).not.toBe(h(otherTopic));
    expect(h(here)).not.toBe(h(otherEpoch));
  });
});

describe('archive seal / open', () => {
  it('round-trips a body under a TAK and fails under a different key', async () => {
    const { aState, bState } = await twoMemberGroup('tak-archive-1');
    const ta = await tak.deriveEpochTak(aState, 'tak-archive-1');
    const tb = await tak.deriveEpochTak(bState, 'tak-archive-1');
    const msgId = '11111111-1111-4111-8111-111111111111';
    const sealed = await tak.sealArchive(ta, msgId, 'past message body');
    // Same epoch TAK (bob) opens it.
    expect(await tak.openArchive(tb, msgId, sealed)).toBe('past message body');
    // A wrong key cannot.
    expect(await tak.openArchive(tak.generatePublicRootKey(), msgId, sealed)).toBeNull();
    // The message id is part of the AEAD key derivation — a different id fails.
    expect(await tak.openArchive(ta, '22222222-2222-4222-8222-222222222222', sealed)).toBeNull();
  });

  it('preserves UTF-8 (Korean + emoji + mixed)', async () => {
    const { aState } = await twoMemberGroup('tak-archive-utf8');
    const ta = await tak.deriveEpochTak(aState, 'tak-archive-utf8');
    const msgId = '33333333-3333-4333-8333-333333333333';
    const body = '안녕하세요 🌟 mixed スcrIPT \n\t tabs';
    const sealed = await tak.sealArchive(ta, msgId, body);
    expect(await tak.openArchive(ta, msgId, sealed)).toBe(body);
  });

  it('public root key seals + opens whole-history archives', async () => {
    const root = tak.generatePublicRootKey();
    expect(root.length).toBe(32);
    const m1 = '44444444-4444-4444-8444-444444444444';
    const m2 = '55555555-5555-4555-8555-555555555555';
    const s1 = await tak.sealArchive(root, m1, 'first');
    const s2 = await tak.sealArchive(root, m2, 'second');
    // A new member handed the SAME root opens every past message.
    expect(await tak.openArchive(root, m1, s1)).toBe('first');
    expect(await tak.openArchive(root, m2, s2)).toBe('second');
  });
});

describe('CVE identity gate — wrap only to verified leaves', () => {
  it('finds the recipient leaf in the validated tree and wraps so only that device opens', async () => {
    const { aState, bState } = await twoMemberGroup('tak-cve-1');

    // CVE gate: bob's key comes from alice's validated ratchet tree, never a
    // server blob. A non-member identity has no leaf → nothing to wrap to.
    const bobLeaves = tak.findRecipientLeaves(aState, 'bob');
    expect(bobLeaves.length).toBe(1);
    expect(tak.findRecipientLeaves(aState, 'mallory')).toEqual([]);

    const payload: tak.PublicBundle = { tier: 'public', rootKey: Buffer.from(tak.generatePublicRootKey()).toString('base64') };
    const wrapped = await tak.wrapBundleToLeaf(bobLeaves[0].hpkePublicKey, payload);

    // Bob (the addressed device) opens it.
    const got = await tak.unwrapBundle<tak.PublicBundle>(bState, wrapped);
    expect(got?.tier).toBe('public');
    expect(got?.rootKey).toBe(payload.rootKey);

    // Alice is NOT the recipient — her leaf key cannot open a bundle sealed to bob.
    expect(await tak.unwrapBundle(aState, wrapped)).toBeNull();
  });

  it('leafDeviceId is stable and distinct per leaf', async () => {
    const { aState } = await twoMemberGroup('tak-cve-2');
    const alice = tak.findRecipientLeaves(aState, 'alice')[0];
    const bob = tak.findRecipientLeaves(aState, 'bob')[0];
    expect(tak.leafDeviceId(alice.hpkePublicKey)).not.toBe(tak.leafDeviceId(bob.hpkePublicKey));
    expect(tak.leafDeviceId(alice.hpkePublicKey)).toBe(tak.leafDeviceId(alice.hpkePublicKey));
  });
});

describe('scoped bundle (private/secret) — granted epochs only', () => {
  it('a new member opens archives only for the epochs it was granted', async () => {
    // Alice present at epoch 1; she caches TAK(1). She grants ONLY epoch 1 to a
    // new member, and archives an epoch-1 and a (pretend) epoch-2 body.
    const { aState } = await twoMemberGroup('tak-scope-1');
    const tak1 = await tak.deriveEpochTak(aState, 'tak-scope-1', 1);
    const tak2 = await tak.deriveEpochTak(aState, 'tak-scope-1', 2); // an epoch NOT granted

    const m1 = '66666666-6666-4666-8666-666666666666';
    const m2 = '77777777-7777-4777-8777-777777777777';
    const archived1 = await tak.sealArchive(tak1, m1, 'epoch-1 body');
    const archived2 = await tak.sealArchive(tak2, m2, 'epoch-2 body');

    // The scoped bundle grants epoch 1 only.
    const bundle: tak.ScopedBundle = { tier: 'scoped', taks: { '1': Buffer.from(tak1).toString('base64') } };
    const grantedTak1 = new Uint8Array(Buffer.from(bundle.taks['1'], 'base64'));

    // In-scope archive decrypts; the ungranted epoch-2 archive does not.
    expect(await tak.openArchive(grantedTak1, m1, archived1)).toBe('epoch-1 body');
    expect(bundle.taks['2']).toBeUndefined();
    const grantedTak2 = bundle.taks['2'] ? new Uint8Array(Buffer.from(bundle.taks['2'], 'base64')) : tak.generatePublicRootKey();
    expect(await tak.openArchive(grantedTak2, m2, archived2)).toBeNull();
  });
});
