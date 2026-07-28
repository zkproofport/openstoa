/**
 * CLI E2EE chat E2E against a REAL running OpenStoa container (default
 * http://localhost:3200). Drives the BUILT `openstoa` binary (dist/cli.js) as a
 * subprocess for two independent agents (separate vault roots), proving the full
 * CLI → command-core → SDK → live REST path:
 *   - agent A: login → pick category → create topic → chat join → chat send;
 *   - agent B: login → chat read decrypts A's plaintext (E2EE round-trip).
 *
 * Requires a fresh CLI build (`npm run build`) and the container up
 * (`./scripts/dev.sh`). Run: `E2E_BASE_URL=http://localhost:3200 npm run test:e2e`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3200';
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/cli.js');

let rootA: string;
let rootB: string;
let topicId: string;

async function cli(vaultRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('node', [CLI, '--base-url', BASE, '--vault-root', vaultRoot, ...args], {
    env: { ...process.env },
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

describe.sequential('CLI E2EE chat (real container)', () => {
  beforeAll(async () => {
    const health = await fetch(`${BASE}/api/health`).catch(() => null);
    if (!health || !health.ok) throw new Error(`container not reachable at ${BASE} — start it first (./scripts/dev.sh)`);
    await fs.access(CLI).catch(() => {
      throw new Error(`built CLI not found at ${CLI} — run \`npm run build\` first`);
    });
    rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-e2e-a-'));
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-e2e-b-'));
  });

  afterAll(async () => {
    if (rootA) await fs.rm(rootA, { recursive: true, force: true });
    if (rootB) await fs.rm(rootB, { recursive: true, force: true });
  });

  let probe: string;

  it('agent A logs in, picks a category, creates a topic, and joins its chat (MLS genesis)', async () => {
    const login = JSON.parse(await cli(rootA, ['--json', 'login', '--nickname', `cli_e2e_a_${Date.now().toString(36)}`]));
    expect(login.userId).toBeTruthy();

    const categories = JSON.parse(await cli(rootA, ['--json', 'categories']));
    const categoryId = categories[0]?.id;
    expect(categoryId).toBeTruthy();

    const topic = JSON.parse(
      await cli(rootA, ['--json', 'topics', 'create', '--title', `CLI E2EE ${Date.now()}`, '--visibility', 'public', '--category-id', categoryId]),
    );
    topicId = topic.id;
    expect(topicId).toBeTruthy();

    await cli(rootA, ['chat', 'join', topicId]);
  });

  it('agent B logs in and joins the chat (MLS External Commit) BEFORE A sends', async () => {
    const login = JSON.parse(await cli(rootB, ['--json', 'login', '--nickname', `cli_e2e_b_${Date.now().toString(36)}`]));
    expect(login.userId).toBeTruthy();
    const joined = JSON.parse(await cli(rootB, ['--json', 'chat', 'join', topicId]));
    expect(joined.topicId).toBe(topicId);
  });

  it('A sends a sealed message and B decrypts A\'s plaintext (E2EE round-trip)', async () => {
    probe = `hello from CLI agent A — 안녕 🔐 ${Date.now()}`;
    const out = await cli(rootA, ['chat', 'send', topicId, probe]);
    expect(out).toMatch(/Sent /);

    const messages = JSON.parse(await cli(rootB, ['--json', 'chat', 'read', topicId]));
    const mine = messages.find((m: { text: string | null }) => m.text === probe);
    expect(mine, `expected to decrypt probe among ${messages.length} messages`).toBeTruthy();
    expect(mine.text).toBe(probe);
  });
});
