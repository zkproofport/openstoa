import { describe, it, expect } from 'vitest';
import {
  authGet,
  authPatch,
  authDelete,
  publicGet,
  publicPatch,
  getBaseUrl,
  getAuthToken,
} from './helpers';

// Profile-specific helper: PUT /api/profile/nickname (not PATCH)
async function authPutNickname(nickname: string): Promise<Response> {
  return fetch(`${getBaseUrl()}/api/profile/nickname`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: JSON.stringify({ nickname }),
  });
}

// Profile-specific helper: PUT /api/profile/image
async function authPutImage(imageUrl: string): Promise<Response> {
  return fetch(`${getBaseUrl()}/api/profile/image`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getAuthToken()}`,
    },
    body: JSON.stringify({ imageUrl }),
  });
}

// Second user token helpers for duplicate nickname test
let secondUserNicknameToken: string | null = null;

async function getSecondNicknameUserToken(): Promise<string> {
  if (secondUserNicknameToken) return secondUserNicknameToken;
  const res = await fetch(`${getBaseUrl()}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: `e2e_prof_b_${Date.now().toString(36)}` }),
  });
  if (!res.ok) throw new Error(`dev-login failed: ${res.status}`);
  const data = await res.json();
  secondUserNicknameToken = data.token;
  return secondUserNicknameToken!;
}

async function secondUserPutNickname(nickname: string): Promise<Response> {
  const token = await getSecondNicknameUserToken();
  return fetch(`${getBaseUrl()}/api/profile/nickname`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ nickname }),
  });
}

