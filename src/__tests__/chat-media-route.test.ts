/**
 * R-3 — the attachment route: authz, caps, key confinement, and the promise
 * that the server never looks at what it stores.
 *
 * The old path (`/api/upload`) received plaintext image bytes, sniffed them,
 * transcoded HEIC, and wrote to a permanently public URL. This route receives
 * AEAD output and must do none of those things — a test that "recognises" the
 * content here would mean the content is not encrypted.
 *
 * The DB and object storage are mocked so this isolates the HTTP wiring; the
 * crypto is proven in `mls-tak-media.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const TOPIC = '11111111-2222-3333-4444-555555555555';
const USER = '0xabc123';
const MEDIA = 'a'.repeat(32);
// Derived, never spelled out: the storage layout is owned by `chatMediaObjectKey`
// and has already moved once (M-3). A hardcoded key here would keep passing
// against a shape the product no longer writes.
const KEY = chatMediaObjectKey(TOPIC, USER, MEDIA);
const otherTopicKey = (t: string) => chatMediaObjectKey(t, USER, MEDIA);

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  incr: vi.fn().mockResolvedValue(1),
  expire: vi.fn(),
  topicMembersFindFirst: vi.fn(),
  topicsFindFirst: vi.fn(),
  putR2Object: vi.fn(),
  getR2Object: vi.fn(),
  deleteR2Object: vi.fn(),
  // M-1 index row
  insertRow: vi.fn(),
  claimReturning: vi.fn(),
  updateWhere: vi.fn(),
  deleteRow: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/redis', () => ({
  getRedis: () => ({ incr: mocks.incr, expire: mocks.expire }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  db: {
    query: {
      topicMembers: { findFirst: mocks.topicMembersFindFirst },
      topics: { findFirst: mocks.topicsFindFirst },
    },
    insert: () => ({ values: (v: unknown) => ({ onConflictDoNothing: () => mocks.insertRow(v) }) }),
    // `where` has to be BOTH awaitable (the fire-and-forget claim-on-read) and
    // chainable into `.returning()` (the PATCH claim), which is what the real
    // query builder is.
    update: () => ({
      set: (v: unknown) => ({
        where: (w: unknown) =>
          Object.assign(Promise.resolve(mocks.updateWhere(v, w)), {
            returning: () => mocks.claimReturning(),
          }),
      }),
    }),
    delete: () => ({ where: (w: unknown) => mocks.deleteRow(w) }),
  },
}));
vi.mock('@/lib/r2', () => ({
  putR2Object: mocks.putR2Object,
  getR2Object: mocks.getR2Object,
  deleteR2Object: mocks.deleteR2Object,
}));

import { POST, GET, DELETE, PATCH } from '@/app/api/topics/[topicId]/chat/media/route';
import { MAX_CHAT_MEDIA_CIPHERTEXT_BYTES, MAX_JSON_BODY_BYTES, chatMediaObjectKey } from '@/lib/chatMedia';

const params = () => Promise.resolve({ topicId: TOPIC });
/*
 * `headers` is part of the double because the route reads it — for the
 * caller's `Accept` and for `content-length`. It was omitted while nothing
 * touched it, so the first line that did threw `undefined.get` and every case
 * in this file came back 500. A double that lacks what the real request always
 * carries turns a behaviour change into a mystery.
 */
const postReq = (body: unknown, headers: Record<string, string> = {}) =>
  ({
    json: async () => body,
    url: `http://x/api/topics/${TOPIC}/chat/media`,
    headers: new Headers(headers),
  }) as never;
const queryReq = (query: string, headers: Record<string, string> = {}) =>
  ({
    url: `http://x/api/topics/${TOPIC}/chat/media${query}`,
    headers: new Headers(headers),
  }) as never;
const b64 = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString('base64');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ userId: USER, nickname: 'alice', isAI: false });
  mocks.incr.mockResolvedValue(1);
  mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: USER, role: 'member' });
  mocks.putR2Object.mockResolvedValue(undefined);
  mocks.deleteR2Object.mockResolvedValue(true);
  mocks.insertRow.mockResolvedValue(undefined);
  mocks.claimReturning.mockResolvedValue([{ id: 'row-1' }]);
  mocks.updateWhere.mockReturnValue(undefined);
  mocks.deleteRow.mockResolvedValue(undefined);
});

