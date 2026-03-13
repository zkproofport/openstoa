import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock session - now uses getSession, not getSessionFromCookies
vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
}));

// Mock R2 module
vi.mock('@/lib/r2', () => ({
  getPresignedUploadUrl: vi.fn(),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue(null);

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeRequest({ filename: 'photo.jpg', contentType: 'image/jpeg', size: 1024 }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 400 when filename is missing', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeRequest({ contentType: 'image/jpeg', size: 1024 }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('filename is required');
  });

  it('returns 400 when contentType is missing', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeRequest({ filename: 'photo.jpg', size: 1024 }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('contentType is required');
  });

  it('returns 400 when contentType is not image/*', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeRequest({ filename: 'doc.pdf', contentType: 'application/pdf', size: 1024 }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Only image uploads are supported');
  });

  it('returns 400 when file size exceeds 10MB', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/upload/route');
    const overLimit = 10 * 1024 * 1024 + 1;
    const res = await POST(makeRequest({ filename: 'big.jpg', contentType: 'image/jpeg', size: overLimit }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('File size must not exceed 10MB');
  });

  it('returns presigned URL for valid image upload request', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { getPresignedUploadUrl } = await import('@/lib/r2');
    vi.mocked(getPresignedUploadUrl).mockResolvedValue({
      uploadUrl: 'https://mock-presigned-url.com/upload',
      publicUrl: 'https://media.test.com/staging/posts/user-1/abc-uuid/photo.jpg',
    });

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeRequest({ filename: 'photo.jpg', contentType: 'image/jpeg', size: 1024 }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.uploadUrl).toBe('https://mock-presigned-url.com/upload');
    expect(json.publicUrl).toBe('https://media.test.com/staging/posts/user-1/abc-uuid/photo.jpg');
  });

  it('passes correct parameters to getPresignedUploadUrl', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-42', nickname: 'bob', verifiedAt: Date.now() });

    const { getPresignedUploadUrl } = await import('@/lib/r2');
    vi.mocked(getPresignedUploadUrl).mockResolvedValue({
      uploadUrl: 'https://mock-presigned-url.com/upload',
      publicUrl: 'https://media.test.com/staging/avatars/user-42/uuid/avatar.png',
    });

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeRequest({ filename: 'avatar.png', contentType: 'image/png', size: 512, purpose: 'avatar' }));

    expect(res.status).toBe(200);
    expect(vi.mocked(getPresignedUploadUrl)).toHaveBeenCalledWith({
      filename: 'avatar.png',
      contentType: 'image/png',
      userId: 'user-42',
      purpose: 'avatar',
      metadata: undefined,
    });
  });

  it('passes metadata when width and height are provided', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-xyz', nickname: 'carol', verifiedAt: Date.now() });

    const { getPresignedUploadUrl } = await import('@/lib/r2');
    vi.mocked(getPresignedUploadUrl).mockResolvedValue({
      uploadUrl: 'https://mock-presigned-url.com/upload',
      publicUrl: 'https://media.test.com/staging/posts/user-xyz/uuid/shot.webp',
    });

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeRequest({ filename: 'shot.webp', contentType: 'image/webp', size: 2048, width: 800, height: 600 }));

    expect(res.status).toBe(200);
    expect(vi.mocked(getPresignedUploadUrl)).toHaveBeenCalledWith({
      filename: 'shot.webp',
      contentType: 'image/webp',
      userId: 'user-xyz',
      purpose: 'post',
      metadata: { width: '800', height: '600' },
    });
  });
});
