/**
 * Integration test for the portable MLS group-lifecycle client (groupClient.ts).
 * Runs ts-mls on Node's WebCrypto — proves genesis + self-service External
 * Commit join + multi-member convergence + bidirectional E2EE + forward
 * secrecy, the exact flow the web + mobile clients perform against the DS.
 */
import { describe, it, expect } from 'vitest';
import * as mls from '@/lib/mls/groupClient';

describe('MLS groupClient — genesis, external join, E2EE', () => {
  it('two devices: genesis → external join → bidirectional E2EE, epochs synced', async () => {
    const alice = await mls.createDevice('alice');
    const bob = await mls.createDevice('bob');

    const g = await mls.createTopicGroup('topic-1', alice);
    let aliceState = g.state;
    expect(mls.currentEpoch(aliceState)).toBe(0);

    const j = await mls.joinTopicGroup(bob, g.groupInfoB64);
    let bobState = j.state;
    expect(mls.currentEpoch(bobState)).toBe(1);

    // Alice applies Bob's External Commit (the DS would fan this out / serve via catch-up).
    aliceState = await mls.processCommit(aliceState, j.commitB64);
    expect(mls.currentEpoch(aliceState)).toBe(1);

    const s1 = await mls.sealMessage(aliceState, 'hi-bob');
    aliceState = s1.state;
    expect(s1.sealed.epoch).toBe(1);
    const o1 = await mls.openMessage(bobState, s1.sealed);
    bobState = o1.state;
    expect(o1).toMatchObject({ kind: 'message', plaintext: 'hi-bob' });

    const s2 = await mls.sealMessage(bobState, 'hi-alice');
    bobState = s2.state;
    const o2 = await mls.openMessage(aliceState, s2.sealed);
    expect(o2).toMatchObject({ kind: 'message', plaintext: 'hi-alice' });
  });

  it('three devices converge on epoch 2 and all read a member message', async () => {
    const alice = await mls.createDevice('alice');
    const bob = await mls.createDevice('bob');
    const carol = await mls.createDevice('carol');

    const g = await mls.createTopicGroup('topic-2', alice);
    let aState = g.state;
    const j1 = await mls.joinTopicGroup(bob, g.groupInfoB64);
    let bState = j1.state;
    aState = await mls.processCommit(aState, j1.commitB64);

    // Carol joins using the GroupInfo refreshed by Bob's join.
    const j2 = await mls.joinTopicGroup(carol, j1.groupInfoB64);
    const cState = j2.state;
    aState = await mls.processCommit(aState, j2.commitB64);
    bState = await mls.processCommit(bState, j2.commitB64);

    expect(mls.currentEpoch(aState)).toBe(2);
    expect(mls.currentEpoch(bState)).toBe(2);
    expect(mls.currentEpoch(cState)).toBe(2);

    const s = await mls.sealMessage(cState, 'hello-all');
    const oa = await mls.openMessage(aState, s.sealed);
    const ob = await mls.openMessage(bState, s.sealed);
    expect(oa).toMatchObject({ kind: 'message', plaintext: 'hello-all' });
    expect(ob).toMatchObject({ kind: 'message', plaintext: 'hello-all' });
  });

  it('forward secrecy: a device cannot open a message from an epoch before it joined', async () => {
    const alice = await mls.createDevice('alice');
    const bob = await mls.createDevice('bob');
    const carol = await mls.createDevice('carol');

    const g = await mls.createTopicGroup('topic-3', alice);
    let aState = g.state;
    const j1 = await mls.joinTopicGroup(bob, g.groupInfoB64);
    aState = await mls.processCommit(aState, j1.commitB64);

    // Alice sends at epoch 1 (only alice+bob are members).
    const secret = await mls.sealMessage(aState, 'pre-join-secret');
    expect(secret.sealed.epoch).toBe(1);

    // Carol joins at epoch 2 and must NOT be able to open the epoch-1 message.
    const j2 = await mls.joinTopicGroup(carol, j1.groupInfoB64);
    const cState = j2.state;
    await expect(mls.openMessage(cState, secret.sealed)).rejects.toThrow();
  });
});
