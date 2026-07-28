/**
 * Channel E2E against a REAL running OpenStoa container (default
 * http://localhost:3200). Two SDK ChatClients drive the portable MLS core over
 * the live REST Delivery Service — no mocks. Proves the channel CORE does a real
 * E2EE round-trip:
 *   - agent A sends THROUGH OpenStoaChannel.send (seal locally → post ciphertext);
 *   - agent B receives it THROUGH OpenStoaChannel.poll (fetch ciphertext →
 *     decrypt locally → normalized InboundMessage) with text intact;
 *   - SI-1: the server persisted ONLY opaque ciphertext, never plaintext.
 *
 * Uses /api/auth/dev-login (self-contained; APP_ENV!=production). The channel
 * core takes any authenticated ChatClient, so we drive it with dev-login tokens
 * here (the production factory requires a scoped osk_ key — see factory.test.ts).
 *
 * Run: `E2E_BASE_URL=http://localhost:3200 npx vitest run src/__tests__/e2e`
 * from packages/channel (the container must already be up — `./scripts/dev.sh`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatClient } from '@masselabs/openstoa';
import { OpenStoaChannel, type InboundMessage } from '../../channel';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';

let rootA: string;
let rootB: string;
let a: ChatClient;
let b: ChatClient;
let channelA: OpenStoaChannel;
let channelB: OpenStoaChannel;
let topicId: string;

describe.sequential('OpenStoaChannel E2EE round-trip (real container)', () => {
  beforeAll(async () => {
    const health = await fetch(`${BASE}/api/health`).catch(() => null);
    if (!health || !health.ok) throw new Error(`container not reachable at ${BASE} — start it first (./scripts/dev.sh)`);

    rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-e2e-a-'));
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-e2e-b-'));

    a = new ChatClient({ baseUrl: BASE, vaultRoot: rootA, deviceId: `channel-e2e-a-${Date.now()}` });
    b = new ChatClient({ baseUrl: BASE, vaultRoot: rootB, deviceId: `channel-e2e-b-${Date.now()}` });

    await a.login(`channel_e2e_a_${Date.now().toString(36)}`);
    await b.login(`channel_e2e_b_${Date.now().toString(36)}`);

    const categories = await a.rest.categories.list();
    const categoryId = categories[0]?.id;
    const topic = await a.rest.topics.create({
      title: `Channel E2EE ${Date.now()}`,
      description: 'channel e2e',
      visibility: 'public',
      categoryId,
    });
    topicId = topic.id;

    channelA = new OpenStoaChannel({ chat: a, logger: () => {} });
    channelB = new OpenStoaChannel({ chat: b, logger: () => {} });
  });

  afterAll(async () => {
    channelA?.stop();
    channelB?.stop();
    if (rootA) await fs.rm(rootA, { recursive: true, force: true });
    if (rootB) await fs.rm(rootB, { recursive: true, force: true });
  });

  it('both agents subscribe (join + MLS self-join) to the topic channel', async () => {
    await channelA.subscribeTopic(topicId); // creator → MLS genesis
    await channelB.subscribeTopic(topicId); // REST membership + External Commit
    expect(channelA.subscriptions().map((s) => s.topicId)).toContain(topicId);
    expect(channelB.subscriptions().map((s) => s.topicId)).toContain(topicId);
  });

  it('A sends through the channel → B receives a decrypted, normalized inbound message', async () => {
    const plaintext = `channel round-trip — 안녕 🔐 %_\\ <b>hi</b> ${Date.now()}`;
    const { messageId } = await channelA.send(topicId, plaintext);
    expect(messageId).toBeTruthy();

    const inbound: InboundMessage[] = await channelB.poll(topicId);
    const mine = inbound.find((m) => m.messageId === messageId);
    expect(mine).toBeTruthy();
    expect(mine?.text).toBe(plaintext); // hostile/UTF-8 content intact through seal→open
    expect(mine?.kind).toBe('topic');
    expect(mine?.channelId).toBe(`topic:${topicId}`);
  });

  it('dedup: polling again does NOT re-emit the same message', async () => {
    const before = await channelB.poll(topicId); // drains any remaining
    const again = await channelB.poll(topicId);
    // A second immediate poll yields nothing new (cursor + seen-set dedup).
    expect(again).toEqual([]);
    expect(Array.isArray(before)).toBe(true);
  });

  it('SI-1: the server persisted only ciphertext, and rejects a plaintext body', async () => {
    const plaintext = `si1-channel-${Date.now()}`;
    const { messageId } = await channelA.send(topicId, plaintext);

    const { messages } = await a.rest.chat.history(topicId, { limit: 200 });
    const row = messages.find((m) => m.id === messageId);
    expect(row?.sealed).toBeTruthy();
    expect(row?.message).toBeNull();
    const decoded = Buffer.from(row!.sealed!.ciphertext, 'base64').toString('utf8');
    expect(decoded).not.toContain(plaintext);

    await expect(
      a.rest.request(`/api/topics/${topicId}/chat`, { method: 'POST', body: { message: 'plaintext!' } }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
