/**
 * R-3 — end-to-end encrypted chat attachments.
 *
 * The defect being closed: a chat picture was uploaded in the clear to a public
 * URL and only the URL string was sealed, so a `secret` topic's images were
 * readable by the operator and by anyone with the link. These tests hold the
 * boundary that replaces it — the file is encrypted before it leaves the
 * device, the uploader never sees plaintext, and a failed send never leaves an
 * object behind.
 *
 * The AEAD itself is exercised in `mls-tak-media.test.ts` against the real
 * ciphersuite; here the seal step is injected so the ORDERING and the failure
 * paths can be asserted without crypto in the way.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHAT_MEDIA_BODY_PREFIX,
  CHAT_MEDIA_FAILED_ROW_TTL_MS,
  CHAT_MEDIA_RETRY_WINDOW_MS,
  MAX_PERSISTED_FAILED_MEDIA,
  addFailedMedia,
  isFailedMediaExpired,
  parseFailedMedia,
  removeFailedMedia,
  serializeFailedMedia,
  type PersistedFailedMedia,
  CHAT_MEDIA_MIME_ALLOWLIST,
  ChatMediaError,
  MAX_CHAT_MEDIA_BYTES,
  base64ToBytes,
  buildChatMediaBody,
  bytesToBase64,
  chatMediaDataUri,
  chatMediaObjectKey,
  isChatMediaBody,
  isChatMediaKeyForTopic,
  isHeicBytes,
  loadEncryptedChatMedia,
  newMediaId,
  parseChatMediaBody,
  resolveChatMediaMime,
  sendEncryptedChatMedia,
  sniffImageMime,
  type ChatMediaEnvelope,
} from '@/lib/chatMedia';

const TOPIC = '11111111-2222-3333-4444-555555555555';
const USER = '0xabc123';
const MEDIA = 'a'.repeat(32);
const KEY = chatMediaObjectKey(TOPIC, USER, MEDIA);

const envelope = (over: Partial<ChatMediaEnvelope> = {}): ChatMediaEnvelope => ({
  v: 1,
  key: KEY,
  mediaId: MEDIA,
  takVersion: 0,
  mime: 'image/png',
  size: 3,
  ...over,
});

/** A send harness whose every step is observable. */
function harness(opts: { sealFails?: boolean; uploadFails?: boolean; sendFails?: boolean } = {}) {
  const uploaded: string[] = [];
  const storedKeys: string[] = [];
  const seal = vi.fn(async (mediaId: string, bytes: Uint8Array) => {
    if (opts.sealFails) return null;
    // Stand-in for the AEAD: whatever it is, it must not be the plaintext.
    const out = new Uint8Array(bytes.length + 1);
    out.set(bytes, 1);
    out[0] = 0xff;
    return { ciphertext: out, takVersion: 7 };
  });
  const upload = vi.fn(async (ciphertextB64: string, mediaId: string) => {
    if (opts.uploadFails) throw new Error('r2 down');
    uploaded.push(ciphertextB64);
    const key = chatMediaObjectKey(TOPIC, USER, mediaId);
    storedKeys.push(key);
    return key;
  });
  const send = vi.fn(async (body: string) => {
    if (opts.sendFails) throw new Error('POST 500');
  });
  const discard = vi.fn(async () => {});
  return { seal, upload, send, discard, uploaded, storedKeys };
}