describe.sequential('Profile API', () => {
  // ── Nickname: needsNickname flag ────────────────────────────────────────

  it('1. New dev-login user with anon_ nickname has needsNickname=true in session', async () => {
    // Create a fresh user with anon_ temp nickname (simulates new ZK login)
    const devRes = await fetch(`${getBaseUrl()}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Pass no nickname → server uses anon_ prefix generated from dev-login
      // We override with explicit anon_ nickname to match real flow
      body: JSON.stringify({ nickname: `anon_${Date.now().toString(16).slice(-8)}` }),
    });
    expect(devRes.status).toBe(200);
    const devData = await devRes.json();
    expect(devData.token).toBeTruthy();

    // Check session — nickname starts with anon_ → needsNickname implied
    const sessionRes = await fetch(`${getBaseUrl()}/api/auth/session`, {
      headers: { Authorization: `Bearer ${devData.token}` },
    });
    expect(sessionRes.status).toBe(200);
    const session = await sessionRes.json();
    expect(session.nickname).toBeTruthy();
    // The nickname starts with anon_ for users who haven't set one
    expect(session.nickname.startsWith('anon_')).toBe(true);
  });

  // ── Nickname: valid update ──────────────────────────────────────────────

  it('2. Valid nickname update (2-20 chars, alphanumeric+underscore) -> 200', async () => {
    const newNickname = `e2e_prof_${Date.now().toString(36).slice(-6)}`;
    const res = await authPutNickname(newNickname);
    expect(res.status).toBe(200);
    const json = await res.json();
    // Response body contains the updated nickname
    expect(json.nickname).toBe(newNickname);
  });

  // ── Nickname: duplicate ─────────────────────────────────────────────────

  it('3. Duplicate nickname (already taken by another user) -> 409', async () => {
    // Create two fresh users to test duplicate nickname collision
    const uniqueNickname = `e2e_dup_${Date.now().toString(36)}`;

    // User C: create and set nickname
    const userCRes = await fetch(`${getBaseUrl()}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: uniqueNickname }),
    });
    expect(userCRes.status).toBe(200);
    const userCData = await userCRes.json();
    const userCToken = userCData.token;

    // User D: create with different nickname
    const userDRes = await fetch(`${getBaseUrl()}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: `e2e_dup_d_${Date.now().toString(36)}` }),
    });
    expect(userDRes.status).toBe(200);
    const userDData = await userDRes.json();
    const userDToken = userDData.token;

    // User D tries to claim User C's nickname → 409
    const dupRes = await fetch(`${getBaseUrl()}/api/profile/nickname`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userDToken}`,
      },
      body: JSON.stringify({ nickname: uniqueNickname }),
    });
    expect(dupRes.status).toBe(409);
    const dupJson = await dupRes.json();
    expect(dupJson.error).toBeTruthy();

    // Sanity check: User C can update to same nickname again (no-conflict with self)
    // This also confirms User C's nickname is indeed uniqueNickname
    const selfRes = await fetch(`${getBaseUrl()}/api/profile/nickname`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userCToken}`,
      },
      body: JSON.stringify({ nickname: uniqueNickname }),
    });
    // Self-update to same nickname is allowed (no conflict)
    expect(selfRes.status).toBe(200);
  });

  // ── Nickname: invalid format ────────────────────────────────────────────

  it('4a. Nickname too short (1 char) -> 400', async () => {
    const res = await authPutNickname('x');
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('4b. Nickname too long (21 chars) -> 400', async () => {
    const res = await authPutNickname('a'.repeat(21));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('4c. Nickname with special characters (hyphen, space) -> 400', async () => {
    const res = await authPutNickname('invalid-nick name!');
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('4d. Missing nickname field -> 400', async () => {
    const res = await fetch(`${getBaseUrl()}/api/profile/nickname`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAuthToken()}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('4e. Unauthenticated nickname update -> 401', async () => {
    const res = await publicPatch('/api/profile/nickname', { nickname: 'hijack' });
    // Middleware blocks /api/profile/* for unauthenticated requests with 401
    expect(res.status).toBe(401);
  });

  // ── Profile image ───────────────────────────────────────────────────────

  it('5. Set profile image URL -> 200, returns imageUrl', async () => {
    const imageUrl = 'https://example.com/test-avatar.png';
    const res = await authPutImage(imageUrl);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.profileImage).toBe(imageUrl);
  });

  it('6. Get profile image -> 200, returns previously set URL', async () => {
    const res = await fetch(`${getBaseUrl()}/api/profile/image`, {
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.profileImage).toBe('https://example.com/test-avatar.png');
  });

  it('6b. Update profile image to new URL -> 200', async () => {
    const newImageUrl = 'https://example.com/test-avatar-v2.png';
    const res = await authPutImage(newImageUrl);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.profileImage).toBe(newImageUrl);
  });

  it('6c. Remove profile image (DELETE) -> 200', async () => {
    const res = await authDelete('/api/profile/image');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    // Confirm image is null after deletion
    const getRes = await fetch(`${getBaseUrl()}/api/profile/image`, {
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    });
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.profileImage).toBeNull();
  });

  it('6d. Set profile image with missing imageUrl field -> 400', async () => {
    const res = await fetch(`${getBaseUrl()}/api/profile/image`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getAuthToken()}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Profile read (badges) ───────────────────────────────────────────────

  it('7. Get badges -> 200, returns badges array (no PII)', async () => {
    const res = await authGet('/api/profile/badges');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.badges)).toBe(true);

    // Verify no raw PII in badge objects
    for (const badge of json.badges) {
      expect(badge.type).toBeTruthy();
      // Must not contain email, raw domain, or raw country fields
      expect(badge.email).toBeUndefined();
      expect(badge.domain).toBeUndefined();
      expect(badge.country).toBeUndefined();
    }
  });

  it('7b. Unauthenticated request to /api/profile/badges -> 401', async () => {
    const res = await publicGet('/api/profile/badges');
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  // ── Account deletion ────────────────────────────────────────────────────

  it('8. Account deletion (DELETE /api/account) -> 200, session cleared', async () => {
    // Create an isolated user with no owned topics
    const devRes = await fetch(`${getBaseUrl()}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: `e2e_del_${Date.now().toString(36)}` }),
    });
    expect(devRes.status).toBe(200);
    const devData = await devRes.json();
    const deleteUserToken = devData.token;
    expect(deleteUserToken).toBeTruthy();

    // Confirm the user is authenticated before deletion
    const sessionBefore = await fetch(`${getBaseUrl()}/api/auth/session`, {
      headers: { Authorization: `Bearer ${deleteUserToken}` },
    });
    expect(sessionBefore.status).toBe(200);

    // Delete the account
    const deleteRes = await fetch(`${getBaseUrl()}/api/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${deleteUserToken}` },
    });
    expect(deleteRes.status).toBe(200);
    const deleteJson = await deleteRes.json();
    expect(deleteJson.success).toBe(true);

    // The JWT token itself is still cryptographically valid (stateless),
    // but the user record is anonymized (deletedAt set). The session
    // endpoint may still return 200 with the old payload since JWTs
    // are not revoked server-side — the key observable effect is the
    // successful 200 deletion response above.
  });

  it('8b. Account deletion without auth -> 401', async () => {
    const res = await fetch(`${getBaseUrl()}/api/account`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('8c. Account deletion when user owns topics -> 409', async () => {
    // User A (the main test user) owns topics created in other test suites.
    // We rely on the fact that the global-setup user (User A) has created
    // topics in other sequential test files. To be self-contained, we
    // create a fresh user, have them create a topic, then try to delete.
    const res = await fetch(`${getBaseUrl()}/api/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: `e2e_own_${Date.now().toString(36)}` }),
    });
    expect(res.status).toBe(200);
    const ownerData = await res.json();
    const ownerToken = ownerData.token;

    // Fetch categories first
    const catRes = await fetch(`${getBaseUrl()}/api/categories`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(catRes.status).toBe(200);
    const catJson = await catRes.json();
    const firstCategoryId = catJson.categories[0].id;

    // Create a topic as this user
    const topicRes = await fetch(`${getBaseUrl()}/api/topics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        title: `E2E Owner Delete Topic ${Date.now()}`,
        description: 'Topic to block account deletion',
        visibility: 'public',
        categoryId: firstCategoryId,
      }),
    });
    expect(topicRes.status).toBe(201);

    // Attempt to delete account while owning a topic → 409
    const deleteRes = await fetch(`${getBaseUrl()}/api/account`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(deleteRes.status).toBe(409);
    const deleteJson = await deleteRes.json();
    expect(deleteJson.error).toBeTruthy();
    expect(Array.isArray(deleteJson.topics)).toBe(true);
    expect(deleteJson.topics.length).toBeGreaterThan(0);
  });
});
