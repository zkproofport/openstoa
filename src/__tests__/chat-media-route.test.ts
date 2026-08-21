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
import {
  CHAT_MEDIA_CONTENT_TYPE,
  MAX_CHAT_MEDIA_BYTES,
  MAX_CHAT_MEDIA_CIPHERTEXT_BYTES,
  MAX_REQUEST_BODY_BYTES,
  chatMediaObjectKey,
} from '@/lib/chatMedia';

const params = () => Promise.resolve({ topicId: TOPIC });
/*
 * `headers` is part of the double because the route reads it — for the
 * caller's `Accept` and for `content-length`. It was omitted while nothing
 * touched it, so the first line that did threw `undefined.get` and every case
 * in this file came back 500. A double that lacks what the real request always
 * carries turns a behaviour change into a mystery.
 */
/**
 * An upload: RAW BYTES as the body, the media id in the query string.
 *
 * The `content-type` is part of the double because the route now refuses a
 * request that is not framed as octets — there is one shape, so anything else
 * is a stale client and gets 415 rather than a puzzling 400 about a field it
 * did not send.
 */
const postReq = (
  body: Uint8Array | Buffer | null,
  over: { headers?: Record<string, string>; mediaId?: string | null; throwOnRead?: boolean } = {},
) => {
  const mediaId = over.mediaId === undefined ? MEDIA : over.mediaId;
  const query = mediaId === null ? '' : `?mediaId=${encodeURIComponent(mediaId)}`;
  /*
   * ONE copy, detached from Node's buffer pool.
   *
   * `Buffer.from(x).buffer` hands back the whole 8KB pool a small Buffer was
   * allocated inside, so returning it would give the route the neighbouring
   * allocations too — which is exactly what a first draft of this helper did,
   * and the single-byte case came back nine bytes long.
   */
  const src = Buffer.from(body ?? new Uint8Array(0));
  const detached = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength);
  return {
    arrayBuffer: async () => {
      if (over.throwOnRead) throw new Error('body unreadable');
      return detached;
    },
    url: `http://x/api/topics/${TOPIC}/chat/media${query}`,
    headers: new Headers({ 'content-type': CHAT_MEDIA_CONTENT_TYPE, ...(over.headers ?? {}) }),
  } as never;
};
const queryReq = (query: string, headers: Record<string, string> = {}) =>
  ({
    url: `http://x/api/topics/${TOPIC}/chat/media${query}`,
    headers: new Headers(headers),
  }) as never;
