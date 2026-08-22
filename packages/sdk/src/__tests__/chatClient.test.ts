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
import { MlsSessionStore, EncryptingKVStore, groupClient as gc, keyManager } from '../mls';
import { mlsTransport } from '../rest/transports';
import { createFileVaultStore } from '../keystore';
import { minimalPng } from '../../../mls/src/__tests__/imageFixtures';

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
  // Delivery acks the SDK sent, per topic, plus a switch to make the endpoint
  // fail so "a failed ack never breaks a read" can be asserted.
  const delivered = new Map<string, Array<{ deviceId: string; through: string }>>();
  let deliveredFails = false;
  const bundles = new Map<string, BundleRow[]>();
  /*
   * The server-held public archive root, and its published identity. Both are
   * WRITE-ONCE on the real server, and the client depends on that: a second
   * depositor is told it lost (409 / claimed:false) and adopts the winner's key
   * rather than keeping one nothing was sealed under. A mock that let the second
   * write through would make the client look correct while the real server
   * rejected it.
   */
  /** Attachment ciphertext by object key, plus whether its message went out. */
  // `Uint8Array<ArrayBuffer>`, not the default `Uint8Array<ArrayBufferLike>`:
  // every write below copies into a fresh buffer, so the bytes are provably
  // not backed by a SharedArrayBuffer — which is exactly what `BodyInit`
  // demands before it will accept them as a `Response` body.
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; claimed: boolean }>();
  const serverRoot = new Map<string, string>();
  const rootFingerprint = new Map<string, string>();
  const dmChannels = new Map<string, { topicId: string; a: string; b: string }>(); // key = canonical pair
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
    /*
     * Only a STRING body is JSON. The attachment upload sends raw octets now,
     * and parsing those as JSON is how this harness first went red — which is
     * the right way round: a double that quietly accepted either framing would
     * be more permissive than the route, which refuses anything that is not
     * `application/octet-stream` with 415.
     */
    const rawBody = init?.body;
    const body = typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined;
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
    /*
     * Who the caller is. Modelled on the real route deliberately: it NEVER 401s
     * — a guest gets `{ authenticated: false }` — so a client must treat a
     * missing `userId` as the normal unauthenticated answer rather than an
     * error.
     *
     * This route was absent from the harness while the client already called
     * it, which meant the leaf-identity wiring below silently did nothing and
     * the test passed anyway. A mock that is more permissive than the server
     * certifies broken code as working; one that simply 404s an endpoint the
     * client depends on hides the dependency altogether.
     */
    if (p === '/api/auth/session') {
      if (!token) return json(200, { authenticated: false });
      return json(200, { userId, nickname: 'dev' });
    }
    // topic detail (visibility lookup)
    if ((m = p.match(/^\/api\/topics\/([^/]+)$/)) && method === 'GET') {
      return json(200, { topic: { id: m[1], visibility: 'public' } });
    }
    if ((m = p.match(/^\/api\/topics\/([^/]+)\/join$/)) && method === 'POST') {
      return json(201, { success: true });
    }
    // DM start-or-get (idempotent on the canonical participant pair) + list.
    if (p === '/api/dm') {
      if (method === 'POST') {
        const pair = [userId, body.userId].sort().join('|');
        let ch = dmChannels.get(pair);
        if (!ch) {
          ch = { topicId: 'dm-' + pair.replace(/[^a-zA-Z0-9]/g, '_'), a: userId, b: body.userId };
          dmChannels.set(pair, ch);
        }
        return json(ch ? 201 : 200, { topicId: ch.topicId });
      }
      if (method === 'GET') {
        const dms = [...dmChannels.values()]
          .filter((ch) => ch.a === userId || ch.b === userId)
          .map((ch) => ({ topicId: ch.topicId, peer: { userId: ch.a === userId ? ch.b : ch.a, nickname: 'u', profileImage: null }, lastActivityAt: null }));
        return json(200, { dms });
      }
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
    // delivery acks — the live copy is a QUEUE, so the server is told what has
    // landed. Recorded rather than acted on: what matters here is that the SDK
    // sends it, for the right device and the right instant.
    if ((m = p.match(/^\/api\/topics\/([^/]+)\/chat\/delivered$/))) {
      const t = m[1];
      if (method === 'POST') {
        if (deliveredFails) return json(500, { error: 'nope' });
        (delivered.get(t) ?? delivered.set(t, []).get(t)!).push({
          deviceId: body.deviceId,
          through: body.through,
        });
        return json(200, { deliveredThrough: body.through });
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
    // encrypted chat attachments — ciphertext in, ciphertext out
    if ((m = p.match(/^\/api\/topics\/([^/]+)\/chat\/media$/))) {
      const t = m[1];
      if (method === 'POST') {
        /*
         * RAW BYTES in, id in the query string — and modelled as the route's
         * REFUSALS, not just its happy path. The route answers 415 to anything
         * not framed as octets and 400 to a missing id, so a client that
         * reverted to base64-in-JSON must fail here rather than be recorded.
         */
        const ct = ((init?.headers ?? {}) as Record<string, string>)['Content-Type'] ?? '';
        if (ct !== 'application/octet-stream') return json(415, { error: `bad framing: ${ct}` });
        const mediaId = u.searchParams.get('mediaId') ?? '';
        if (!/^[0-9a-f]{32}$/.test(mediaId)) return json(400, { error: 'bad mediaId' });
        if (!(rawBody instanceof Uint8Array)) return json(400, { error: 'body must be bytes' });
        if (rawBody.length === 0) return json(400, { error: 'ciphertext is empty' });
        // The server mints the key from ids — the caller never chooses it.
        const key = `topics/${t}/chat/${userId}/${mediaId}.bin`;
        objects.set(key, { bytes: new Uint8Array(rawBody), claimed: false });
        return json(201, { key });
      }
      if (method === 'GET') {
        const key = u.searchParams.get('key') ?? '';
        const obj = objects.get(key);
        if (!obj) return json(404, { error: 'not found' });
        // The route answers octets to EVERY caller — there is no JSON shape to
        // negotiate any more. This client never sent an `Accept`, and while the
        // route still had one it was handed the bytes of a JSON document and
        // read them as ciphertext.
        return new Response(obj.bytes, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }) as unknown as Response;
      }
      if (method === 'DELETE') {
        objects.delete(u.searchParams.get('key') ?? '');
        return json(200, { ok: true });
      }
    }
    // public archive root (public tier only — the server holds this one key)
    if ((m = p.match(/^\/api\/topics\/([^/]+)\/archive\/root$/))) {
      const t = m[1];
      if (method === 'GET') {
        const k = serverRoot.get(t);
        // 204, not 404: "nothing deposited yet" is an ordinary answer.
        return k ? json(200, { rootKey: k }) : json(204, {});
      }
      if (method === 'PUT') {
        const existing = serverRoot.get(t);
        if (existing && existing !== body.rootKey) return json(409, { error: 'root already deposited' });
        serverRoot.set(t, body.rootKey);
        return json(200, { ok: true });
      }
    }
    // the root's published identity — COMPARE-AND-SET, first writer wins
    if ((m = p.match(/^\/api\/topics\/([^/]+)\/tak\/root-fingerprint$/))) {
      const t = m[1];
      if (method === 'GET') {
        return json(200, {
          fingerprint: rootFingerprint.get(t) ?? null,
          archiveCount: (archive.get(t) ?? []).length,
        });
      }
      if (method === 'PUT') {
        const existing = rootFingerprint.get(t);
        if (!existing) rootFingerprint.set(t, body.fingerprint);
        const winner = rootFingerprint.get(t)!;
        return json(200, { fingerprint: winner, claimed: winner === body.fingerprint });
      }
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

  return {
    fetchImpl,
    chat,
    archive,
    delivered,
    setDeliveredFails: (v: boolean) => {
      deliveredFails = v;
    },
  };
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

  it('PUBLIC tier: B reads a pre-join message from the SERVER-HELD root, with nobody else online', async () => {
    /*
     * REWRITTEN when the SDK's TAK stack was brought level with the web and
     * mini-app copies. It previously asserted that B could read pre-join
     * history ONLY AFTER another member distributed the root to its leaf —
     * which is the model the design explicitly replaced
     * (`docs/design/openstoa-chat-history-decision.md`): making history depend
     * on some other member being awake at the right moment is a property no
     * reader can predict, and it left rooms whose history never opened at all.
     *
     * For `public` — and ONLY public — the server holds the archive root, so a
     * later joiner reads everything the moment it arrives. The old assertion
     * described an SDK that had fallen behind that decision, not a guarantee
     * anyone wanted; the security property it looked like it was protecting
     * (MLS forward secrecy) is asserted separately below and is unchanged.
     */
    const { fetchImpl } = makeDs();
    const T = 'topic-fs';
    const a = new ChatClient({ baseUrl: 'http://ds', token: 'tok-A', vaultRoot: rootA, deviceId: 'dev-A', fetch: fetchImpl });
    await a.joinTopic(T);
    // A sends BEFORE B joins → archived under the public root at epoch 0.
    const preJoinId = await a.sendChat(T, 'secret-before-B');

    const b = new ChatClient({ baseUrl: 'http://ds', token: 'tok-B', vaultRoot: rootB, deviceId: 'dev-B', fetch: fetchImpl });
    await b.joinTopic(T);

    // FORWARD SECRECY, unchanged: MLS alone gives B nothing for a message sent
    // before it joined — the epoch key it would need was never its to have.
    const live = await b.readChat(T);
    expect(live.find((r) => r.id === preJoinId)?.text ?? null).toBeNull();

    // …and the archive opens anyway, because THIS tier's root is on the server.
    // No distribution call, no other member online: that is the trade `public`
    // makes, and the reason its banner does not claim the service cannot read.
    const history = await b.backfill(T);
    expect(history.find((h) => h.messageId === preJoinId)?.plaintext).toBe('secret-before-B');
  });

  it('AGENT ROUND TRIP: A sends an image, B reads the PICTURE — not the envelope', async () => {
    /*
     * The gap this closes: an agent used to receive the literal envelope
     * `openstoa:media:v1:{…}` as message text where a person saw a photo. The
     * bytes were reachable — nothing on the agent path fetched or opened them.
     *
     * PUBLIC tier on purpose. It is the one where the key comes from the
     * SERVER-held root rather than a per-epoch TAK, so it is the tier a
     * media path would silently fail in if it were built on epoch keys alone —
     * which is why "every tier or none" was the acceptance criterion.
     */
    const { fetchImpl } = makeDs();
    const T = '11111111-2222-4333-8444-555555555501';
    const a = new ChatClient({ baseUrl: 'http://ds', token: 'tok-A', vaultRoot: rootA, deviceId: 'dev-A', fetch: fetchImpl });
    await a.joinTopic(T);
    // B is in the room BEFORE the picture is sent, so this is the LIVE read
    // path. The later-joiner path is history and is asserted below.
    const b = new ChatClient({ baseUrl: 'http://ds', token: 'tok-B', vaultRoot: rootB, deviceId: 'dev-B', fetch: fetchImpl });
    await b.joinTopic(T);

    /*
      * A COMPLETE PNG, not just its magic bytes. The send path strips metadata
      * before it seals, so it walks the whole container — and a header with no
      * IDAT and no IEND is refused as something it cannot clean.
      */
    const png = minimalPng();
    const { messageId, envelope } = await a.sendMedia(T, { bytes: png, mime: 'image/png' });

    // The KEY is server-minted and topic-partitioned (M-3), never client-chosen.
    expect(envelope.key.startsWith(`topics/${T}/chat/`)).toBe(true);
    expect(envelope.mime).toBe('image/png');

    const rows = await b.readChat(T);
    const row = rows.find((r) => r.id === messageId);
    expect(row, 'the attachment message is in history').toBeTruthy();

    // The envelope must NOT leak through as prose…
    expect(row!.text).toBeNull();
    // …and the picture arrives, byte for byte.
    expect(row!.media?.status).toBe('ok');
    expect(row!.media?.mime).toBe('image/png');
    expect(Array.from(row!.media?.bytes ?? [])).toEqual(Array.from(png));
  });

  it('an attachment whose object is gone reads as unavailable, not as a crash', async () => {
    // One collected picture must not abort a whole history read — the other
    // rows still have to come back.
    const { fetchImpl } = makeDs();
    const T = '11111111-2222-4333-8444-555555555502';
    const a = new ChatClient({ baseUrl: 'http://ds', token: 'tok-A', vaultRoot: rootA, deviceId: 'dev-A', fetch: fetchImpl });
    await a.joinTopic(T);
    await a.sendChat(T, 'a message that is just words');
    // A complete PNG: the send path walks the container to strip its metadata.
    const png = minimalPng();
    const { messageId, envelope } = await a.sendMedia(T, { bytes: png, mime: 'image/png' });

    // The object disappears (retention, orphan collection, a topic sweep).
    await a.rest.chat.discardMedia(T, envelope.key);

    const rows = await a.readChat(T);
    expect(rows.find((r) => r.id === messageId)?.media?.status).toBe('unavailable');
    expect(rows.find((r) => r.text === 'a message that is just words')).toBeTruthy();
  });

  it('HISTORY: a LATER joiner reads the picture from the archive, not the envelope', async () => {
    /*
     * The path an agent actually uses, and the one that would have been left
     * behind if only `readChat` were wired: an agent almost always arrives
     * AFTER the conversation, so its pictures come from the archive rather than
     * from a live row. Public tier again — the key is the server-held root.
     */
    const { fetchImpl } = makeDs();
    const T = '11111111-2222-4333-8444-555555555503';
    const a = new ChatClient({ baseUrl: 'http://ds', token: 'tok-A', vaultRoot: rootA, deviceId: 'dev-A', fetch: fetchImpl });
    await a.joinTopic(T);

    // A complete PNG: the send path walks the container to strip its metadata.
    const png = minimalPng();
    const { messageId } = await a.sendMedia(T, { bytes: png, mime: 'image/png' });

    // B arrives afterwards: MLS gives it nothing for that row…
    const b = new ChatClient({ baseUrl: 'http://ds', token: 'tok-B', vaultRoot: rootB, deviceId: 'dev-B', fetch: fetchImpl });
    await b.joinTopic(T);
    expect((await b.readChat(T)).find((r) => r.id === messageId)?.text ?? null).toBeNull();

    // …and the archive hands over the PICTURE, decrypted, not the envelope.
    const history = await b.backfill(T);
    const row = history.find((h) => h.messageId === messageId);
    expect(row, 'the attachment is in history').toBeTruthy();
    expect(row!.media?.status).toBe('ok');
    expect(Array.from(row!.media?.bytes ?? [])).toEqual(Array.from(png));
    // The envelope must not survive as prose in history either.
    expect(row!.plaintext).toBe('');
  });

  it('DM: startDm is idempotent per pair, and A↔B round-trip works over the DM topicId', async () => {
    const { fetchImpl, chat } = makeDs();
    // No dev-login → each client's userId is its bearer token (tok-A / tok-B).
    const a = new ChatClient({ baseUrl: 'http://ds', token: 'tok-A', vaultRoot: rootA, deviceId: 'dev-A', fetch: fetchImpl });
    const b = new ChatClient({ baseUrl: 'http://ds', token: 'tok-B', vaultRoot: rootB, deviceId: 'dev-B', fetch: fetchImpl });

    // Idempotency: either party, either order → the SAME topicId.
    const t1 = await a.startDm('tok-B'); // A genesis
    const t2 = await b.startDm('tok-A'); // B External-Commit join
    const t3 = await a.startDm('tok-B'); // repeat
    expect(t1).toBe(t2);
    expect(t1).toBe(t3);

    // A appears in B's DM list with A as the peer.
    const dms = await b.listDms();
    expect(dms.find((d) => d.topicId === t1)?.peer.userId).toBe('tok-A');

    const plaintext = 'dm secret — 안녕 🔐';
    const msgId = await a.sendChat(t1, plaintext);
    const history = await b.readChat(t1);
    expect(history.find((h) => h.id === msgId)?.text).toBe(plaintext);

    // SI-1: the DS stored only opaque ciphertext for the DM.
    const stored = chat.get(t1)!.find((r) => r.id === msgId)!;
    expect(Buffer.from(stored.ciphertext, 'base64').toString('utf8')).not.toContain('dm secret');
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

/**
 * An agent has to be REMOVABLE, not just readable.
 *
 * The SDK minted its leaf as a bare `sdk-<uuid>`. `userIdOfLeaf` returns null
 * for that by design — a leaf nobody can name belongs to somebody, and guessing
 * would evict an innocent member — so `reconcileMembership`, the only kick path
 * any product surface calls, counted it as unattributable and left it in the
 * tree. Deleting the membership row closed the API and did nothing to the
 * crypto: the agent kept deriving every future epoch key.
 *
 * These tests are about the CALLER wiring, not the port. Byte-identity with the
 * web copy is asserted elsewhere; passing a user-id provider is what actually
 * mints `<userId>:<deviceId>`, and without it every test below still compiles
 * and returns `removed: 0`.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract    → 'a member can remove the agent BY ACCOUNT'
 *   integrity   → 'the identity is minted once and survives a restart'
 *   hostile     → 'a legacy bare leaf is left alone, and counted'
 *   empty/null  → 'an unauthenticated client falls back to the bare device id'
 *   boundary    → 'removing an account with no leaves burns no epoch'
 *   authz       → N/A: removal is an MLS Commit any member may make; the server
 *                 gate is a separate layer and is unchanged here.
 *   race        → N/A: epoch-CAS retry is covered by src/__tests__/mls-removal.
 *   UTF-8/large → N/A: an identity is a uuid and an account id.
 */
describe('readChat acknowledges delivery (R-1)', () => {
  /*
   * The live `ciphertext` column is a delivery QUEUE: the server drops a
   * message's copy once every device that was in the group at send time has
   * fetched it. An SDK that never acknowledges is the reason its own ciphertext
   * sits on the server for the full 30-day grace cap, so the ack belongs in the
   * read path rather than in every caller's memory.
   */
  it('CONTRACT: a read acks the NEWEST row, for THIS device', async () => {
    const { fetchImpl, delivered } = makeDs();
    const T = 'topic-ack';
    const a = new ChatClient({ baseUrl: 'http://ds', token: 'tok-A', vaultRoot: rootA, deviceId: 'dev-A', fetch: fetchImpl });
    const b = new ChatClient({ baseUrl: 'http://ds', token: 'tok-B', vaultRoot: rootB, deviceId: 'dev-B', fetch: fetchImpl });
    await a.joinTopic(T);
    await b.joinTopic(T);
    await a.sendChat(T, 'first');
    await a.sendChat(T, 'second');

    const rows = await b.readChat(T);
    const acks = delivered.get(T) ?? [];
    expect(acks.length).toBeGreaterThan(0);

    const last = acks[acks.length - 1];
    // The newest row it just returned — every earlier one came back with it.
    const newest = rows.reduce((n, r) => (Date.parse(r.createdAt) > Date.parse(n.createdAt) ? r : n), rows[0]);
    expect(last.through).toBe(newest.createdAt);
    // Per DEVICE: the leaf id, not the user. B must not release A's copy.
    expect(last.deviceId).toBeTruthy();
    expect(last.deviceId).not.toBe('tok-B');
  });

  it('INTEGRITY: a row this client could NOT read is never acked', async () => {
    /*
     * The hazard one layer over from the web client's `claimable`: `readChat`
     * degrades an undecryptable body to `text: null` instead of throwing, so a
     * locked row arrives beside readable ones. Acking it would tell the server
     * "delivered" for ciphertext this device cannot open, and the purge then
     * drops the only copy — from under the device still waiting for its key.
     *
     * The genuinely locked case is a device that joined AFTER the message: MLS
     * gives a later leaf no past-epoch secret, so it cannot open that row and
     * has to get it from the archive. (A SENDER is not the case to use here —
     * `sendChat` caches its own plaintext, so it reads its own message back.)
     */
    const { fetchImpl, delivered } = makeDs();
    const T = 'topic-ack-locked';
    const a = new ChatClient({ baseUrl: 'http://ds', token: 'tok-A', vaultRoot: rootA, deviceId: 'dev-A', fetch: fetchImpl });
    await a.joinTopic(T);
    await a.sendChat(T, 'sent before the latecomer arrived');

    const late = new ChatClient({ baseUrl: 'http://ds', token: 'tok-C', vaultRoot: rootB, deviceId: 'dev-C', fetch: fetchImpl });
    await late.joinTopic(T);

    const rows = await late.readChat(T);
    const locked = rows.filter((r) => r.type === 'message' && r.text === null);
    expect(locked.length).toBeGreaterThan(0);
    // Nothing readable arrived, so nothing may be claimed.
    expect(delivered.get(T) ?? []).toEqual([]);
  });

  it('EMPTY: reading an empty room acks nothing', async () => {
    // There is no instant to claim, and claiming `now` would release messages
    // that arrive in the same millisecond.
    const { fetchImpl, delivered } = makeDs();
    const T = 'topic-ack-empty';
    const a = new ChatClient({ baseUrl: 'http://ds', token: 'tok-A', vaultRoot: rootA, deviceId: 'dev-A', fetch: fetchImpl });
    await a.joinTopic(T);

    expect(await a.readChat(T)).toEqual([]);
    expect(delivered.get(T) ?? []).toEqual([]);
  });

  it('EXT-FAILURE: a failed ack never turns a successful read into an error', async () => {
    /*
     * The messages are already in hand by then. Throwing would lose a history
     * the caller has, to save some server storage — exactly the wrong trade.
     */
    const { fetchImpl, setDeliveredFails } = makeDs();
    const T = 'topic-ack-fail';
    const a = new ChatClient({ baseUrl: 'http://ds', token: 'tok-A', vaultRoot: rootA, deviceId: 'dev-A', fetch: fetchImpl });
    const b = new ChatClient({ baseUrl: 'http://ds', token: 'tok-B', vaultRoot: rootB, deviceId: 'dev-B', fetch: fetchImpl });
    await a.joinTopic(T);
    await b.joinTopic(T);
    const id = await a.sendChat(T, 'still readable');

    setDeliveredFails(true);
    const rows = await b.readChat(T);
    expect(rows.find((r) => r.id === id)?.text).toBe('still readable');
  });
});

describe('an agent leaf is attributable, so an admin can actually remove it', () => {
  /** A member's client, built the way the web builds one. */
  function memberStore(fetchImpl: typeof fetch, root: string, userId: string, deviceId: string) {
    const rest = new OpenStoaClient({ baseUrl: 'http://ds', token: userId, fetch: fetchImpl });
    const raw = createFileVaultStore({ root: root + '/vault', namespace: 'member' });
    const enc = EncryptingKVStore.lazy(raw, async () => new Uint8Array(32));
    return new MlsSessionStore(mlsTransport(rest), deviceId, enc, enc, async () => userId);
  }

  /**
   * How many leaves the tree ACTUALLY has right now.
   *
   * `readState` deliberately does not catch up — it hands back whatever this
   * device last saw — so counting through it compares two stale reads and is
   * true regardless of what happened. `reconcileMembership` catches up before
   * it reads the tree, and passing every current member means it removes
   * nothing and burns no epoch while doing so.
   */
  async function leafCount(member: MlsSessionStore, topicId: string, memberIds: string[]) {
    await member.reconcileMembership(topicId, memberIds);
    return (await member.readState(topicId, async (st) => gc.leafIdentities(st))).length;
  }

  it('CONTRACT: a member can remove the agent BY ACCOUNT', async () => {
    const { fetchImpl } = makeDs();
    const T = 'topic-kick';
    const member = memberStore(fetchImpl, rootA, 'tok-M', 'web-M');
    await member.readState(T, async () => null); // genesis

    const agent = new ChatClient({
      baseUrl: 'http://ds', token: 'tok-agent', vaultRoot: rootB, deviceId: 'sdk-agent', fetch: fetchImpl,
    });
    await agent.joinTopic(T);

    // The agent's account is 'tok-agent' (the DS maps an unregistered token to
    // itself). Removing it must find the leaf — that is the whole fix.
    const before = await member.readState(T, async (st) => gc.currentEpoch(st));
    const res = await member.removeUser(T, 'tok-agent');
    expect(res.removed, 'the agent leaf was not found — its credential is unattributable').toBe(1);
    expect(res.epoch, 'a real removal must advance the epoch').toBeGreaterThan(before);
  });

  it('CONTRACT: reconcileMembership evicts the agent when it is no longer a member', async () => {
    // The path a kick actually takes: the members list no longer contains the
    // agent, and ANY member's client repairs the tree on its next visit.
    const { fetchImpl } = makeDs();
    const T = 'topic-reconcile';
    const member = memberStore(fetchImpl, rootA, 'tok-M', 'web-M');
    await member.readState(T, async () => null);

    const agent = new ChatClient({
      baseUrl: 'http://ds', token: 'tok-agent', vaultRoot: rootB, deviceId: 'sdk-agent', fetch: fetchImpl,
    });
    await agent.joinTopic(T);

    const res = await member.reconcileMembership(T, ['tok-M']); // agent dropped
    expect(res.removed).toBe(1);
    expect(res.unattributable, 'the agent leaf should be nameable, not skipped').toBe(0);
  });

  it('INTEGRITY: the identity is minted once and survives a restart', async () => {
    /*
     * Changing it later would orphan the stored group state (the state key is
     * derived from it) and re-join as a fresh leaf, so a device that already has
     * an identity keeps it. A second client over the SAME vault must therefore
     * present the SAME leaf — otherwise every restart leaves a stray behind.
     */
    const { fetchImpl } = makeDs();
    const T = 'topic-restart';
    const member = memberStore(fetchImpl, rootA, 'tok-M', 'web-M');
    await member.readState(T, async () => null);

    const first = new ChatClient({
      baseUrl: 'http://ds', token: 'tok-agent', vaultRoot: rootB, deviceId: 'sdk-agent', fetch: fetchImpl,
    });
    await first.joinTopic(T);
    const leavesAfterFirst = await leafCount(member, T, ['tok-M', 'tok-agent']);

    const second = new ChatClient({
      baseUrl: 'http://ds', token: 'tok-agent', vaultRoot: rootB, deviceId: 'sdk-agent', fetch: fetchImpl,
    });
    await second.joinTopic(T);
    expect(await leafCount(member, T, ['tok-M', 'tok-agent']), 'a restart added a second leaf').toBe(
      leavesAfterFirst,
    );
  });

  it('HOSTILE: a legacy bare leaf is left in place, and counted rather than hidden', async () => {
    /*
     * The pre-fix credential form. Evicting a leaf we cannot name risks evicting
     * a current member, so reconcile leaves it — and REPORTS it, so a caller can
     * surface the gap instead of claiming a clean sweep that was not clean.
     * Agents that joined before this fix are exactly this case: `bootstrap`
     * persists the first identity and never changes it.
     */
    const { fetchImpl } = makeDs();
    const T = 'topic-legacy';
    const member = memberStore(fetchImpl, rootA, 'tok-M', 'web-M');
    await member.readState(T, async () => null);

    // No user-id provider → a bare device id, which is the legacy shape.
    const rest = new OpenStoaClient({ baseUrl: 'http://ds', token: 'tok-old', fetch: fetchImpl });
    const raw = createFileVaultStore({ root: rootB + '/vault', namespace: 'legacy' });
    const enc = EncryptingKVStore.lazy(raw, async () => new Uint8Array(32));
    const legacy = new MlsSessionStore(mlsTransport(rest), 'sdk-legacy-uuid', enc, enc);
    await legacy.readState(T, async () => null);

    const res = await member.reconcileMembership(T, ['tok-M']);
    expect(res.unattributable, 'an unnameable leaf must be counted').toBe(1);
    expect(res.removed, 'an unnameable leaf must NOT be evicted on a guess').toBe(0);
  });

  it('EMPTY: an unauthenticated client falls back to the bare device id and still chats', async () => {
    /*
     * A failed session lookup must not invent a user id, and must not break
     * chat. Only attribution is lost — which is the correct trade, because a
     * wrong user id would evict somebody else.
     */
    const { fetchImpl } = makeDs();
    const T = 'topic-guest';
    const guest = new ChatClient({
      baseUrl: 'http://ds', vaultRoot: rootB, deviceId: 'sdk-guest', fetch: fetchImpl,
    });
    await guest.joinTopic(T);
    const id = await guest.sendChat(T, 'still works without a session');
    expect(id).toBeTruthy();
  });

  it('CALLER WIRING: a recovered ChatClient still holds its pre-recovery MLS leaf', async () => {
    /*
     * The port is not the fix; the caller engaging it is. `EncryptingKVStore`
     * only falls back to the pre-recovery key when it is given a ROOT store, and
     * the SDK was not giving it one — the same shape as the leaf-identity gap,
     * where ported code sat present and unused behind a green twin test.
     *
     * Driven end to end rather than by inspecting the constructor: seal a leaf,
     * recover onto a different master key the way the recovery flow does, then
     * reopen. A client that cannot read its own sealed state does not error —
     * `get` reports an unopenable value as ABSENT — it silently bootstraps a
     * FRESH leaf, which is visible in the tree as an extra member and, in
     * production, as a device that lost all of its history.
     */
    const { fetchImpl } = makeDs();
    const T = 'topic-recovered';
    const member = memberStore(fetchImpl, rootA, 'tok-M', 'web-M');
    await member.readState(T, async () => null);

    const agent = new ChatClient({
      baseUrl: 'http://ds', token: 'tok-agent', vaultRoot: rootB, deviceId: 'sdk-agent', fetch: fetchImpl,
    });
    await agent.joinTopic(T);
    const leavesBefore = await leafCount(member, T, ['tok-M', 'tok-agent']);

    // Recover onto a different master_key, in the same vault this client uses.
    const globalStore = createFileVaultStore({ root: rootB + '/vault', namespace: undefined });
    await keyManager.installMasterKey(globalStore, new Uint8Array(32).fill(11));

    const recovered = new ChatClient({
      baseUrl: 'http://ds', token: 'tok-agent', vaultRoot: rootB, deviceId: 'sdk-agent', fetch: fetchImpl,
    });
    await recovered.joinTopic(T);

    expect(
      await leafCount(member, T, ['tok-M', 'tok-agent']),
      'recovery lost the sealed MLS state and re-joined as a new leaf',
    ).toBe(leavesBefore);
  });

  it('BOUNDARY: removing an account with no leaves burns no epoch', async () => {
    const { fetchImpl } = makeDs();
    const T = 'topic-noop';
    const member = memberStore(fetchImpl, rootA, 'tok-M', 'web-M');
    const before = await member.readState(T, async (st) => gc.currentEpoch(st));
    const res = await member.removeUser(T, 'tok-nobody');
    expect(res.removed).toBe(0);
    expect(res.epoch, 'a no-op removal must not advance the epoch').toBe(before);
  });
});