describe('envelope shape', () => {
  it('round-trips through build/parse', () => {
    const e = envelope();
    const parsed = parseChatMediaBody(buildChatMediaBody(e));
    expect(parsed).toEqual(e);
  });

  it('CONTRACT: an attachment body is recognisable without parsing', () => {
    expect(isChatMediaBody(buildChatMediaBody(envelope()))).toBe(true);
    expect(isChatMediaBody('hello')).toBe(false);
  });

  // E1 — empty / whitespace / null / undefined, each on its own.
  it('E1: empty string is not an envelope', () => expect(parseChatMediaBody('')).toBeNull());
  it('E1: whitespace-only is not an envelope', () => expect(parseChatMediaBody('   \n\t ')).toBeNull());
  it('E1: null is not an envelope', () => expect(parseChatMediaBody(null)).toBeNull());
  it('E1: undefined is not an envelope', () => expect(parseChatMediaBody(undefined)).toBeNull());
  it('E1: a non-string is not an envelope', () => expect(parseChatMediaBody({ v: 1 })).toBeNull());

  // H5 — hostile bodies. Each must fall through to "render as text", never to
  // a client that fetches something on the strength of a typed message.
  it('H5: bare JSON without the prefix is text, not an envelope', () => {
    expect(parseChatMediaBody(JSON.stringify(envelope()))).toBeNull();
  });
  it('H5: the prefix with unparseable JSON is text', () => {
    expect(parseChatMediaBody(`${CHAT_MEDIA_BODY_PREFIX}{not json`)).toBeNull();
  });
  it('H5: an array payload is rejected', () => {
    expect(parseChatMediaBody(`${CHAT_MEDIA_BODY_PREFIX}[1,2,3]`)).toBeNull();
  });
  it('H5: a future version is rejected rather than mis-read', () => {
    expect(parseChatMediaBody(buildChatMediaBody(envelope({ v: 2 as 1 })))).toBeNull();
  });
  it('H5: a traversal key is rejected', () => {
    const body = `${CHAT_MEDIA_BODY_PREFIX}${JSON.stringify({ ...envelope(), key: `topics/${TOPIC}/chat/../../etc/passwd` })}`;
    expect(parseChatMediaBody(body)).toBeNull();
  });
  it('H5: an absolute URL as the key is rejected', () => {
    const body = `${CHAT_MEDIA_BODY_PREFIX}${JSON.stringify({ ...envelope(), key: 'https://evil.example/x.bin' })}`;
    expect(parseChatMediaBody(body)).toBeNull();
  });
  it('H5: a key naming a different mediaId than the envelope is rejected', () => {
    const body = buildChatMediaBody(envelope({ key: chatMediaObjectKey(TOPIC, USER, 'b'.repeat(32)) }));
    expect(parseChatMediaBody(body)).toBeNull();
  });
  it('H5: a non-allowlisted mime is rejected', () => {
    expect(parseChatMediaBody(buildChatMediaBody(envelope({ mime: 'text/html' })))).toBeNull();
    expect(parseChatMediaBody(buildChatMediaBody(envelope({ mime: 'image/heic' })))).toBeNull();
  });
  it('H5: a negative or fractional takVersion is rejected', () => {
    expect(parseChatMediaBody(buildChatMediaBody(envelope({ takVersion: -1 })))).toBeNull();
    expect(parseChatMediaBody(buildChatMediaBody(envelope({ takVersion: 1.5 })))).toBeNull();
  });
  it('H5: a size of 0, or one past the cap, is rejected', () => {
    expect(parseChatMediaBody(buildChatMediaBody(envelope({ size: 0 })))).toBeNull();
    expect(parseChatMediaBody(buildChatMediaBody(envelope({ size: MAX_CHAT_MEDIA_BYTES + 1 })))).toBeNull();
  });
  it('H5: a very large hostile body does not parse into an envelope', () => {
    expect(parseChatMediaBody(`${CHAT_MEDIA_BODY_PREFIX}${'x'.repeat(200_000)}`)).toBeNull();
  });
});