const bytes = (s: string) => new Uint8Array(Buffer.from(s));

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
    const res = await POST(postReq(bytes('x')), { params: params() });
    expect(res.status).toBe(401);
    expect(mocks.putR2Object).not.toHaveBeenCalled();
  });

  it('A2: 403 for an authenticated non-member', async () => {
    mocks.topicMembersFindFirst.mockResolvedValue(undefined);
    const res = await POST(postReq(bytes('x')), { params: params() });
    expect(res.status).toBe(403);
    expect(mocks.putR2Object).not.toHaveBeenCalled();
  });

  it('stores the bytes under a topic-scoped key and returns it', async () => {
    const res = await POST(postReq(bytes('ciphertext')), { params: params() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: KEY });
    const [storedKey, storedBuf] = mocks.putR2Object.mock.calls[0];
    expect(storedKey).toBe(KEY);
    expect(Buffer.from(storedBuf).toString()).toBe('ciphertext');
  });

  it('CONTRACT: the request body IS the ciphertext — no base64, no JSON', async () => {
    /*
     * The transport change, pinned. The body used to be
     * `{"mediaId":"…","ciphertext":"<base64>"}`, which spent a third of a 10MB
     * ceiling on an encoding neither end wanted and made the advertised
     * attachment size unreachable. A revert would store the JSON document
     * verbatim as if it were ciphertext, so this asserts the bytes go through
     * BYTE-FOR-BYTE, including ones no base64 alphabet contains.
     */
    const raw = new Uint8Array([0x00, 0xff, 0x7b, 0x22, 0x0a, 0x80]);
    const res = await POST(postReq(raw), { params: params() });
    expect(res.status).toBe(200);
    expect(Array.from(mocks.putR2Object.mock.calls[0][1] as Uint8Array)).toEqual(Array.from(raw));
  });

  it('CONTRACT: the bytes are stored verbatim — no sniff, no transcode', async () => {
    // HEIC magic bytes. The plaintext route decodes and re-encodes these; this
    // one must not, because it cannot know what it is holding.
    const heic = Buffer.alloc(32);
    heic.write('ftyp', 4, 'ascii');
    heic.write('heic', 8, 'ascii');
    const res = await POST(postReq(heic), { params: params() });
    expect(res.status).toBe(200);
    const [, storedBuf, contentType] = mocks.putR2Object.mock.calls[0];
    expect(Buffer.from(storedBuf).equals(heic)).toBe(true);
    // And it is never labelled as an image.
    expect(contentType === undefined || contentType === 'application/octet-stream').toBe(true);
  });

  it('H1: a blob claiming to be an image is stored unchanged, like any other blob', async () => {
    const hostile = Buffer.from('<script>alert(1)</script>');
    await POST(postReq(hostile), { params: params() });
    expect(Buffer.from(mocks.putR2Object.mock.calls[0][1]).equals(hostile)).toBe(true);
  });

  it('415 when the body is not framed as octets', async () => {
    /*
     * There is exactly one shape now. A stale client still POSTing JSON must be
     * refused rather than have its `{"mediaId":…}` document written to storage
     * as ciphertext — an object that would then fail to decrypt on every reader
     * forever, with nothing anywhere saying why.
     */
    for (const ct of ['application/json', 'text/plain', 'multipart/form-data; boundary=x', '']) {
      const res = await POST(postReq(bytes('x'), { headers: { 'content-type': ct } }), {
        params: params(),
      });
      expect(res.status, ct).toBe(415);
    }
    expect(mocks.putR2Object).not.toHaveBeenCalled();
  });

  it('accepts the framing with a charset or odd casing, which proxies add', async () => {
    for (const ct of ['Application/Octet-Stream', 'application/octet-stream; charset=binary', ' application/octet-stream ']) {
      mocks.putR2Object.mockClear();
      const res = await POST(postReq(bytes('x'), { headers: { 'content-type': ct } }), {
        params: params(),
      });
      expect(res.status, ct).toBe(200);
    }
  });

  it('400 on a malformed mediaId (uppercase, short, traversal, missing)', async () => {
    for (const mediaId of ['A'.repeat(32), 'abc', '../../etc', '', null]) {
      const res = await POST(postReq(bytes('x'), { mediaId }), { params: params() });
      expect(res.status, String(mediaId)).toBe(400);
    }
    expect(mocks.putR2Object).not.toHaveBeenCalled();
  });

  it('B1: 400 when the body is empty', async () => {
    const res = await POST(postReq(new Uint8Array(0)), { params: params() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/empty/i);
    expect(mocks.putR2Object).not.toHaveBeenCalled();
  });

  it('B2: a single byte is stored', async () => {
    const res = await POST(postReq(new Uint8Array([7])), { params: params() });
    expect(res.status).toBe(200);
    expect(Array.from(mocks.putR2Object.mock.calls[0][1] as Uint8Array)).toEqual([7]);
  });

  it('400 on a body that cannot be read', async () => {
    const res = await POST(postReq(bytes('x'), { throwOnRead: true }), { params: params() });
    expect(res.status).toBe(400);
    expect(mocks.putR2Object).not.toHaveBeenCalled();
  });

  it('413, not a read error, when the declared length is over the transport limit', async () => {
    /*
     * The transport refuses an oversized body before any handler runs, and that
     * refusal used to reach the caller as `Body must be JSON` — a sentence
     * about syntax for a file whose only problem was its size. A declared
     * content-length lets the route answer honestly instead.
     */
    const res = await POST(
      postReq(bytes('x'), { headers: { 'content-length': String(MAX_REQUEST_BODY_BYTES + 1) } }),
      { params: params() },
    );

    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/too large/i);
    expect(mocks.putR2Object).not.toHaveBeenCalled();
  });

  it('CONTRACT: the refusal names the REAL limit, derived from the cap', async () => {
    /*
     * The sentence and the cap drifted once: it said 10MB while the transport
     * refused anything over ~7.4MB, so a person was handed a number they could
     * not reach. It must say the current cap, whatever that is — and with the
     * base64 term gone, that is 9MB rather than 7MB.
     */
    const res = await POST(postReq(Buffer.alloc(MAX_CHAT_MEDIA_CIPHERTEXT_BYTES + 1, 1)), {
      params: params(),
    });
    expect(res.status).toBe(413);
    const expected = Math.floor(MAX_CHAT_MEDIA_BYTES / (1024 * 1024));
    expect((await res.json()).error).toContain(`${expected}MB`);
    expect(expected).toBe(9);
  });

  it('B3: exactly the cap is accepted', async () => {
    const at = Buffer.alloc(MAX_CHAT_MEDIA_CIPHERTEXT_BYTES, 1);
    const res = await POST(postReq(at), { params: params() });
    expect(res.status).toBe(200);
  });

  it('B4/B5/L1: one past the cap, and double it, are 413 whatever the client claimed', async () => {
    for (const size of [MAX_CHAT_MEDIA_CIPHERTEXT_BYTES + 1, MAX_CHAT_MEDIA_CIPHERTEXT_BYTES * 2]) {
      const res = await POST(
        // An UNDERSTATED content-length: the header is a claim, the decoded
        // length is the fact, and only the second one may decide this.
        postReq(Buffer.alloc(size, 1), { headers: { 'content-length': '10' } }),
        { params: params() },
      );
      expect(res.status, String(size)).toBe(413);
      expect(mocks.putR2Object).not.toHaveBeenCalled();
    }
  });

  it('429 over the per-member rate limit', async () => {
    mocks.incr.mockResolvedValue(99999);
    const res = await POST(postReq(bytes('x')), { params: params() });
    expect(res.status).toBe(429);
    expect(mocks.putR2Object).not.toHaveBeenCalled();
  });

  it('U1: nothing the client names ends up in the key', async () => {
    /*
     * There is no filename field at all. The key is built from the topic, the
     * session and the media id, so a Korean / emoji / traversal name has
     * nowhere to go — not in the body (which is bytes), and not in the query
     * string, which is the one place a caller could now try to put one.
     */
    const hostile = encodeURIComponent('사진 🌟/../../x.png');
    const req = postReq(bytes('x')) as unknown as { url: string };
    req.url = `${req.url}&filename=${hostile}&key=topics/evil/chat/e/${'b'.repeat(32)}.bin`;
    await POST(req as never, { params: params() });
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
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(res.headers.get('Cache-Control')).toContain('private');
  });

  it('CONTRACT: ONE response shape — octets, whatever the caller says it accepts', async () => {
    /*
     * The base64-in-JSON alternative is gone rather than kept for
     * compatibility. Leaving it would leave a path that is slower, has a
     * smaller effective ceiling, and that nothing tests — the shape a future
     * reader picks by accident. It also silently broke the agent SDK, which
     * sent no `Accept` at all and read the bytes of a JSON document as if they
     * were ciphertext.
     *
     * So every Accept gets the same answer, including the one that used to
     * select JSON and the one that sent nothing.
     */
    for (const accept of ['application/json', 'application/octet-stream', '*/*', '']) {
      const res = await GET(queryReq(`?key=${encodeURIComponent(KEY)}`, { accept }), {
        params: params(),
      });
      expect(res.status, accept).toBe(200);
      expect(res.headers.get('Content-Type'), accept).toBe(CHAT_MEDIA_CONTENT_TYPE);
      expect(res.headers.get('Content-Length'), accept).toBe('3');
      expect(Array.from(new Uint8Array(await res.arrayBuffer())), accept).toEqual([1, 2, 3]);
    }
  });

  it('INTEGRITY: bytes no base64 alphabet contains survive the round trip', async () => {
    const raw = new Uint8Array([0x00, 0xff, 0x80, 0x0a, 0x7f]);
    mocks.getR2Object.mockResolvedValue(raw);
    const res = await GET(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(raw));
  });

  it('the response is never sniffable as a media type', async () => {
    // The server cannot know what these bytes are; a browser guessing on its
    // behalf is the one thing worse than saying nothing.
    const res = await GET(queryReq(`?key=${encodeURIComponent(KEY)}`), { params: params() });
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
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
    const res = await POST(postReq(bytes('ct')), {
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
    await POST(postReq(bytes('ct')), { params: params() });
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
    const res = await POST(postReq(bytes('ct')), {
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
    const res = await POST(postReq(bytes('ct')), {
      params: params(),
    });
    expect(res.status).toBe(500);
    expect(mocks.deleteRow).toHaveBeenCalledTimes(1);
  });

  it('a rollback that ITSELF fails still answers 500 rather than throwing', async () => {
    // Then the row really is the collector's problem, which is what it is for.
    mocks.putR2Object.mockRejectedValueOnce(new Error('r2 down'));
    mocks.deleteRow.mockRejectedValueOnce(new Error('db down too'));
    const res = await POST(postReq(bytes('ct')), {
      params: params(),
    });
    expect(res.status).toBe(500);
  });

  it('a failed index insert fails the upload rather than storing an unreachable object', async () => {
    mocks.insertRow.mockRejectedValueOnce(new Error('unique violation'));
    const res = await POST(postReq(bytes('ct')), {
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
