/**
 * DM (1:1 direct chat) E2E against a REAL running OpenStoa container
 * (default http://localhost:3200). Exercises the P-D edge-case matrix end to end
 * over live HTTP — no mocks:
 *   - idempotency: startDm twice, either order → the SAME topicId;
 *   - E2EE round-trip: agent A sendChat over the DM → agent B readChat decrypts;
 *   - SI-1: the server persisted only ciphertext; GET /api/dm exposes no content;
 *   - listing exclusion: the DM topic never appears in GET /api/topics;
 *   - authz: a third user can't read the DM chat (403);
 *   - boundary: DM-with-self → 400, DM to a non-existent user → 404;
 *   - human↔AI: an isAI api-key with chat caps completes a DM round-trip, and an
 *     out-of-capability key is rejected (403) at POST /api/dm.
 *
 * Uses /api/auth/dev-login + /api/profile/api-keys (self-contained; available
 * when APP_ENV!=production). Run from packages/sdk with the container up:
 *   E2E_BASE_URL=http://localhost:3200 npx vitest run src/__tests__/e2e/dm.e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatClient } from '../../chatClient';
import { OpenStoaClient, OpenStoaApiError } from '../../rest/openStoaClient';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';
const roots: string[] = [];

async function newClient(prefix: string): Promise<{ chat: ChatClient; root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `dm-e2e-${prefix}-`));
  roots.push(root);
  const chat = new ChatClient({ baseUrl: BASE, vaultRoot: root, deviceId: `dm-e2e-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
  return { chat, root };
}

let a: ChatClient;
let b: ChatClient;
let c: ChatClient;
let aUserId: string;
let bUserId: string;
let dmTopicId: string;

describe.sequential('DM 1:1 direct chat (real container)', () => {
  beforeAll(async () => {
    const health = await fetch(`${BASE}/api/health`).catch(() => null);
    if (!health || !health.ok) throw new Error(`container not reachable at ${BASE} — start it first (./scripts/dev.sh)`);

    a = (await newClient('a')).chat;
    b = (await newClient('b')).chat;
    c = (await newClient('c')).chat;

    const la = await a.login(`dm_a_${Date.now().toString(36)}`);
    const lb = await b.login(`dm_b_${Date.now().toString(36)}`);
    await c.login(`dm_c_${Date.now().toString(36)}`);
    aUserId = la.userId;
    bUserId = lb.userId;
  });

  afterAll(async () => {
    for (const r of roots) await fs.rm(r, { recursive: true, force: true });
  });

  it('startDm is idempotent — either party, either order → the SAME topicId', async () => {
    const t1 = await a.startDm(bUserId); // A creates + MLS genesis
    const t2 = await b.startDm(aUserId); // B gets the same channel + External-Commit join
    const t3 = await a.startDm(bUserId); // repeat from A
    expect(t2).toBe(t1);
    expect(t3).toBe(t1);
    dmTopicId = t1;
  });

  it('E2EE round-trip: A sendChat → B readChat decrypts the plaintext', async () => {
    const plaintext = `dm from A — 안녕 🔐 ${Date.now()}`;
    const msgId = await a.sendChat(dmTopicId, plaintext);
    expect(msgId).toBeTruthy();
    const history = await b.readChat(dmTopicId);
    expect(history.find((h) => h.id === msgId)?.text).toBe(plaintext);
  });

  it('E2EE round-trip, LATE joiner: C reads a message sent before its device existed', async () => {
    /*
     * The case above decrypts on a device that was already in the room, which is
     * the ONE arrangement in which no key has to travel — and it passed for the
     * whole time DMs were undecryptable everywhere else. The archive key was
     * sealed per MLS epoch while the tier table declared one root, and nothing
     * ever handed it over.
     *
     * So this file also owns one case where the reader joined LATE. The full
     * matrix — the sender's own second device, both directions, the mint race,
     * the server's refusal to hold the key — is in `dm-keys.e2e.test.ts`.
     */
    const late = (await newClient('late')).chat;
    const lateUserId = (await late.login(`dm_late_${Date.now().toString(36)}`)).userId;

    const topicId = await a.startDm(lateUserId);
    const plaintext = `sent before you opened this — ${Date.now()}`;
    const msgId = await a.sendChat(topicId, plaintext);

    // Only now does the recipient's device exist in the group.
    expect(await late.startDm(aUserId)).toBe(topicId);
    // A device that holds the key has to be online once after that; in the apps
    // this is the `key-needed` fan-out, here it is A's own next read.
    await a.readChat(topicId);

    const history = await late.backfill(topicId);
    expect(history.find((h) => h.messageId === msgId)?.plaintext).toBe(plaintext);
  }, 180_000);

  it('SI-1: the server stored only ciphertext, and GET /api/dm exposes no message content', async () => {
    const plaintext = `dm-si1-${Date.now()}`;
    const msgId = await a.sendChat(dmTopicId, plaintext);
    const { messages } = await a.rest.chat.history(dmTopicId, { limit: 200 });
    const row = messages.find((m) => m.id === msgId);
    expect(row?.sealed).toBeTruthy();
    expect(row?.message).toBeNull();
    expect(Buffer.from(row!.sealed!.ciphertext, 'base64').toString('utf8')).not.toContain(plaintext);

    // The DM list carries routing metadata only — never a body/preview.
    const dms = await b.listDms();
    const ch = dms.find((d) => d.topicId === dmTopicId);
    expect(ch?.peer.userId).toBe(aUserId);
    expect(JSON.stringify(dms)).not.toMatch(/ciphertext|sealed|preview/i);
  });

  it('the DM topic never appears in GET /api/topics (member list or view=all)', async () => {
    const memberList = await a.rest.topics.list();
    expect(memberList.some((t) => t.id === dmTopicId)).toBe(false);
    const all = (await a.rest.request<{ topics: Array<{ id: string }> }>('/api/topics', { query: { view: 'all' } })).topics;
    expect(all.some((t) => t.id === dmTopicId)).toBe(false);
  });

  it('authz: a third user cannot read the DM chat (403)', async () => {
    await expect(
      c.rest.request(`/api/topics/${dmTopicId}/chat`, { method: 'GET' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('boundary: DM-with-self → 400, DM to a non-existent user → 404', async () => {
    await expect(a.rest.dm.start(aUserId)).rejects.toMatchObject({ status: 400 });
    await expect(a.rest.dm.start('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).rejects.toMatchObject({ status: 404 });
  });

  it('human↔AI: an isAI api-key with chat caps completes a DM round-trip; an out-of-cap key is 403', async () => {
    // Account D is the AI's account; it mints two scoped keys from a human session.
    const d = (await newClient('d')).chat;
    const ld = await d.login(`dm_d_${Date.now().toString(36)}`);
    const dUserId = ld.userId;

    const capable = await d.rest.apiKeys.create({
      name: 'dm-ai-capable',
      cmd: ['/openstoa/chat/read', '/openstoa/chat/send'],
      historyGrant: 'none',
    });
    const weak = await d.rest.apiKeys.create({ name: 'dm-ai-weak', cmd: [], historyGrant: 'none' });

    // A (human) starts the DM with D (genesis by A).
    const tHumanAi = await a.startDm(dUserId);

    // D's isAI session (scoped key) joins the same DM and replies.
    const aiRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-e2e-ai-'));
    roots.push(aiRoot);
    const ai = new ChatClient({ baseUrl: BASE, apiKey: capable.rawKey, vaultRoot: aiRoot, deviceId: `dm-e2e-ai-${Date.now()}` });
    const tAi = await ai.startDm(aUserId);
    expect(tAi).toBe(tHumanAi);

    const aiText = `hi human, this is the AI — ${Date.now()}`;
    const aiMsgId = await ai.sendChat(tAi, aiText);
    const seenByHuman = await a.readChat(tHumanAi);
    expect(seenByHuman.find((h) => h.id === aiMsgId)?.text).toBe(aiText);

    // Out-of-capability key: POST /api/dm is gated on chat/send → 403.
    const weakClient = new OpenStoaClient({ baseUrl: BASE, apiKey: weak.rawKey });
    await expect(weakClient.dm.start(aUserId)).rejects.toBeInstanceOf(OpenStoaApiError);
    await expect(weakClient.dm.start(aUserId)).rejects.toMatchObject({ status: 403 });
  });
});
