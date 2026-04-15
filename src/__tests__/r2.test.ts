import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

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

    const postUrl = await uploadToR2(Buffer.from('x'), 'image/png', 'u1', 'post', 'img.png');
    expect(postUrl).toContain('/posts/');

    vi.resetModules();
    const { uploadToR2: upload2 } = await import('@/lib/r2');
    const topicUrl = await upload2(Buffer.from('x'), 'image/png', 'u1', 'topic', 'cover.png');
    expect(topicUrl).toContain('/topics/');

    vi.resetModules();
    const { uploadToR2: upload3 } = await import('@/lib/r2');
    const avatarUrl = await upload3(Buffer.from('x'), 'image/png', 'u1', 'avatar', 'avatar.png');
    expect(avatarUrl).toContain('/avatars/');
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