describe('POST — store an encrypted attachment', () => {
  it('A1: 401 for a guest', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await POST(postReq({ mediaId: MEDIA, ciphertext: b64(Buffer.from('x')) }), { params: params() });
    expect(res.status).toBe(401);
    expect(mocks.putR2Object).not.toHaveBeenCalled();
  });

  it('A2: 403 for an authenticated non-member', async () => {
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await POST(postReq({ mediaId: MEDIA, ciphertext: b64(Buffer.from('x')) }), { params: params() });
    expect(res.status).toBe(403);
    expect(mocks.putR2Object).not.toHaveBeenCalled();
  });

  it('stores the bytes under a topic-scoped key and returns it', async () => {
    const res = await POST(postReq({ mediaId: MEDIA, ciphertext: b64(Buffer.from('ciphertext')) }), {
      params: params(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: KEY });
    const [storedKey, storedBuf] = mocks.putR2Object.mock.calls[0];
    expect(storedKey).toBe(KEY);
    expect(Buffer.from(storedBuf).toString()).toBe('ciphertext');
  });

  it('CONTRACT: the bytes are stored verbatim — no sniff, no transcode', async () => {
    // HEIC magic bytes. The plaintext route decodes and re-encodes these; this
    // one must not, because it cannot know what it is holding.
    const heic = Buffer.alloc(32);
    heic.write('ftyp', 4, 'ascii');
    heic.write('heic', 8, 'ascii');
    const res = await POST(postReq({ mediaId: MEDIA, ciphertext: b64(heic) }), { params: params() });
    expect(res.status).toBe(200);
    const [, storedBuf, contentType] = mocks.putR2Object.mock.calls[0];
    expect(Buffer.from(storedBuf).equals(heic)).toBe(true);
    // And it is never labelled as an image.
    expect(contentType === undefined || contentType === 'application/octet-stream').toBe(true);
  });

  it('H1: a blob claiming to be an image is stored unchanged, like any other blob', async () => {
    const hostile = Buffer.from('<script>alert(1)</script>');
    await POST(postReq({ mediaId: MEDIA, ciphertext: b64(hostile) }), { params: params() });
    expect(Buffer.from(mocks.putR2Object.mock.calls[0][1]).equals(hostile)).toBe(true);
  });

  it('400 on a malformed mediaId (uppercase, short, traversal, missing)', async () => {
    for (const mediaId of ['A'.repeat(32), 'abc', '../../etc', '', undefined, 42]) {
      const res = await POST(postReq({ mediaId, ciphertext: b64(Buffer.from('x')) }), { params: params() });
      expect(res.status, String(mediaId)).toBe(400);
    }
    expect(mocks.putR2Object).not.toHaveBeenCalled();
  });

  it('B1: 400 when the ciphertext is empty or missing', async () => {
    for (const ciphertext of ['', undefined, null, 5]) {
      const res = await POST(postReq({ mediaId: MEDIA, ciphertext }), { params: params() });
      expect(res.status, String(ciphertext)).toBe(400);
    }
  });

  it('400 on non-canonical base64', async () => {
    const res = await POST(postReq({ mediaId: MEDIA, ciphertext: 'not!base64' }), { params: params() });
    expect(res.status).toBe(400);
  });

  it('400 on a body that is not JSON', async () => {
    const req = {
      json: async () => {
        throw new Error('bad');
      },
      url: `http://x/api/topics/${TOPIC}/chat/media`,
      headers: new Headers(),
    } as never;
    expect((await POST(req, { params: params() })).status).toBe(400);
  });

  it('413, not a parse error, when the body is over the transport limit', async () => {
    /*
     * The transport refuses an oversized body before any handler runs, and that
     * refusal used to reach the caller as `Body must be JSON` — a sentence
     * about syntax for a file whose only problem was its size. A declared
     * content-length lets the route answer honestly instead.
     */
    const res = await POST(
      postReq({ mediaId: MEDIA, ciphertext: 'x' }, { 'content-length': String(MAX_JSON_BODY_BYTES + 1) }),
      { params: params() },
    );

    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/too large/i);
    expect(mocks.putR2Object).not.toHaveBeenCalled();
  });

  it('B3: exactly the cap is accepted', async () => {
    const at = Buffer.alloc(MAX_CHAT_MEDIA_CIPHERTEXT_BYTES, 1);
    const res = await POST(postReq({ mediaId: MEDIA, ciphertext: b64(at) }), { params: params() });
    expect(res.status).toBe(200);
  });

  it('B4/B5/L1: one past the cap, and double it, are 400 regardless of what the client believes', async () => {
    for (const size of [MAX_CHAT_MEDIA_CIPHERTEXT_BYTES + 1, MAX_CHAT_MEDIA_CIPHERTEXT_BYTES * 2]) {
      const res = await POST(postReq({ mediaId: MEDIA, ciphertext: b64(Buffer.alloc(size, 1)) }), {
        params: params(),
      });
      // 413, not 400: the size is the complaint, and the status now says so.
      expect(res.status, String(size)).toBe(413);
      expect(mocks.putR2Object).not.toHaveBeenCalled();
    }
  });

  it('429 over the per-member rate limit', async () => {
    mocks.incr.mockResolvedValue(99999);
    const res = await POST(postReq({ mediaId: MEDIA, ciphertext: b64(Buffer.from('x')) }), { params: params() });
    expect(res.status).toBe(429);
    expect(mocks.putR2Object).not.toHaveBeenCalled();
  });

  it('U1: nothing the client names ends up in the key', async () => {
    // There is no filename field at all — a Korean / emoji / traversal name has
    // nowhere to go.
    await POST(
      postReq({ mediaId: MEDIA, ciphertext: b64(Buffer.from('x')), filename: '사진 🌟/../../x.png' }),
      { params: params() },
    );
    expect(mocks.putR2Object.mock.calls[0][0]).toBe(KEY);
  });
});

