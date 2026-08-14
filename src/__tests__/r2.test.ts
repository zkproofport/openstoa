import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn().mockResolvedValue({});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: vi.fn().mockImplementation((input) => input),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

beforeAll(() => {
  process.env.R2_ACCOUNT_ID = 'test-account';
  process.env.R2_ACCESS_KEY_ID = 'test-key';
  process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
  process.env.R2_BUCKET_NAME = 'test-bucket';
  process.env.R2_PUBLIC_URL = 'https://cdn.example.com';
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({});
  // Reset the module-level singleton so each test gets a fresh client
  vi.resetModules();
});

describe('uploadToR2', () => {
  it('calls S3 send and returns public URL', async () => {
    const { uploadToR2 } = await import('@/lib/r2');
    const buf = Buffer.from('data');

    const url = await uploadToR2(buf, 'image/png', 'user-1', 'post', 'test.png');

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(url).toMatch(/^https:\/\/cdn\.example\.com\//);
    expect(url).toContain('test.png');
  });

  it('uses a UUID-based filename when no filename is provided', async () => {
    const { uploadToR2 } = await import('@/lib/r2');
    const buf = Buffer.from('inline');

    const url = await uploadToR2(buf, 'image/jpeg', 'user-1', 'post');

    // filename should start with 'inline-' and end with '.jpg'
    expect(url).toMatch(/inline-[0-9a-f-]+\.jpg/);
  });

  it('includes the purpose folder in publicUrl', async () => {
    const { uploadToR2 } = await import('@/lib/r2');

    // Keys are partitioned by TOPIC now (M-3), so the purpose folder sits
    // inside the topic rather than at the root: one prefix sweep deletes a
    // topic's pictures with it.
    const TOPIC = '11111111-2222-4333-8444-555555555555';
    const postUrl = await uploadToR2(Buffer.from('x'), 'image/png', 'u1', 'post', 'img.png', TOPIC);
    expect(postUrl).toContain(`/topics/${TOPIC}/posts/`);

    vi.resetModules();
    const { uploadToR2: upload2 } = await import('@/lib/r2');
    const topicUrl = await upload2(Buffer.from('x'), 'image/png', 'u1', 'topic', 'cover.png', TOPIC);
    expect(topicUrl).toContain(`/topics/${TOPIC}/image/`);

    vi.resetModules();
    const { uploadToR2: upload3 } = await import('@/lib/r2');
    // An avatar is USER-scoped: it belongs to the person, not to any topic, so
    // it keeps a `users/{id}/profile/` key and is untouched by a topic sweep.
    const avatarUrl = await upload3(Buffer.from('x'), 'image/png', 'u1', 'avatar', 'avatar.png');
    expect(avatarUrl).toContain('/users/u1/profile/');
  });
});

// M-6 (docs/design/media-bucket-privatisation.md, candidate B): `uploadToR2`
// builds `${config.R2_PUBLIC_URL}/${key}` (see the file above) — this proves
// that claim rather than trusting it. R2_PUBLIC_URL is root-relative
// (`/api/media`) in real deployments now, so a new upload must mint a
// relative URL with NO code change to `uploadToR2` itself.
describe('root-relative R2_PUBLIC_URL (M-6)', () => {
  const savedPublicUrl = process.env.R2_PUBLIC_URL;

  beforeEach(() => {
    process.env.R2_PUBLIC_URL = '/api/media';
  });

  afterEach(() => {
    process.env.R2_PUBLIC_URL = savedPublicUrl;
  });

  it('mints a root-relative publicUrl — no scheme, no host', async () => {
    const { uploadToR2 } = await import('@/lib/r2');
    const TOPIC = '11111111-2222-4333-8444-555555555555';

    const url = await uploadToR2(Buffer.from('x'), 'image/png', 'u1', 'post', 'photo.jpg', TOPIC);

    // `uploadObjectKey` inserts a random UUID between the folder and
    // filename (`.../posts/{unique}/photo.jpg`) — match that shape rather
    // than a fixed string.
    expect(url).toMatch(
      new RegExp(`^/api/media/topics/${TOPIC}/posts/[0-9a-f-]+/photo\\.jpg$`),
    );
    expect(url).not.toMatch(/^https?:\/\//);
  });

  it('the relative shape still round-trips through parseMediaObjectKey once the /api/media prefix is stripped', async () => {
    const { uploadToR2, parseMediaObjectKey } = await import('@/lib/r2');
    const TOPIC = '11111111-2222-4333-8444-555555555555';

    const url = await uploadToR2(Buffer.from('x'), 'image/png', 'u1', 'post', 'photo.jpg', TOPIC);
    // The M-5 route receives this as its catch-all `key` segments — exactly
    // what's left after the Next.js route's own `/api/media/` prefix, which
    // `url` already starts with here (relative == same-origin == the route's
    // own base path, not something a caller strips manually in production).
    const objectKey = url.replace(/^\/api\/media\//, '');
    expect(parseMediaObjectKey(objectKey.split('/'))).toEqual({ kind: 'topic-post', topicId: TOPIC });
  });
});

describe('missing env vars', () => {
  it('throws when R2 env vars are missing', async () => {
    const savedAccountId = process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCOUNT_ID;

    vi.resetModules();
    const { uploadToR2 } = await import('@/lib/r2');

    await expect(
      uploadToR2(Buffer.from('x'), 'image/jpeg', 'u1', 'post'),
    ).rejects.toThrow('R2_ACCOUNT_ID');

    process.env.R2_ACCOUNT_ID = savedAccountId;
  });
});

// ── Which server the client talks to (S-1) ───────────────────────────────────
//
// The local dev stack runs its own S3-compatible server (MinIO) so encrypted
// chat attachments can be exercised end to end on a developer machine. These
// cases pin the two things that must stay true of that: with R2_ENDPOINT unset
// the client is exactly what production has always built, and with it set the
// only thing that changes is where the bytes go.

/** Load the module fresh and hand back the S3Client mock it actually used. */
async function loadR2() {
  vi.resetModules();
  const { S3Client } = await import('@aws-sdk/client-s3');
  const r2 = await import('@/lib/r2');
  return { S3Client: vi.mocked(S3Client), r2 };
}

/** Build a client through the public surface and return its constructor args. */
async function clientArgs(): Promise<{ endpoint: string; forcePathStyle: boolean }> {
  const { S3Client, r2 } = await loadR2();
  r2.getR2Client();
  expect(S3Client, 'the S3 client must be constructed exactly once per module load').toHaveBeenCalledTimes(1);
  const args = S3Client.mock.calls[0][0] as { endpoint: string; forcePathStyle: boolean };
  return { endpoint: args.endpoint, forcePathStyle: args.forcePathStyle };
}

describe('R2_ENDPOINT — which S3 server the client addresses', () => {
  beforeEach(() => {
    delete process.env.R2_ENDPOINT;
  });

  it('BOUNDARY: unset → the Cloudflare R2 host built from the account id, virtual-hosted', async () => {
    const args = await clientArgs();
    expect(args.endpoint).toBe('https://test-account.r2.cloudflarestorage.com');
    // The property that keeps production untouched: bucket-as-subdomain, which
    // is how R2 has always been addressed here.
    expect(args.forcePathStyle).toBe(false);
  });

  it('BOUNDARY: set → that exact endpoint, addressed path style', async () => {
    process.env.R2_ENDPOINT = 'http://minio:9000';
    const args = await clientArgs();
    expect(args.endpoint).toBe('http://minio:9000');
    // Path style is not cosmetic: `bucket.minio` is a hostname no developer
    // machine resolves, so without this every local upload fails DNS.
    expect(args.forcePathStyle).toBe(true);
  });

  it('CONTRACT: the account id is ignored entirely once an endpoint is named', async () => {
    process.env.R2_ENDPOINT = 'https://s3.example.test';
    const saved = process.env.R2_ACCOUNT_ID;
    process.env.R2_ACCOUNT_ID = 'a-different-account';
    try {
      expect((await clientArgs()).endpoint).toBe('https://s3.example.test');
    } finally {
      process.env.R2_ACCOUNT_ID = saved;
    }
  });

  it('HOSTILE: a trailing slash is stripped, so the SDK cannot build a double-slash path', async () => {
    process.env.R2_ENDPOINT = 'http://minio:9000///';
    expect((await clientArgs()).endpoint).toBe('http://minio:9000');
  });

  it('HOSTILE: surrounding whitespace is trimmed rather than sent as a hostname', async () => {
    process.env.R2_ENDPOINT = '  http://minio:9000  ';
    expect((await clientArgs()).endpoint).toBe('http://minio:9000');
  });

  it('HOSTILE: a value that is not a URL at all throws and names the variable', async () => {
    process.env.R2_ENDPOINT = 'minio 9000';
    const { r2 } = await loadR2();
    expect(() => r2.getR2Client()).toThrow(/R2_ENDPOINT must be an absolute URL/);
  });

  it('HOSTILE: a non-http scheme is refused instead of handed to the SDK', async () => {
    // `minio:9000` — the realistic typo, a host:port with the scheme left off —
    // belongs here rather than with the unparseable values: `new URL` accepts
    // it as a custom scheme with `9000` as the path, so it is the scheme check
    // and not the parse that catches it.
    for (const value of ['minio:9000', 's3://bucket', 'file:///etc/passwd', 'javascript:alert(1)']) {
      process.env.R2_ENDPOINT = value;
      const { r2 } = await loadR2();
      expect(() => r2.getR2Client(), `${value} must not be accepted as an endpoint`).toThrow(/R2_ENDPOINT/);
    }
  });

  it('EMPTY: the empty string means "not set" — which is what docker compose writes', async () => {
    // `R2_ENDPOINT: ${R2_ENDPOINT}` with the variable unset interpolates to an
    // empty string, so every deployed container has this exact value. Reading
    // it as an endpoint would point production at a host with no name.
    process.env.R2_ENDPOINT = '';
    const args = await clientArgs();
    expect(args.endpoint).toBe('https://test-account.r2.cloudflarestorage.com');
    expect(args.forcePathStyle).toBe(false);
  });

  it('EMPTY: a whitespace-only value is also "not set" — checked separately from empty', async () => {
    process.env.R2_ENDPOINT = '   \t ';
    expect((await clientArgs()).endpoint).toBe('https://test-account.r2.cloudflarestorage.com');
  });

  it('EMPTY: R2_ACCOUNT_ID is not required once an endpoint is named', async () => {
    process.env.R2_ENDPOINT = 'http://minio:9000';
    const saved = process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCOUNT_ID;
    try {
      expect((await clientArgs()).endpoint).toBe('http://minio:9000');
    } finally {
      process.env.R2_ACCOUNT_ID = saved;
    }
  });

  it('EMPTY: with no endpoint and no account id, the message the e2e gate matches is unchanged', async () => {
    // `isMissingR2Credentials` in src/__tests__/e2e/helpers.ts keys on this
    // literal to tell an unconfigured deployment from a broken upload. If the
    // wording drifts, blocked cases start reporting as genuine failures.
    const saved = process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCOUNT_ID;
    try {
      const { r2 } = await loadR2();
      expect(() => r2.getR2Client()).toThrow(
        'R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, and R2_PUBLIC_URL environment variables are required',
      );
    } finally {
      process.env.R2_ACCOUNT_ID = saved;
    }
  });

  it('UTF-8: a non-ASCII host parses and reaches the SDK as typed', async () => {
    process.env.R2_ENDPOINT = 'http://저장소.local:9000';
    expect((await clientArgs()).endpoint).toBe('http://저장소.local:9000');
  });

  it('INTEGRITY: the client is built once, so credentials cannot drift from the endpoint mid-process', async () => {
    process.env.R2_ENDPOINT = 'http://minio:9000';
    const { S3Client, r2 } = await loadR2();
    r2.getR2Client();
    // A late environment change must not produce a client that talks to R2 with
    // the local server's credentials, or the reverse.
    process.env.R2_ENDPOINT = 'https://elsewhere.example';
    r2.getR2Client();
    expect(S3Client).toHaveBeenCalledTimes(1);
    expect((S3Client.mock.calls[0][0] as { endpoint: string }).endpoint).toBe('http://minio:9000');
  });
});