describe('object keys', () => {
  it('H4: a key from another topic is not accepted for this one', () => {
    const other = '99999999-9999-9999-9999-999999999999';
    expect(isChatMediaKeyForTopic(chatMediaObjectKey(other, USER, MEDIA), TOPIC)).toBe(false);
    expect(isChatMediaKeyForTopic(KEY, TOPIC)).toBe(true);
  });
  it('H4: traversal, absolute URLs, empty and non-strings are rejected', () => {
    for (const bad of [`topics/${TOPIC}/chat/../x/${MEDIA}.bin`, 'https://x/y.bin', '', '   ', null, 42, {}]) {
      expect(isChatMediaKeyForTopic(bad, TOPIC), String(bad)).toBe(false);
    }
  });
  it('the topic prefix covers every key the topic can produce', () => {
    expect(KEY).toContain(TOPIC);
  });
  it('U1: the client filename never reaches the object key', () => {
    // The key is derived from ids only, so a Korean / emoji / traversal
    // filename has nowhere to land.
    // Topic-FIRST since M-3: one `topics/{id}/` prefix sweeps a topic's chat
    // attachments, post images and picture together.
    expect(KEY).toBe(`topics/${TOPIC}/chat/${USER}/${MEDIA}.bin`);
    expect(KEY).not.toMatch(/[^\x20-\x7e]/);
  });
  it('media ids are 32 hex and do not repeat', () => {
    const a = newMediaId();
    const b = newMediaId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe('base64 codec', () => {
  it('I1: round-trips arbitrary bytes, including 0x00 and 0xff', () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
  it('B2: round-trips a single byte', () => {
    expect(Array.from(base64ToBytes(bytesToBase64(new Uint8Array([7]))))).toEqual([7]);
  });
  it('handles a payload past one chunk without blowing the stack', () => {
    const bytes = new Uint8Array(0x8000 * 3 + 17).fill(0xab);
    expect(base64ToBytes(bytesToBase64(bytes)).length).toBe(bytes.length);
  });
  it('produces a data URI a native <Image> can read', () => {
    expect(chatMediaDataUri(new Uint8Array([1, 2, 3]), 'image/png')).toBe('data:image/png;base64,AQID');
  });
});

describe('HEIC detection', () => {
  const heic = (brand: string) => {
    const b = new Uint8Array(16);
    const head = `0000ftyp${brand}`;
    for (let i = 0; i < head.length; i++) b[i] = head.charCodeAt(i);
    return b;
  };
  it('H1: recognises every HEIC brand the plaintext route used to transcode', () => {
    for (const brand of ['heic', 'heix', 'mif1', 'msf1']) {
      expect(isHeicBytes(heic(brand)), brand).toBe(true);
    }
  });
  it('does not flag a PNG or a short buffer', () => {
    expect(isHeicBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(isHeicBytes(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(isHeicBytes(new Uint8Array(0))).toBe(false);
  });
});

describe('type resolution — the bytes are the authority', () => {
  const magic = {
    png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    gif: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
    webp: new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]),
    bmp: new Uint8Array([0x42, 0x4d, 1, 2]),
  };

  it('recognises every type the allowlist offers', () => {
    expect(sniffImageMime(magic.png)).toBe('image/png');
    expect(sniffImageMime(magic.jpeg)).toBe('image/jpeg');
    expect(sniffImageMime(magic.gif)).toBe('image/gif');
    expect(sniffImageMime(magic.webp)).toBe('image/webp');
    expect(sniffImageMime(magic.bmp)).toBe('image/bmp');
    for (const mime of Object.values(magic).map((b) => sniffImageMime(b))) {
      expect(CHAT_MEDIA_MIME_ALLOWLIST).toContain(mime!);
    }
  });

  it('recognises nothing in text, an empty buffer, or a truncated header', () => {
    expect(sniffImageMime(new Uint8Array([0x68, 0x69]))).toBeNull();
    expect(sniffImageMime(new Uint8Array(0))).toBeNull();
    expect(sniffImageMime(magic.png.slice(0, 2))).toBeNull();
    // RIFF without WEBP is some other RIFF container, not an image we render.
    expect(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x41, 0x56, 0x49, 0x20]))).toBeNull();
  });

  it('REGRESSION: an empty declared type does not lose a real image', () => {
    // The silent-drop defect: browsers report `''` routinely, and the old guard
    // returned without a word.
    expect(resolveChatMediaMime(magic.png, '', 'photo')).toBe('image/png');
    expect(resolveChatMediaMime(magic.jpeg, undefined, undefined)).toBe('image/jpeg');
  });

  it('the bytes overrule a lying declaration', () => {
    expect(resolveChatMediaMime(magic.jpeg, 'image/png', 'lies.png')).toBe('image/jpeg');
  });

  it('falls back to the declaration, then the extension, then null', () => {
    const unknown = new Uint8Array([1, 2, 3, 4]);
    expect(resolveChatMediaMime(unknown, 'image/webp', 'x.bin')).toBe('image/webp');
    expect(resolveChatMediaMime(unknown, '', 'holiday.JPEG')).toBe('image/jpeg');
    expect(resolveChatMediaMime(unknown, 'application/pdf', 'notes.txt')).toBeNull();
    expect(resolveChatMediaMime(unknown, null, null)).toBeNull();
  });

  it('a non-allowlisted declaration is never trusted', () => {
    const unknown = new Uint8Array([1, 2, 3, 4]);
    // `image/heic` is deliberately not in the allowlist — no client renders it.
    expect(resolveChatMediaMime(unknown, 'image/heic', 'IMG.HEIC')).toBeNull();
  });

  it('UTF-8 filenames resolve by extension like any other', () => {
    const unknown = new Uint8Array([1, 2, 3, 4]);
    expect(resolveChatMediaMime(unknown, '', '사진 🌟.png')).toBe('image/png');
  });
});

describe('sendEncryptedChatMedia', () => {
  const png = new Uint8Array([1, 2, 3]);

  it('C1/C2 CONTRACT: the file is encrypted, and the uploader never sees plaintext', async () => {
    const h = harness();
    await sendEncryptedChatMedia({ bytes: png, mime: 'image/png' }, h);

    // Removing the encrypt step fails BOTH of these.
    expect(h.seal).toHaveBeenCalledTimes(1);
    const uploadedBytes = base64ToBytes(h.uploaded[0]);
    expect(Array.from(uploadedBytes)).not.toEqual(Array.from(png));
    expect(bytesToBase64(png)).not.toBe(h.uploaded[0]);
    // ...and the plaintext must not be a substring of what went up either.
    expect(uploadedBytes.length).toBeGreaterThan(png.length);
  });

  it('CONTRACT: the sealed body carries the reference, never the bytes or a URL', async () => {
    const h = harness();
    await sendEncryptedChatMedia({ bytes: png, mime: 'image/png' }, h);
    const body = h.send.mock.calls[0][0];
    const parsed = parseChatMediaBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.takVersion).toBe(7);
    expect(parsed!.size).toBe(3);
    expect(body).not.toContain('http');
    expect(body).not.toContain(bytesToBase64(png));
  });

  it('B1: a 0-byte file is refused before anything is uploaded', async () => {
    const h = harness();
    await expect(sendEncryptedChatMedia({ bytes: new Uint8Array(0), mime: 'image/png' }, h)).rejects.toMatchObject({
      reason: 'empty',
    });
    expect(h.seal).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('B2: a 1-byte file goes through', async () => {
    const h = harness();
    const env = await sendEncryptedChatMedia({ bytes: new Uint8Array([9]), mime: 'image/png' }, h);
    expect(env.size).toBe(1);
  });

  it('B3: exactly the cap is accepted', async () => {
    const h = harness();
    const env = await sendEncryptedChatMedia(
      { bytes: new Uint8Array(MAX_CHAT_MEDIA_BYTES), mime: 'image/png' },
      h,
    );
    expect(env.size).toBe(MAX_CHAT_MEDIA_BYTES);
  });

  it('B4/B5: one past the cap, and double it, are refused before upload', async () => {
    for (const size of [MAX_CHAT_MEDIA_BYTES + 1, MAX_CHAT_MEDIA_BYTES * 2]) {
      const h = harness();
      await expect(
        sendEncryptedChatMedia({ bytes: new Uint8Array(size), mime: 'image/png' }, h),
      ).rejects.toMatchObject({ reason: 'too-large' });
      expect(h.upload).not.toHaveBeenCalled();
    }
  });

  it('H1: HEIC is refused with its own reason, not sent as an unviewable file', async () => {
    const heic = new Uint8Array(32);
    const head = '0000ftypheic';
    for (let i = 0; i < head.length; i++) heic[i] = head.charCodeAt(i);
    const h = harness();
    await expect(sendEncryptedChatMedia({ bytes: heic, mime: 'image/jpeg' }, h)).rejects.toMatchObject({
      reason: 'heic-unsupported',
    });
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('a type outside the allowlist is refused', async () => {
    const h = harness();
    await expect(sendEncryptedChatMedia({ bytes: png, mime: 'application/pdf' }, h)).rejects.toMatchObject({
      reason: 'unsupported-type',
    });
    expect(CHAT_MEDIA_MIME_ALLOWLIST).not.toContain('application/pdf');
  });

  it('K1: no key means the send FAILS — it never falls back to plaintext', async () => {
    const h = harness({ sealFails: true });
    await expect(sendEncryptedChatMedia({ bytes: png, mime: 'image/png' }, h)).rejects.toMatchObject({
      reason: 'no-key',
    });
    // The whole point: a topic whose key is not ready sends NOTHING rather than
    // sending the picture in the clear.
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('surfaces an upload failure as its own reason', async () => {
    const h = harness({ uploadFails: true });
    await expect(sendEncryptedChatMedia({ bytes: png, mime: 'image/png' }, h)).rejects.toMatchObject({
      reason: 'upload-failed',
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(h.discard).not.toHaveBeenCalled(); // nothing was stored
  });

  it('R1 RACE: an upload that lands while the message POST fails is discarded', async () => {
    const h = harness({ sendFails: true });
    await expect(sendEncryptedChatMedia({ bytes: png, mime: 'image/png' }, h)).rejects.toMatchObject({
      reason: 'send-failed',
    });
    expect(h.upload).toHaveBeenCalledTimes(1);
    // Without this the object is unreferenced AND undeletable: its only
    // reference was inside a message body that never reached anyone.
    expect(h.discard).toHaveBeenCalledWith(h.storedKeys[0]);
  });

  it('M-1 CONTRACT: a successful send claims the object, after the send', async () => {
    // Unclaimed objects are collected after a grace window, so a send that does
    // not claim ships a picture with an expiry nobody asked for.
    const h = harness();
    const claim = vi.fn(async () => {});
    const order: string[] = [];
    h.send.mockImplementation(async () => {
      order.push('send');
    });
    claim.mockImplementation(async () => {
      order.push('claim');
    });
    await sendEncryptedChatMedia({ bytes: png, mime: 'image/png' }, { ...h, claim });
    expect(claim).toHaveBeenCalledWith(h.storedKeys[0]);
    expect(order).toEqual(['send', 'claim']);
  });

  it('M-1: a failed claim does NOT fail a message that already went out', async () => {
    const h = harness();
    const claim = vi.fn(async () => {
      throw new Error('PATCH 500');
    });
    const env = await sendEncryptedChatMedia({ bytes: png, mime: 'image/png' }, { ...h, claim });
    expect(env.key).toBe(h.storedKeys[0]);
    expect(h.discard).not.toHaveBeenCalled(); // the message is out; nothing to undo
  });

  it('M-1: a send that FAILS never claims — it discards instead', async () => {
    const h = harness({ sendFails: true });
    const claim = vi.fn(async () => {});
    await expect(
      sendEncryptedChatMedia({ bytes: png, mime: 'image/png' }, { ...h, claim }),
    ).rejects.toMatchObject({ reason: 'send-failed' });
    expect(claim).not.toHaveBeenCalled();
    expect(h.discard).toHaveBeenCalledWith(h.storedKeys[0]);
  });

  it('R1: a cleanup that itself fails still reports the send failure', async () => {
    const h = harness({ sendFails: true });
    h.discard.mockRejectedValueOnce(new Error('delete 500'));
    await expect(sendEncryptedChatMedia({ bytes: png, mime: 'image/png' }, h)).rejects.toBeInstanceOf(ChatMediaError);
  });
});

describe('loadEncryptedChatMedia', () => {
  const ok = { ok: true as const, bytes: new Uint8Array([1, 2, 3]) };

  it('returns the decrypted bytes on the happy path', async () => {
    const res = await loadEncryptedChatMedia(envelope(), {
      fetchCiphertext: async () => new Uint8Array([9, 9]),
      open: async () => ok,
    });
    expect(res).toEqual({ status: 'ok', bytes: ok.bytes, mime: 'image/png' });
  });

  it('K1: no key is LOCKED — a state that may still resolve', async () => {
    const res = await loadEncryptedChatMedia(envelope(), {
      fetchCiphertext: async () => new Uint8Array([9]),
      open: async () => ({ ok: false, reason: 'no-key' }),
    });
    expect(res.status).toBe('locked');
  });

  it('H2/H3: a wrong key or tampered bytes are DECRYPT-FAILED, not locked', async () => {
    const res = await loadEncryptedChatMedia(envelope(), {
      fetchCiphertext: async () => new Uint8Array([9]),
      open: async () => ({ ok: false, reason: 'decrypt' }),
    });
    expect(res.status).toBe('decrypt-failed');
  });

  it('K2: a fetch that throws is FETCH-FAILED, and is never mistaken for either', async () => {
    const res = await loadEncryptedChatMedia(envelope(), {
      fetchCiphertext: async () => {
        throw new Error('403');
      },
      open: async () => ok,
    });
    expect(res.status).toBe('fetch-failed');
  });

  it('K2: an empty object is a fetch failure, not a decrypt failure', async () => {
    const res = await loadEncryptedChatMedia(envelope(), {
      fetchCiphertext: async () => new Uint8Array(0),
      open: async () => ok,
    });
    expect(res.status).toBe('fetch-failed');
  });

  it('CONTRACT: the four outcomes are distinct — no shared placeholder', () => {
    // A regression that collapses two of these back into one state fails here.
    expect(new Set(['ok', 'locked', 'fetch-failed', 'decrypt-failed']).size).toBe(4);
  });
});

describe('failed attachments that survive a restart', () => {
  const NOW = 1_800_000_000_000;
  const body = buildChatMediaBody(envelope());
  const row = (over: Partial<PersistedFailedMedia> = {}): PersistedFailedMedia => ({
    rowId: 'pending-1',
    body,
    key: KEY,
    createdAt: NOW,
    ...over,
  });

  it('round-trips through serialize/parse', () => {
    expect(parseFailedMedia(serializeFailedMedia([row()]), NOW)).toEqual([row()]);
  });

  it('REGRESSION: a failed row survives a reload — the whole point', () => {
    // It used to live in component state, so an OS-killed app lost the photo
    // with no row, no error, and the bytes collected within the hour.
    const stored = serializeFailedMedia([row()]);
    const restored = parseFailedMedia(stored, NOW + 60_000);
    expect(restored).toHaveLength(1);
    expect(parseChatMediaBody(restored[0].body)?.key).toBe(KEY);
  });

  it('EXPIRY: retry is offered inside the collector grace window and not after', () => {
    // The object is collected an hour after upload, so past that a retry would
    // post a message pointing at nothing.
    expect(isFailedMediaExpired(row(), NOW + CHAT_MEDIA_RETRY_WINDOW_MS)).toBe(false);
    expect(isFailedMediaExpired(row(), NOW + CHAT_MEDIA_RETRY_WINDOW_MS + 1)).toBe(true);
  });

  it('EXPIRY: an expired row is still KEPT — silence was the defect', () => {
    const justExpired = parseFailedMedia(serializeFailedMedia([row()]), NOW + CHAT_MEDIA_RETRY_WINDOW_MS + 1);
    expect(justExpired).toHaveLength(1);
  });

  it('TTL: a row past a day is dropped, so it cannot become litter', () => {
    expect(parseFailedMedia(serializeFailedMedia([row()]), NOW + CHAT_MEDIA_FAILED_ROW_TTL_MS)).toHaveLength(1);
    expect(parseFailedMedia(serializeFailedMedia([row()]), NOW + CHAT_MEDIA_FAILED_ROW_TTL_MS + 1)).toEqual([]);
  });

  it('CAP: keeps the newest and drops the oldest', () => {
    const many = Array.from({ length: MAX_PERSISTED_FAILED_MEDIA + 5 }, (_, i) =>
      row({ rowId: `r${i}`, createdAt: NOW - i * 1000 }),
    );
    const parsed = parseFailedMedia(serializeFailedMedia(many), NOW);
    expect(parsed).toHaveLength(MAX_PERSISTED_FAILED_MEDIA);
    expect(parsed[0].rowId).toBe('r0');
    expect(parsed.some((r) => r.rowId === `r${MAX_PERSISTED_FAILED_MEDIA + 4}`)).toBe(false);
  });

  it('add replaces the same row id rather than duplicating it', () => {
    const once = addFailedMedia([], row());
    const twice = addFailedMedia(once, row({ createdAt: NOW + 5 }));
    expect(twice).toHaveLength(1);
    expect(twice[0].createdAt).toBe(NOW + 5);
  });

  it('add respects the cap, and remove drops exactly one', () => {
    let list: PersistedFailedMedia[] = [];
    for (let i = 0; i < MAX_PERSISTED_FAILED_MEDIA + 3; i++) {
      list = addFailedMedia(list, row({ rowId: `r${i}`, createdAt: NOW + i }));
    }
    expect(list).toHaveLength(MAX_PERSISTED_FAILED_MEDIA);
    const after = removeFailedMedia(list, list[0].rowId);
    expect(after).toHaveLength(MAX_PERSISTED_FAILED_MEDIA - 1);
    expect(after.some((r) => r.rowId === list[0].rowId)).toBe(false);
  });

  it('HOSTILE: storage is a place other software writes to, so garbage costs a row not the room', () => {
    for (const bad of ['', 'not json', '{}', '[1,2,3]', null, undefined, 42, [{ rowId: 'x' }]]) {
      expect(parseFailedMedia(bad, NOW), String(bad)).toEqual([]);
    }
  });

  it('HOSTILE: a row whose body is not an envelope is discarded', () => {
    const forged = serializeFailedMedia([row({ body: 'just some text' })]);
    expect(parseFailedMedia(forged, NOW)).toEqual([]);
  });

  it('HOSTILE: a key that disagrees with its body is discarded', () => {
    // Otherwise Discard would delete an object the body never named.
    const mismatched = serializeFailedMedia([row({ key: chatMediaObjectKey(TOPIC, USER, 'b'.repeat(32)) })]);
    expect(parseFailedMedia(mismatched, NOW)).toEqual([]);
  });

  it('SI-1: what is stored is a reference, never the picture', () => {
    const stored = serializeFailedMedia([row()]);
    // The envelope names an object and a TAK version; the bytes stay uploaded.
    expect(stored).toContain(KEY);
    expect(stored).not.toContain('ciphertext');
    expect(JSON.parse(stored)[0]).toEqual({ rowId: 'pending-1', body, key: KEY, createdAt: NOW });
  });
});

describe('web / mobile twin', () => {
  it('the mobile copy is byte-identical', () => {
    // These rules decide what leaves the device. Two copies that drift are two
    // different answers to "is this encrypted", which is the whole subject.
    const web = readFileSync(join(process.cwd(), 'src/lib/chatMedia.ts'), 'utf8');
    const mobile = readFileSync(join(process.cwd(), 'packages/mobile/src/lib/chatMedia.ts'), 'utf8');
    expect(mobile).toBe(web);
  });
});
