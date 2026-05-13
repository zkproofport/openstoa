import { describe, it, expect } from 'vitest';
import { authGet, authPost, authPut, authDelete, publicGet, publicPost, getBaseUrl, getAuthToken } from './helpers';

/**
 * Upload a tiny PNG to R2 and return its public URL. `/api/profile/image`
 * only accepts URLs served from our R2 bucket (R2_PUBLIC_URL prefix check),
 * so we can't just hand it a `https://example.com/...` placeholder.
 */
async function uploadAvatar(): Promise<string> {
  const bytes = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'image/png' }), `profile-avatar-${Date.now()}.png`);
  form.append('purpose', 'avatar');
  const res = await fetch(`${getBaseUrl()}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getAuthToken()}` },
    body: form,
  });
  if (!res.ok) throw new Error(`avatar upload failed: ${res.status}`);
  return (await res.json() as { publicUrl: string }).publicUrl;
}

describe('Profile endpoints', () => {
  it('GET /api/profile/image returns current profile image', async () => {
    const res = await authGet('/api/profile/image');
    expect(res.status).toBe(200);
    const json = await res.json();
    // profileImage may be null for new users
    expect(json).toHaveProperty('profileImage');
  });

  it('PUT /api/profile/nickname sets nickname', async () => {
    const nickname = `e2e_user_${Date.now().toString(36)}`;
    const res = await authPut('/api/profile/nickname', { nickname });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.nickname).toBe(nickname);
  });

  it('PUT /api/profile/image sets profile image URL', async () => {
    const avatarUrl = await uploadAvatar();
    const res = await authPut('/api/profile/image', { imageUrl: avatarUrl });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.profileImage).toBe(avatarUrl);
  });

  it('DELETE /api/profile/image removes profile image', async () => {
    const res = await authDelete('/api/profile/image');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
  });
});

describe('Session and Admin role', () => {
  it('GET /api/auth/session returns role for admin users', async () => {
    const res = await authGet('/api/auth/session');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.userId).toBeTruthy();
    expect(json.nickname).toBeTruthy();
    // Admin users should have role field
    if (json.role) {
      expect(json.role).toBe('admin');
      console.log(`[E2E] Admin role confirmed for ${json.nickname}`);
    } else {
      console.log(`[E2E] User ${json.nickname} is not admin (role field absent — normal for non-admin)`);
    }
  });
});

describe('My Activity endpoints', () => {
  it('GET /api/my/posts returns user posts', async () => {
    const res = await authGet('/api/my/posts');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
  });

  it('GET /api/my/likes returns liked posts', async () => {
    const res = await authGet('/api/my/likes');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
  });
});

describe('Bookmarks endpoint', () => {
  it('GET /api/bookmarks returns bookmarked posts', async () => {
    const res = await authGet('/api/bookmarks');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.posts)).toBe(true);
  });
});

describe('Tags endpoint', () => {
  it('GET /api/tags returns tag list', async () => {
    const res = await authGet('/api/tags');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.tags)).toBe(true);
  });

  it('GET /api/tags?q=e2e searches tags by prefix', async () => {
    const res = await authGet('/api/tags?q=e2e');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.tags)).toBe(true);
  });
});

describe('Upload endpoint', () => {
  it('POST /api/upload (multipart) returns publicUrl on the CDN', async () => {
    // The endpoint switched from a presigned-URL handshake to direct
    // multipart upload — the JSON-body shape (`filename`, `contentType`,
    // `size`) is no longer accepted.
    const bytes = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'image/png' }), 'test.png');
    form.append('purpose', 'post');
    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAuthToken()}` },
      body: form,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.publicUrl).toBe('string');
    expect(json.publicUrl.length).toBeGreaterThan(0);
  });
});

describe('OG metadata endpoint', () => {
  it('GET /api/og?url=... scrapes OG metadata', async () => {
    const res = await authGet('/api/og?url=https://example.com');
    expect([200, 502]).toContain(res.status);
  });
});

describe('Beta signup endpoint', () => {
  it('POST /api/beta-signup with invalid email returns error', async () => {
    const res = await publicPost('/api/beta-signup', {
      email: 'not-an-email',
    });
    expect([400, 422, 500]).toContain(res.status);
  });
});
