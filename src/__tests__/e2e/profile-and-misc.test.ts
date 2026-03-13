import { describe, it, expect } from 'vitest';
import { authGet, authPost, authPut, authDelete, publicGet, publicPost } from './helpers';

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
  it('POST /api/upload returns presigned URL', async () => {
    const res = await authPost('/api/upload', {
      filename: 'test.png',
      contentType: 'image/png',
      purpose: 'post',
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.uploadUrl).toBeTruthy();
    expect(json.publicUrl).toBeTruthy();
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