describe('GET — serve ciphertext to a member', () => {
  beforeEach(() => {
    mocks.getR2Object.mockResolvedValue(new Uint8Array([1, 2, 3]));
  });

  it('A3: 401 for a guest', async () => {
    mocks.getSession.mockResolvedValue(null);
    const res = await GET(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(res.status).toBe(401);
    expect(mocks.getR2Object).not.toHaveBeenCalled();
  });

  it('A4: 403 for a non-member — even holding the exact object key', async () => {
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await GET(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(res.status).toBe(403);
    expect(mocks.getR2Object).not.toHaveBeenCalled();
  });

  it('A5: 200 with the opaque bytes for a member', async () => {
    const res = await GET(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(res.status).toBe(200);
    const { ciphertext } = await res.json();
    expect(Buffer.from(ciphertext, 'base64').equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(res.headers.get('Cache-Control')).toContain('private');
  });

  it('H4: a key from another topic is 400, and storage is never touched', async () => {
    const otherTopic = '99999999-9999-9999-9999-999999999999';
    const res = await GET(queryReq(`?key=${encodeURIComponent(otherTopicKey(otherTopic))}`), {
      params: params(),
    });
    expect(res.status).toBe(400);
    expect(mocks.getR2Object).not.toHaveBeenCalled();
  });

  it('H4: traversal, absolute URLs, a missing key and an empty key are 400', async () => {
    const bad = [
      `topics/${TOPIC}/chat/../../secrets/x.bin`,
      'https://evil.example/x.bin',
      `${KEY}/../../..`,
      '',
    ];
    for (const k of bad) {
      const res = await GET(queryReq(`?key=${encodeURIComponent(k)}`), { params: params() });
      expect(res.status, k).toBe(400);
    }
    expect((await GET(queryReq(''), { params: params() })).status).toBe(400);
    expect(mocks.getR2Object).not.toHaveBeenCalled();
  });

  it('404 when the object is gone (a deleted attachment)', async () => {
    mocks.getR2Object.mockResolvedValue(null);
    const res = await GET(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(res.status).toBe(404);
  });
});

describe('M-1 — the index row that makes an object reachable', () => {
  it('CONTRACT: POST writes exactly one index row, BEFORE the object is stored', async () => {
    /*
     * Order is the point. Index after upload and a failed insert strands an
     * object nothing can ever name again — its only other reference is inside a
     * sealed body the server cannot read. Removing the insert fails this test.
     */
    const order: string[] = [];
    mocks.insertRow.mockImplementation(async () => {
      order.push('row');
    });
    mocks.putR2Object.mockImplementation(async () => {
      order.push('object');
    });
    const res = await POST(postReq({ mediaId: MEDIA, ciphertext: b64(Buffer.from('ct')) }), {
      params: params(),
    });
    expect(res.status).toBe(200);
    expect(order).toEqual(['row', 'object']);
    expect(mocks.insertRow).toHaveBeenCalledTimes(1);
    expect(mocks.insertRow).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: TOPIC, objectKey: KEY, uploaderId: USER }),
    );
  });

  it('SI-1: the row carries no key material, mime, filename, size or message id', async () => {
    await POST(postReq({ mediaId: MEDIA, ciphertext: b64(Buffer.from('ct')) }), { params: params() });
    const row = mocks.insertRow.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(['objectKey', 'topicId', 'uploaderId']);
    for (const forbidden of ['messageId', 'mime', 'filename', 'size', 'ciphertext', 'key']) {
      expect(row, forbidden).not.toHaveProperty(forbidden);
    }
  });

  it('REGRESSION: a storage failure leaves NO index row behind', async () => {
    /*
     * Found by driving a real browser at a stack with no R2 credentials: the
     * upload answered 500 and left `chat_media` holding a row for an object
     * that was never written — a handle to nothing, which the collector would
     * not tidy for an hour. The mirror of the insert-before-store rule: the
     * object provably does not exist here, so the row must not either.
     *
     * The mocked-out R2 is what hid this, so the failure is injected as a
     * THROW from the store call, which is what both a missing-config error and
     * a network error actually look like.
     */
    mocks.putR2Object.mockRejectedValueOnce(
      new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, ... environment variables are required'),
    );
    const res = await POST(postReq({ mediaId: MEDIA, ciphertext: b64(Buffer.from('ct')) }), {
      params: params(),
    });
    expect(res.status).toBe(500);
    // The end state of the table, not just the status code.
    expect(mocks.deleteRow).toHaveBeenCalledTimes(1);
  });

  it('REGRESSION: a NETWORK failure from storage rolls the row back the same way', async () => {
    // A missing-config throw and a socket error take the same path; only one of
    // them was exercised before, and the distinction is invisible from here.
    mocks.putR2Object.mockRejectedValueOnce(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }));
    const res = await POST(postReq({ mediaId: MEDIA, ciphertext: b64(Buffer.from('ct')) }), {
      params: params(),
    });
    expect(res.status).toBe(500);
    expect(mocks.deleteRow).toHaveBeenCalledTimes(1);
  });

  it('a rollback that ITSELF fails still answers 500 rather than throwing', async () => {
    // Then the row really is the collector's problem, which is what it is for.
    mocks.putR2Object.mockRejectedValueOnce(new Error('r2 down'));
    mocks.deleteRow.mockRejectedValueOnce(new Error('db down too'));
    const res = await POST(postReq({ mediaId: MEDIA, ciphertext: b64(Buffer.from('ct')) }), {
      params: params(),
    });
    expect(res.status).toBe(500);
  });

  it('a failed index insert fails the upload rather than storing an unreachable object', async () => {
    mocks.insertRow.mockRejectedValueOnce(new Error('unique violation'));
    const res = await POST(postReq({ mediaId: MEDIA, ciphertext: b64(Buffer.from('ct')) }), {
      params: params(),
    });
    expect(res.status).toBe(500);
    expect(mocks.putR2Object).not.toHaveBeenCalled();
  });

  it('CONTRACT: DELETE removes the row with the object, and only after it', async () => {
    const order: string[] = [];
    mocks.deleteR2Object.mockImplementation(async () => {
      order.push('object');
      return true;
    });
    mocks.deleteRow.mockImplementation(async () => {
      order.push('row');
    });
    const res = await DELETE(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(res.status).toBe(200);
    expect(order).toEqual(['object', 'row']);
  });

  it('a DELETE whose object delete failed KEEPS the row, so the sweep retries', async () => {
    mocks.deleteR2Object.mockResolvedValue(false);
    await DELETE(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(mocks.deleteRow).not.toHaveBeenCalled();
  });

  it('CONTRACT: a successful GET claims the object (self-healing)', async () => {
    /*
     * The only way a member holds this key is out of a sealed body they opened,
     * so a read PROVES a live message references the object. That repairs a
     * claim the uploader never managed to send.
     */
    mocks.getR2Object.mockResolvedValue(new Uint8Array([1]));
    const res = await GET(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(res.status).toBe(200);
    expect(mocks.updateWhere).toHaveBeenCalledTimes(1);
  });

  it('a claim write that fails never breaks the read', async () => {
    mocks.getR2Object.mockResolvedValue(new Uint8Array([1]));
    mocks.updateWhere.mockImplementation(() => {
      throw new Error('db down');
    });
    // The throw happens inside the awaited-nowhere update chain; the read must
    // still answer 200.
    const res = await GET(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect([200, 500]).toContain(res.status);
    expect(res.status).toBe(200);
  });
});

describe('PATCH — claim an attachment', () => {
  it('the uploader claims their own object', async () => {
    const res = await PATCH(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: true });
    expect(mocks.claimReturning).toHaveBeenCalledTimes(1);
  });

  it('pre-M-1: a key with no row answers claimed:false rather than erroring', async () => {
    // Every object uploaded before this migration has no row. Claiming one is a
    // no-op, NOT a 404 — there is nothing to claim and nothing that deletes it.
    mocks.claimReturning.mockResolvedValue([]);
    const res = await PATCH(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: false });
  });

  it('a second claim is idempotent — it does not move the timestamp', async () => {
    // The statement matches only `claimed_at IS NULL`, so the second call finds
    // no row and answers false without rewriting anything.
    mocks.claimReturning.mockResolvedValueOnce([{ id: 'row-1' }]).mockResolvedValueOnce([]);
    expect(await (await PATCH(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() })).json()).toEqual({
      claimed: true,
    });
    expect(await (await PATCH(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() })).json()).toEqual({
      claimed: false,
    });
  });

  it('AUTHZ: another member cannot claim somebody else object', async () => {
    mocks.getSession.mockResolvedValue({ userId: '0xother', nickname: 'bob', isAI: false });
    mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: '0xother', role: 'member' });
    const res = await PATCH(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(res.status).toBe(403);
    expect(mocks.claimReturning).not.toHaveBeenCalled();
  });

  it('AUTHZ: guest 401, non-member 403', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await PATCH(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() })).status).toBe(401);
    mocks.getSession.mockResolvedValue({ userId: USER, nickname: 'a', isAI: false });
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    expect((await PATCH(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() })).status).toBe(403);
    expect(mocks.claimReturning).not.toHaveBeenCalled();
  });

  it('H4: a cross-topic or traversal key is 400', async () => {
    const other = '99999999-9999-9999-9999-999999999999';
    for (const k of [otherTopicKey(other), `topics/${TOPIC}/chat/../x/${MEDIA}.bin`, '']) {
      const res = await PATCH(queryReq(`?key=${encodeURIComponent(k)}`), { params: params() });
      expect(res.status, k).toBe(400);
    }
    expect(mocks.claimReturning).not.toHaveBeenCalled();
  });
});

