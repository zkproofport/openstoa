import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const mockSend = vi.fn().mockResolvedValue({});
const mockGetSignedUrl = vi.fn().mockResolvedValue('https://presigned-url.example.com');

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: mockSend })),
  PutObjectCommand: vi.fn().mockImplementation((input) => input),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
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
  mockGetSignedUrl.mockResolvedValue('https://presigned-url.example.com');
  // Reset the module-level singleton so each test gets a fresh client
  vi.resetModules();
});

describe('getPresignedUploadUrl', () => {
  it('returns uploadUrl and publicUrl', async () => {
    const { getPresignedUploadUrl } = await import('@/lib/r2');

    const result = await getPresignedUploadUrl({
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      userId: 'user-1',
      purpose: 'post',
    });

    expect(result.uploadUrl).toBe('https://presigned-url.example.com');
    expect(result.publicUrl).toMatch(/^https:\/\/cdn\.example\.com\//);
  });

  it('includes the purpose folder in publicUrl', async () => {
    const { getPresignedUploadUrl } = await import('@/lib/r2');

    const postResult = await getPresignedUploadUrl({
      filename: 'img.png',
      contentType: 'image/png',
      userId: 'u1',
      purpose: 'post',
    });
    expect(postResult.publicUrl).toContain('/posts/');

    vi.resetModules();
    const { getPresignedUploadUrl: gp2 } = await import('@/lib/r2');
    const topicResult = await gp2({
      filename: 'cover.png',
      contentType: 'image/png',
      userId: 'u1',
      purpose: 'topic',
    });
    expect(topicResult.publicUrl).toContain('/topics/');

    vi.resetModules();
    const { getPresignedUploadUrl: gp3 } = await import('@/lib/r2');
    const avatarResult = await gp3({
      filename: 'avatar.png',
      contentType: 'image/png',
      userId: 'u1',
      purpose: 'avatar',
    });
    expect(avatarResult.publicUrl).toContain('/avatars/');
  });
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
});

describe('missing env vars', () => {
  it('throws when R2 env vars are missing', async () => {
    const savedAccountId = process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCOUNT_ID;

    vi.resetModules();
    const { getPresignedUploadUrl } = await import('@/lib/r2');

    await expect(
      getPresignedUploadUrl({
        filename: 'x.jpg',
        contentType: 'image/jpeg',
        userId: 'u1',
        purpose: 'post',
      }),
    ).rejects.toThrow('R2_ACCOUNT_ID');

    process.env.R2_ACCOUNT_ID = savedAccountId;
  });
});
