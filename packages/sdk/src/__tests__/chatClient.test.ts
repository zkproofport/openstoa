/**
 * ChatClient seal/open logic, device-free. Drives TWO ChatClients (distinct
 * vaults + device identities) through the REAL copied MLS/TAK core against an
 * in-memory Delivery Service implemented as a fetch mock (no network, no
 * container). Proves:
 *   - E2EE round-trip: client A sendChat → client B readChat decrypts it;
 *   - SI-1: the DS stored ONLY opaque ciphertext (never the plaintext);
 *   - forward secrecy: B cannot read A's pre-join message inline, but CAN read
 *     it after A distributes the public TAK archive root (backfill).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChatClient } from '../chatClient';
import { OpenStoaClient } from '../rest/openStoaClient';

// --- in-memory Delivery Service (crypto-free, like the real server) ----------

interface StoredMsg {
  id: string;
  userId: string;
  ciphertext: string; // base64 MLS private message
  epoch: number;
  takVersion: number | null;
  createdAt: string;
}
interface CommitRow { epoch: number; commit: string; welcome: null }
interface ArchiveRow { messageId: string; takVersion: number; ciphertext: string; createdAt: string }
interface BundleRow { id: string; deviceId: string; bundle: string; scope: string; createdAt: string }

function makeDs() {
  const groups = new Map<string, { groupInfo: string; epoch: number }>();
  const commits = new Map<string, CommitRow[]>();
  const chat = new Map<string, StoredMsg[]>();
  const archive = new Map<string, ArchiveRow[]>();
  const bundles = new Map<string, BundleRow[]>();
  let seq = 0;
  const tokenUser: Record<string, string> = {}; // Bearer token → userId
  const now = () => new Date(Date.now() + seq).toISOString();

  const json = (status: number, obj: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(obj),
      json: async () => obj,
    }) as unknown as Response;

  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const p = u.pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? '';
    const token = auth.replace('Bearer ', '');
    const userId = tokenUser[token] ?? token;
    seq++;
    let m: RegExpMatchArray | null;

    if (p === '/api/auth/dev-login') {
      const uid = '0x' + (seq).toString(16).padStart(4, '0');
      const tok = 'tok-' + uid;
      tokenUser[tok] = uid;
      return json(200, { userId: uid, nickname: body?.nickname ?? 'dev', token: tok });
    }
    // topic detail (visibility lookup)
    if ((m = p.match(/^\/api\/topics\/([^/]+)$/)) && method === 'GET') {
      return json(200, { topic: { id: m[1], visibility: 'public' } });
    }
    if ((m = p.match(/^\/api\/topics\/([^/]+)\/join$/)) && method === 'POST') {
      return json(201, { success: true });
    }
    // MLS group-info
    if ((m = p.match(/^\/api\/topics\/([^/]+)\/mls\/group-info$/))) {
      const t = m[1];
      if (method === 'GET') {
        const g = groups.get(t);
        return g ? json(200, { groupInfo: g.groupInfo }) : json(404, { error: 'no group' });
      }
      if (method === 'POST') {
        if (groups.has(t)) return json(200, { created: false });
        groups.set(t, { groupInfo: body.groupInfo, epoch: 0 });
        commits.set(t, []);
        return json(200, { created: true });
      }
    }
    // MLS commit (monotonic epoch; linear test → no CAS conflict)
    if ((m = p.match(/^\/api\/topics\/([^/]+)\/mls\/commit$/))) {
      const t = m[1];
      if (method === 'POST') {
        const g = groups.get(t);
        if (!g) return json(409, { error: 'no group' });
        const epoch = g.epoch + 1;
        g.epoch = epoch;
        g.groupInfo = body.groupInfo;
        commits.get(t)!.push({ epoch, commit: body.commit, welcome: null });
        return json(200, { epoch });
      }
      if (method === 'GET') {
        const since = Number(u.searchParams.get('sinceEpoch') ?? '0');
        return json(200, { commits: (commits.get(t) ?? []).filter((c) => c.epoch > since) });
      }
    }
    // chat
    if ((m = p.match(/^\/api\/topics\/([^/]+)\/chat$/))) {
      const t = m[1];
      if (method === 'POST') {
        const row: StoredMsg = {
          id: 'msg-' + seq,
          userId,
          ciphertext: body.ciphertext,
          epoch: body.epoch,
          takVersion: body.takVersion ?? null,
          createdAt: now(),
        };
        (chat.get(t) ?? chat.set(t, []).get(t)!).push(row);
        return json(201, {
          message: {
            id: row.id,
            topicId: t,
            userId,
            nickname: 'u',
            profileImage: null,
            type: 'message',
            isAI: false,
            createdAt: row.createdAt,
            message: null,
            sealed: { ciphertext: row.ciphertext, epoch: row.epoch, takVersion: row.takVersion },
          },
        });
      }
      if (method === 'GET') {
        const rows = chat.get(t) ?? [];
        return json(200, {
          total: rows.length,
          messages: rows.map((r) => ({
            id: r.id,
            topicId: t,
            userId: r.userId,
            nickname: 'u',
            profileImage: null,
            type: 'message',
            isAI: false,
            createdAt: r.createdAt,
            message: null,
            sealed: { ciphertext: r.ciphertext, epoch: r.epoch, takVersion: r.takVersion },
          })),
        });
      }
    }
    // TAK archive
    if ((m = p.match(/^\/api\/topics\/([^/]+)\/archive$/))) {
      const t = m[1];
      if (method === 'POST') {
        (archive.get(t) ?? archive.set(t, []).get(t)!).push({
          messageId: body.messageId,
          takVersion: body.takVersion,
          ciphertext: body.archive,
          createdAt: now(),
        });
        return json(200, { ok: true });
      }
      if (method === 'GET') return json(200, { archive: archive.get(t) ?? [] });
    }
    // TAK bundles
    if ((m = p.match(/^\/api\/topics\/([^/]+)\/tak\/bundles$/))) {
      const t = m[1];
      if (method === 'POST') {
        (bundles.get(t) ?? bundles.set(t, []).get(t)!).push({
          id: 'b-' + seq,
          deviceId: body.recipientDeviceId,
          bundle: body.bundle,
          scope: body.scope,
          createdAt: now(),
        });
        return json(200, { ok: true });
      }
      if (method === 'GET') {
        const dev = u.searchParams.get('deviceId');
        return json(200, { bundles: (bundles.get(t) ?? []).filter((b) => b.deviceId === dev) });
      }
      if (method === 'DELETE') {
        const rest = (bundles.get(t) ?? []).filter((b) => !body.ids.includes(b.id));
        bundles.set(t, rest);
        return json(200, { ok: true });
      }
    }
    return json(404, { error: `unhandled ${method} ${p}` });
  }) as unknown as typeof fetch;

  return { fetchImpl, chat, archive };
}

let rootA: string;
let rootB: string;
beforeEach(async () => {
  rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-a-'));
  rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-b-'));
});
afterEach(async () => {
  await fs.rm(rootA, { recursive: true, force: true });
  await fs.rm(rootB, { recursive: true, force: true });
});

describe('ChatClient E2EE seal/open (in-memory DS, real MLS core)', () => {
  it('A sends, B reads and decrypts; the DS stored only ciphertext (SI-1)', async () => {
    const { fetchImpl, chat } = makeDs();
    const T = 'topic-1';
    const a = new ChatClient({ baseUrl: 'http://ds', token: 'tok-A', vaultRoot: rootA, deviceId: 'dev-A', fetch: fetchImpl });
    const b = new ChatClient({ baseUrl: 'http://ds', token: 'tok-B', vaultRoot: rootB, deviceId: 'dev-B', fetch: fetchImpl });

    await a.joinTopic(T); // genesis (epoch 0)
    await b.joinTopic(T); // External-Commit join (epoch 1)

    const plaintext = 'hello from A — 안녕 🔐';
    const msgId = await a.sendChat(T, plaintext); // A catches up to epoch 1, seals there
    expect(msgId).toBeTruthy();

    const history = await b.readChat(T);
    const mine = history.find((h) => h.id === msgId);
    expect(mine?.text).toBe(plaintext);

    // SI-1: the DS row holds opaque MLS ciphertext, NOT the plaintext.
    const stored = chat.get(T)!.find((r) => r.id === msgId)!;
    const decoded = Buffer.from(stored.ciphertext, 'base64').toString('utf8');
    expect(stored.ciphertext).not.toContain(plaintext);
    expect(decoded).not.toContain('hello from A');
  });

  it('A can re-read its OWN message (sender plaintext cache)', async () => {
    const { fetchImpl } = makeDs();
    const T = 'topic-self';
    const a = new ChatClient({ baseUrl: 'http://ds', token: 'tok-A', vaultRoot: rootA, deviceId: 'dev-A', fetch: fetchImpl });
    await a.joinTopic(T);
    const msgId = await a.sendChat(T, 'my own words');
    // MLS senders cannot decrypt their own application message; the local cache
    // makes readChat surface it anyway.
    const history = await a.readChat(T);
    expect(history.find((h) => h.id === msgId)?.text).toBe('my own words');
  });

  it('forward secrecy: B reads a pre-join message only after the public TAK root is distributed', async () => {
    const { fetchImpl } = makeDs();
    const T = 'topic-fs';
    const a = new ChatClient({ baseUrl: 'http://ds', token: 'tok-A', vaultRoot: rootA, deviceId: 'dev-A', fetch: fetchImpl });
    await a.joinTopic(T);
    // A sends BEFORE B joins → archived under the public root at epoch 0.
    const preJoinId = await a.sendChat(T, 'secret-before-B');

    const b = new ChatClient({ baseUrl: 'http://ds', token: 'tok-B', vaultRoot: rootB, deviceId: 'dev-B', fetch: fetchImpl });
    await b.joinTopic(T);

    // Before any TAK grant, B's backfill yields nothing it can decrypt.
    expect(await b.backfill(T)).toHaveLength(0);

    // A distributes the public archive root to every member leaf (incl. B).
    const sent = await a.distributePublicArchive(T);
    expect(sent).toBeGreaterThanOrEqual(1);

    // Now B back-fills and reads the pre-join message.
    const history = await b.backfill(T);
    expect(history.find((h) => h.messageId === preJoinId)?.plaintext).toBe('secret-before-B');
  });

  it('accepts an injected OpenStoaClient (shared REST instance)', async () => {
    const { fetchImpl } = makeDs();
    const T = 'topic-shared';
    const rest = new OpenStoaClient({ baseUrl: 'http://ds', token: 'tok-A', fetch: fetchImpl });
    const a = new ChatClient({ baseUrl: 'http://ds', client: rest, vaultRoot: rootA, deviceId: 'dev-A' });
    await a.joinTopic(T);
    const id = await a.sendChat(T, 'via injected client');
    expect(id).toBeTruthy();
  });
});
