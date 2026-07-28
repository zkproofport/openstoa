/**
 * SDK chat E2E against a REAL running OpenStoa container (default
 * http://localhost:3200). Two SDK ChatClients drive the portable MLS core over
 * the live REST Delivery Service — no mocks. Proves:
 *   - E2EE round-trip: agent A sendChat → agent B readChat decrypts it;
 *   - SI-1: the server persisted ONLY opaque ciphertext (never plaintext), and
 *     rejects a plaintext chat body with 400.
 *
 * Uses /api/auth/dev-login (self-contained; available when APP_ENV!=production).
 * Run: `E2E_BASE_URL=http://localhost:3200 npx vitest run src/__tests__/e2e`
 * from packages/sdk (the container must already be up — `./scripts/dev.sh`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatClient } from '../../chatClient';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';

let rootA: string;
let rootB: string;
let a: ChatClient;
let b: ChatClient;
let topicId: string;

describe.sequential('SDK E2EE chat (real container)', () => {
  beforeAll(async () => {
    const health = await fetch(`${BASE}/api/health`).catch(() => null);
    if (!health || !health.ok) throw new Error(`container not reachable at ${BASE} — start it first (./scripts/dev.sh)`);

    rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-e2e-a-'));
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-e2e-b-'));

    a = new ChatClient({ baseUrl: BASE, vaultRoot: rootA, deviceId: `sdk-e2e-a-${Date.now()}` });
    b = new ChatClient({ baseUrl: BASE, vaultRoot: rootB, deviceId: `sdk-e2e-b-${Date.now()}` });

    await a.login(`sdk_e2e_a_${Date.now().toString(36)}`);
    await b.login(`sdk_e2e_b_${Date.now().toString(36)}`);

    const categories = await a.rest.categories.list();
    const categoryId = categories[0]?.id;
    const topic = await a.rest.topics.create({
      title: `SDK E2EE chat ${Date.now()}`,
      description: 'sdk e2e',
      visibility: 'public',
      categoryId,
    });
    topicId = topic.id;
  });

  afterAll(async () => {
    if (rootA) await fs.rm(rootA, { recursive: true, force: true });
    if (rootB) await fs.rm(rootB, { recursive: true, force: true });
  });

  it('A joins (genesis) and B joins (External Commit)', async () => {
    await a.joinTopic(topicId); // creator is auto-member; MLS genesis
    await b.joinTopic(topicId); // REST membership + MLS self-join
    const devA = await a.getDeviceId();
    const devB = await b.getDeviceId();
    expect(devA).not.toBe(devB);
  });

  it('round-trip: A sendChat → B readChat decrypts the plaintext', async () => {
    const plaintext = `hello from SDK agent A — 안녕 🔐 ${Date.now()}`;
    const msgId = await a.sendChat(topicId, plaintext);
    expect(msgId).toBeTruthy();

    const history = await b.readChat(topicId);
    const mine = history.find((h) => h.id === msgId);
    expect(mine).toBeTruthy();
    expect(mine?.text).toBe(plaintext);
  });

  it('SI-1: the server persisted only ciphertext, and rejects a plaintext body', async () => {
    const plaintext = `si1-probe-${Date.now()}`;
    const msgId = await a.sendChat(topicId, plaintext);

    // What the server returns for this row is a sealed MLS body, not plaintext.
    const { messages } = await a.rest.chat.history(topicId, { limit: 200 });
    const row = messages.find((m) => m.id === msgId);
    expect(row?.sealed).toBeTruthy();
    expect(row?.message).toBeNull(); // no plaintext field for user messages
    const decoded = Buffer.from(row!.sealed!.ciphertext, 'base64').toString('utf8');
    expect(decoded).not.toContain(plaintext);
    expect(row!.sealed!.ciphertext).not.toContain(plaintext);

    // The server MUST reject a plaintext chat body outright.
    await expect(
      a.rest.request(`/api/topics/${topicId}/chat`, { method: 'POST', body: { message: 'plaintext!' } }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
