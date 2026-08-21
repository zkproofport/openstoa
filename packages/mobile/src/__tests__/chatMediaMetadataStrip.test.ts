/**
 * Metadata stripping for chat attachments — the MINI-APP side.
 *
 * The web suite (`src/__tests__/chatMediaMetadataStrip.test.ts`) exercises the
 * same shared implementation and can decode its output with sharp, so it owns
 * the "does a decoder still see a portrait photo" assertions. This file exists
 * for the three things only the mini-app can be asked:
 *
 *   1. that the mini-app's OWN import path reaches the stripping version —
 *      `packages/mobile/src/lib/chatMedia.ts` is a re-export, and a re-export
 *      that silently stops re-exporting is exactly how the SDK copy of this
 *      module once fell 667 lines behind;
 *   2. that the strip runs with NOTHING from Node available. There is no
 *      sharp, no canvas and no `Buffer` under Hermes, which is why the shared
 *      strip is written in `Uint8Array` and arithmetic. The test deletes
 *      `globalThis.Buffer` around the call, so a Node-only helper creeping in
 *      fails here rather than on a device;
 *   3. that the picker's shape — base64 in, bytes out — reaches the strip.
 *
 * No new dependency was added for any of this, on either client.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ChatMediaError,
  base64ToBytes,
  chatMediaObjectKey,
  parseChatMediaBody,
  sendEncryptedChatMedia,
} from '../lib/chatMedia';
import {
  ImageMetadataError,
  readOrientationFromTiff,
  stripImageMetadata,
} from '../../../mls/src/imageMetadata';
import {
  SECRETS,
  bmpWithTrailingData,
  concatBytes,
  containsText,
  gifWithMetadata,
  jpegWithMetadata,
  latin1,
  pngWithMetadata,
  webpWithMetadata,
} from '../../../mls/src/__tests__/imageFixtures';

const TOPIC = '11111111-2222-3333-4444-555555555555';
const USER = '0xabc123';
const ALL_SECRETS = Object.values(SECRETS);
/** What the JPEG fixture actually carries — the PNG/GIF strings are not in it. */
const JPEG_SECRETS = ALL_SECRETS.filter((v) => v !== SECRETS.pngText && v !== SECRETS.gifComment);

/**
 * Runs `fn` with the Node-only globals removed.
 *
 * Hermes has no `Buffer`. Vitest runs on Node, which does, so a `Buffer.from`
 * that sneaks into the shared strip would pass every test here and crash on
 * the first attachment a person sends from the phone. Removing it for the
 * duration of the call is the closest this suite gets to a device.
 */
function asHermes<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const buffer = g.Buffer;
  delete g.Buffer;
  try {
    return fn();
  } finally {
    g.Buffer = buffer;
  }
}

function assertNoSecrets(out: Uint8Array, secrets: readonly string[] = ALL_SECRETS) {
  for (const secret of secrets) {
    expect(containsText(out, secret), `output still contains "${secret}"`).toBe(false);
  }
}

function assertFixtureCarries(input: Uint8Array, secrets: readonly string[] = JPEG_SECRETS) {
  for (const secret of secrets) {
    expect(containsText(input, secret), `fixture is missing "${secret}"`).toBe(true);
  }
}

