/**
 * Real CLI E2EE round-trip using owner-issued API keys and independent vaults.
 * Opt in with E2E_BASE_URL=http://localhost:3200 after building the CLI and
 * starting the local stack. LocalAgents removes only these disposable fixtures.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BASE, LocalAgents, type Agent, type Row } from './agentHarness';

const local = new LocalAgents();
let a: Agent;
let b: Agent;
let topicId: string;

describe.skipIf(!BASE).sequential('CLI E2EE chat (real container)', () => {
  beforeAll(async () => {
    await local.ready();
    a = await local.agent(await local.owner('cli_e2ee_a'));
    b = await local.agent(await local.owner('cli_e2ee_b'));
  });

  afterAll(async () => { await local.dispose(); });

  it('agent A authenticates with its scoped key, creates a topic, and joins its chat (MLS genesis)', async () => {
    const session = await local.cli(a, ['whoami']);
    expect(session.userId).toBe(a.owner.userId);
    expect(session.isAI).toBe(true);
    const categories = await local.cli<Row[]>(a, ['categories']);
    const categoryId = categories[0]?.id;
    expect(categoryId).toBeTruthy();
    const topic = await local.cli(a, ['topics', 'create', '--title', `CLI E2EE ${Date.now()}`, '--visibility', 'public', '--category-id', categoryId]);
    topicId = topic.id;
    expect(topicId).toBeTruthy();
    expect((await local.cli(a, ['chat', 'join', topicId])).topicId).toBe(topicId);
  });

  it('agent B authenticates with its scoped key and joins (MLS External Commit) BEFORE A sends', async () => {
    const session = await local.cli(b, ['whoami']);
    expect(session.userId).toBe(b.owner.userId);
    expect(session.isAI).toBe(true);
    expect((await local.cli(b, ['chat', 'join', topicId])).topicId).toBe(topicId);
  });

  it("A sends a sealed message and B decrypts A's plaintext (E2EE round-trip)", async () => {
    const probe = `hello from CLI agent A — 안녕 🔐 ${Date.now()}`;
    const sent = await local.cli(a, ['chat', 'send', topicId, probe]);
    expect(sent.messageId).toBeTruthy();
    const messages = await local.cli<Row[]>(b, ['chat', 'read', topicId]);
    const mine = messages.find(message => message.id === sent.messageId);
    expect(mine, `expected to decrypt probe among ${messages.length} messages`).toBeTruthy();
    expect(mine!.text).toBe(probe);
    const raw = await local.request(a.apiKey, `/api/topics/${topicId}/chat`);
    expect(raw.status).toBe(200);
    expect(JSON.stringify(raw.body)).not.toContain(probe);
  });
});
