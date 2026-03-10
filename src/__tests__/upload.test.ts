import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock session
vi.mock('@/lib/session', () => ({
  getSessionFromCookies: vi.fn(),
}));

// Mock S3 - module-level singleton reset requires mocking the constructor
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({})),
  PutObjectCommand: vi.fn().mockImplementation((params) => params),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://mock-presigned-url.com/upload'),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Set R2 env vars before module import
process.env.R2_ACCOUNT_ID = 'test-account-id';
process.env.R2_ACCESS_KEY_ID = 'test-access-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.R2_BUCKET_NAME = 'test-bucket';
process.env.R2_PUBLIC_URL = 'https://media.test.com';

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3200/api/upload', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/upload', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns 401 when not authenticated', async () => {
    const { getSessionFromCookies } = await import('@/lib/session');
    vi.mocked(getSessionFromCookies).mockResolvedValue(null);

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeRequest({ filename: 'photo.jpg', contentType: 'image/jpeg', size: 1024 }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 400 when filename is missing', async () => {
    const { getSessionFromCookies } = await import('@/lib/session');
    vi.mocked(getSessionFromCookies).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeRequest({ contentType: 'image/jpeg', size: 1024 }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('filename is required');
  });

  it('returns 400 when contentType is missing', async () => {
    const { getSessionFromCookies } = await import('@/lib/session');
    vi.mocked(getSessionFromCookies).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeRequest({ filename: 'photo.jpg', size: 1024 }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('contentType is required');
  });

  it('returns 400 when contentType is not image/*', async () => {
    const { getSessionFromCookies } = await import('@/lib/session');
    vi.mocked(getSessionFromCookies).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeRequest({ filename: 'doc.pdf', contentType: 'application/pdf', size: 1024 }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Only image uploads are supported');
  });

  it('returns 400 when file size exceeds 10MB', async () => {
    const { getSessionFromCookies } = await import('@/lib/session');
    vi.mocked(getSessionFromCookies).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/upload/route');
    const overLimit = 10 * 1024 * 1024 + 1;
    const res = await POST(makeRequest({ filename: 'big.jpg', contentType: 'image/jpeg', size: overLimit }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('File size must not exceed 10MB');
  });

  it('returns presigned URL for valid image upload request', async () => {
    const { getSessionFromCookies } = await import('@/lib/session');
    vi.mocked(getSessionFromCookies).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeRequest({ filename: 'photo.jpg', contentType: 'image/jpeg', size: 1024 }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.uploadUrl).toBe('https://mock-presigned-url.com/upload');
    expect(json.publicUrl).toMatch(/^https:\/\/media\.test\.com\//);
  });

  it('path includes environment prefix (staging when not production)', async () => {
    const { getSessionFromCookies } = await import('@/lib/session');
    vi.mocked(getSessionFromCookies).mockResolvedValue({ userId: 'user-42', nickname: 'bob', verifiedAt: Date.now() });

    const originalEnv = process.env.NODE_ENV;
    // NODE_ENV is not 'production' in test, so prefix should be 'staging'
    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeRequest({ filename: 'avatar.png', contentType: 'image/png', size: 512 }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.publicUrl).toMatch(/staging\/uploads\//);
  });

  it('path includes userId and a UUID segment', async () => {
    const { getSessionFromCookies } = await import('@/lib/session');
    vi.mocked(getSessionFromCookies).mockResolvedValue({ userId: 'user-xyz', nickname: 'carol', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeRequest({ filename: 'shot.webp', contentType: 'image/webp', size: 2048 }));

    expect(res.status).toBe(200);
    const json = await res.json();
    // publicUrl format: https://media.test.com/<env>/uploads/<userId>/<uuid>/<filename>
    expect(json.publicUrl).toContain('/uploads/user-xyz/');
    // UUID segment: 8-4-4-4-12 hex
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
    expect(json.publicUrl).toMatch(uuidPattern);
    expect(json.publicUrl).toContain('shot.webp');
  });
});