/** base64 without `Buffer` — the picker hands the screen exactly this. */
function toBase64(bytes: Uint8Array): string {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += CHARS[a >> 2];
    out += CHARS[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? CHARS[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? CHARS[c & 63] : '=';
  }
  return out;
}

function harness() {
  const sealedPlaintext: Uint8Array[] = [];
  const seal = vi.fn(async (_mediaId: string, bytes: Uint8Array) => {
    sealedPlaintext.push(bytes);
    const out = new Uint8Array(bytes.length + 1);
    out.set(bytes, 1);
    out[0] = 0xff;
    return { ciphertext: out, takVersion: 3 };
  });
  const upload = vi.fn(async (_ciphertext: Uint8Array, mediaId: string) =>
    chatMediaObjectKey(TOPIC, USER, mediaId),
  );
  const send = vi.fn(async (_body: string) => {});
  const discard = vi.fn(async () => {});
  return { seal, upload, send, discard, sealedPlaintext };
}

describe('mini-app: the shared strip runs where Node does not', () => {
  it('M1: a camera JPEG loses GPS, capture time, camera model and serial — with no Buffer', () => {
    const input = jpegWithMetadata();
    assertFixtureCarries(input);

    const { bytes: out, strategy } = asHermes(() => stripImageMetadata(input));
    expect(strategy).toBe('surgical');
    assertNoSecrets(out);
  });

  it('M2: every allowlisted container is cleaned with no Buffer present', () => {
    const inputs: Array<[string, Uint8Array]> = [
      ['jpeg', jpegWithMetadata()],
      ['png', pngWithMetadata({ orientation: 6 })],
      ['webp', webpWithMetadata({ orientation: 6 })],
      ['gif', gifWithMetadata()],
      ['bmp', bmpWithTrailingData()],
    ];
    for (const [name, bytes] of inputs) {
      const out = asHermes(() => stripImageMetadata(bytes).bytes);
      assertNoSecrets(out);
      expect(out.length, name).toBeGreaterThan(0);
    }
  });

  it('M3: orientation survives, so a portrait photo does not arrive sideways', () => {
    // A phone photo is `Orientation = 6` and pixels that are landscape. Drop
    // the tag and the recipient sees it rotated — the most common self-
    // inflicted wound in this area.
    const out = asHermes(() => stripImageMetadata(jpegWithMetadata({ orientation: 6 })).bytes);
    const app1 = out.subarray(12, 38);
    expect(readOrientationFromTiff(app1)).toBe(6);
    // ...and the block it rides in is one tag long: no IFD1, no thumbnail.
    expect(app1.length).toBe(26);
  });

  it('M4: the embedded thumbnail is gone', () => {
    // It is not regenerated when the main image is cropped or redacted, so it
    // can hand over the region that was removed.
    const input = jpegWithMetadata();
    assertFixtureCarries(input, [SECRETS.thumbnail]);
    const out = asHermes(() => stripImageMetadata(input).bytes);
    expect(containsText(out, SECRETS.thumbnail)).toBe(false);
  });

  it('M5: a corrupt image is refused with a typed error, not a crash', () => {
    const corrupt = concatBytes([
      new Uint8Array([0xff, 0xd8]),
      new Uint8Array([0xff, 0xe1, 0x7f, 0xff]),
      latin1('truncated'),
    ]);
    let thrown: unknown;
    try {
      asHermes(() => stripImageMetadata(corrupt));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ImageMetadataError);
  });
});

describe('mini-app CONTRACT: the strip is in the send path the screen calls', () => {
  it('M6: the bytes handed to `seal` are the stripped ones', async () => {
    /*
     * The row that catches a refactor dropping the strip. `ChatRoomScreen`'s
     * `uploadOne` calls exactly this function with exactly these deps, so an
     * assertion at the encryption boundary covers the screen without mounting
     * it — and covers it however the screen is later rewritten.
     */
    const h = harness();
    const input = jpegWithMetadata();
    assertFixtureCarries(input);

    await sendEncryptedChatMedia({ bytes: input, mime: 'image/jpeg' }, h);

    expect(h.seal).toHaveBeenCalledTimes(1);
    assertNoSecrets(h.sealedPlaintext[0]);
    assertNoSecrets((h.upload.mock.calls[0] as [Uint8Array, string])[0]);
  });

  it('M7: the picker path — base64 in, stripped bytes sealed', async () => {
    /*
     * The mini-app never holds a `File`; `sendPickedAssets` hands the screen
     * `asset.base64` and `uploadOne` turns it into bytes. This is that hop,
     * end to end, so the strip cannot be sitting on a branch the phone does
     * not take.
     */
    const h = harness();
    const picked = { base64: toBase64(jpegWithMetadata()), mimeType: 'image/jpeg' };
    const bytes = base64ToBytes(picked.base64);
    assertFixtureCarries(bytes);

    await sendEncryptedChatMedia({ bytes, mime: picked.mimeType }, h);
    assertNoSecrets(h.sealedPlaintext[0]);

    const parsed = parseChatMediaBody(h.send.mock.calls[0][0]);
    expect(parsed!.size).toBe(h.sealedPlaintext[0].length);
    expect(parsed!.size).toBeLessThan(bytes.length);
  });

  it('M8: a corrupt pick fails the send instead of uploading the original', async () => {
    const h = harness();
    const err = await sendEncryptedChatMedia(
      { bytes: latin1('not an image'), mime: 'image/png' },
      h,
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ChatMediaError);
    expect(err.reason).toBe('strip-failed');
    expect(h.seal).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('M9: the mini-app re-export really does reach the strip', async () => {
    /*
     * `packages/mobile/src/lib/chatMedia.ts` is a path alias. If it ever stops
     * pointing at the shared package — or someone re-adds a local copy — this
     * fails while everything importing the shared module directly keeps
     * passing, which is the failure mode that re-export file was created for.
     */
    const h = harness();
    await sendEncryptedChatMedia({ bytes: pngWithMetadata({ orientation: 6 }), mime: 'image/png' }, h);
    assertNoSecrets(h.sealedPlaintext[0]);
    expect(h.sealedPlaintext[0]).not.toEqual(pngWithMetadata({ orientation: 6 }));
  });
});