describe('DELETE — clean up an attachment', () => {
  it('the uploader may delete their own object', async () => {
    const res = await DELETE(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(res.status).toBe(200);
    expect(mocks.deleteR2Object).toHaveBeenCalledWith(KEY);
  });

  it('A6: another member may NOT delete somebody else attachment', async () => {
    mocks.getSession.mockResolvedValue({ userId: '0xother', nickname: 'bob', isAI: false });
    mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: '0xother', role: 'member' });
    mocks.topicsFindFirst.mockResolvedValue({ id: TOPIC, creatorId: USER });
    const res = await DELETE(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(res.status).toBe(403);
    expect(mocks.deleteR2Object).not.toHaveBeenCalled();
  });

  it('the topic owner may delete any attachment in their topic', async () => {
    mocks.getSession.mockResolvedValue({ userId: '0xowner', nickname: 'o', isAI: false });
    mocks.topicMembersFindFirst.mockResolvedValue({ topicId: TOPIC, userId: '0xowner', role: 'owner' });
    const res = await DELETE(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(res.status).toBe(200);
  });

  it('A3/A4: guests get 401 and non-members 403', async () => {
    mocks.getSession.mockResolvedValue(null);
    expect((await DELETE(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() })).status).toBe(401);
    mocks.getSession.mockResolvedValue({ userId: USER, nickname: 'a', isAI: false });
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    expect((await DELETE(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() })).status).toBe(403);
    expect(mocks.deleteR2Object).not.toHaveBeenCalled();
  });

  it('H4: a cross-topic key is 400', async () => {
    const other = '99999999-9999-9999-9999-999999999999';
    const res = await DELETE(queryReq(`?key=${encodeURIComponent(otherTopicKey(other))}`), {
      params: params(),
    });
    expect(res.status).toBe(400);
    expect(mocks.deleteR2Object).not.toHaveBeenCalled();
  });
});
