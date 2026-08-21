import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { SECRETS, jpegWithMetadata, jpegWithThumbnail } from './fixtures/images';

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/r2', () => ({ uploadToR2: vi.fn(), deleteFromR2ByUrl: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const SESSION = { userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() };

function uploadRequest(bytes: Buffer, name = 'photo.jpg', type = 'image/jpeg') {
  const formData = new FormData();
  formData.append('file', new File([new Uint8Array(bytes)], name, { type }));
  return new NextRequest('http://localhost:3200/api/upload', { method: 'POST', body: formData });
}

async function authedRoute() {
  const { getSession } = await import('@/lib/session');
  vi.mocked(getSession).mockResolvedValue(SESSION);
  const { uploadToR2 } = await import('@/lib/r2');
  vi.mocked(uploadToR2).mockResolvedValue('https://media.test/staging/posts/user-1/uuid/photo.jpg');
  const { POST } = await import('@/app/api/upload/route');
  return { POST, uploadToR2: vi.mocked(uploadToR2) };
}

describe('POST /api/upload — metadata stripping', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unmock('@/lib/imageMetadata');
  });

  it('publishes bytes with no GPS, timestamp, camera, XMP, IPTC or comment', async () => {
    const { POST, uploadToR2 } = await authedRoute();
    const original = await jpegWithMetadata();

    const res = await POST(uploadRequest(original));
    expect(res.status).toBe(200);

    const uploaded = uploadToR2.mock.calls[0][0] as Buffer;
    for (const secret of Object.values(SECRETS)) {
      expect(uploaded.includes(Buffer.from(secret, 'utf8')), `uploaded bytes leak "${secret}"`).toBe(false);
    }
    expect(uploaded.length).toBeLessThan(original.length);
  });

  it('publishes no embedded thumbnail', async () => {
    const { POST, uploadToR2 } = await authedRoute();
    const res = await POST(uploadRequest(await jpegWithThumbnail()));

    expect(res.status).toBe(200);
    const uploaded = uploadToR2.mock.calls[0][0] as Buffer;
    expect(uploaded.includes(Buffer.from(SECRETS.thumbnail))).toBe(false);
  });

  it('strips a small image too — the strip is not gated on the size check', async () => {
    const { POST, uploadToR2 } = await authedRoute();
    const tiny = await jpegWithMetadata({ width: 4, height: 4 });
    expect(tiny.length).toBeLessThan(10 * 1024); // nowhere near the 10MB cap

    expect((await POST(uploadRequest(tiny))).status).toBe(200);
    const uploaded = uploadToR2.mock.calls[0][0] as Buffer;
    expect(uploaded.includes(Buffer.from(SECRETS.make))).toBe(false);
  });

  it('refuses the upload when the image cannot be parsed (fails closed)', async () => {
    const { POST, uploadToR2 } = await authedRoute();
    const truncated = (await jpegWithMetadata()).subarray(0, 40);

    const res = await POST(uploadRequest(truncated));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/could not read this image/i);
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  it('answers 500, and uploads nothing, when the server cannot run the strip', async () => {
    vi.doMock('@/lib/imageMetadata', async () => {
      const actual = await vi.importActual<typeof import('@/lib/imageMetadata')>('@/lib/imageMetadata');
      return {
        ...actual,
        stripImageMetadata: vi.fn().mockRejectedValue(
          new actual.ImageMetadataError('unsupported', 'sharp is unavailable'),
        ),
      };
    });
    const { POST, uploadToR2 } = await authedRoute();

    const res = await POST(uploadRequest(await jpegWithMetadata()));
    expect(res.status).toBe(500);
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  /*
   * CONTRACT: this fails if the strip call is ever deleted from the route.
   * The mock returns a sentinel buffer that no image encoder would produce, so
   * the assertion can only pass if the route uploaded the strip's OUTPUT.
   */
  it('calls stripImageMetadata with the uploaded bytes and uploads its output', async () => {
    const SENTINEL = Buffer.from('STRIPPED-BY-THE-CONTRACT-TEST');
    const stripImageMetadata = vi.fn().mockResolvedValue({
      buffer: SENTINEL,
      format: 'jpeg',
      strategy: 'surgical',
    });
    vi.doMock('@/lib/imageMetadata', async () => {
      const actual = await vi.importActual<typeof import('@/lib/imageMetadata')>('@/lib/imageMetadata');
      return { ...actual, stripImageMetadata };
    });

    const { POST, uploadToR2 } = await authedRoute();
    const original = await jpegWithMetadata();
    const res = await POST(uploadRequest(original));

    expect(res.status).toBe(200);
    expect(stripImageMetadata).toHaveBeenCalledTimes(1);
    expect(Buffer.from(stripImageMetadata.mock.calls[0][0])).toEqual(original);
    expect(uploadToR2.mock.calls[0][0]).toEqual(SENTINEL);
  });

  /*
   * NOT COVERED HERE: the HEIC branch. The route loads `heic-convert` through
   * `require()`, which vitest cannot intercept, and there is no real HEIC
   * fixture in the repo to feed the genuine decoder. The strip runs on the
   * final `buffer` after that branch has reassigned it, so it applies to the
   * converted JPEG as well — but that ordering is asserted by reading the
   * route, not by this suite.
   */
});
