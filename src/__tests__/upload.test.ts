import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock session
vi.mock('@/lib/session', () => ({
  getSession: vi.fn(),
}));

// Mock R2 module
vi.mock('@/lib/r2', () => ({
  uploadToR2: vi.fn(),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeFormDataRequest(fields: Record<string, string | File>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return new NextRequest('http://localhost:3200/api/upload', {
    method: 'POST',
    body: formData,
  });
}

function makeFile(name: string, type: string, size = 1024): File {
  const content = new Uint8Array(size).fill(0);
  return new File([content], name, { type });
}

describe('POST /api/upload', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns 401 when not authenticated', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue(null);

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeFormDataRequest({ file: makeFile('photo.jpg', 'image/jpeg') }));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Not authenticated');
  });

  it('returns 400 when file field is missing', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeFormDataRequest({ purpose: 'post' }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('file is required');
  });

  it('returns 400 when contentType is not image/*', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeFormDataRequest({ file: makeFile('doc.pdf', 'application/pdf') }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('Only image uploads are supported');
  });

  it('returns 400 when file size exceeds 10MB', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { POST } = await import('@/app/api/upload/route');
    const overLimit = 10 * 1024 * 1024 + 1;
    const res = await POST(makeFormDataRequest({ file: makeFile('big.jpg', 'image/jpeg', overLimit) }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('File size must not exceed 10MB');
  });

  it('returns publicUrl for valid image upload', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { uploadToR2 } = await import('@/lib/r2');
    vi.mocked(uploadToR2).mockResolvedValue('https://media.test.com/staging/posts/user-1/abc-uuid/photo.jpg');

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeFormDataRequest({ file: makeFile('photo.jpg', 'image/jpeg') }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.publicUrl).toBe('https://media.test.com/staging/posts/user-1/abc-uuid/photo.jpg');
    expect(json.uploadUrl).toBeUndefined();
  });

  it('passes correct parameters to uploadToR2', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-42', nickname: 'bob', verifiedAt: Date.now() });

    const { uploadToR2 } = await import('@/lib/r2');
    vi.mocked(uploadToR2).mockResolvedValue('https://media.test.com/staging/avatars/user-42/uuid/avatar.png');

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeFormDataRequest({
      file: makeFile('avatar.png', 'image/png'),
      purpose: 'avatar',
    }));

    expect(res.status).toBe(200);
    expect(vi.mocked(uploadToR2)).toHaveBeenCalledWith(
      expect.any(Buffer),
      'image/png',
      'user-42',
      'avatar',
      'avatar.png',
    );
  });

  it('defaults to purpose=post when purpose is invalid', async () => {
    const { getSession } = await import('@/lib/session');
    vi.mocked(getSession).mockResolvedValue({ userId: 'user-1', nickname: 'alice', verifiedAt: Date.now() });

    const { uploadToR2 } = await import('@/lib/r2');
    vi.mocked(uploadToR2).mockResolvedValue('https://media.test.com/staging/posts/user-1/uuid/img.png');

    const { POST } = await import('@/app/api/upload/route');
    const res = await POST(makeFormDataRequest({
      file: makeFile('img.png', 'image/png'),
      purpose: 'invalid-purpose',
    }));

    expect(res.status).toBe(200);
    expect(vi.mocked(uploadToR2)).toHaveBeenCalledWith(
      expect.any(Buffer),
      'image/png',
      'user-1',
      'post',
      'img.png',
    );
  });
});
