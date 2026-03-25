import { describe, it, expect } from 'vitest';
import {
  authPost,
  authGet,
  secondUserPost,
  secondUserGet,
  getSecondUserToken,
} from './helpers';

let categoryId: string;
let topicId: string;
let inviteToken: string;

describe.sequential('Invite Tokens — generate, join, reuse, invalid', () => {
  // ── Setup ──────────────────────────────────────────────────────────────

  it('setup: fetch categories', async () => {
    const res = await authGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.categories)).toBe(true);
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('setup: User A creates a public topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Invite Token Topic ${Date.now()}`,
      description: 'Topic for invite token E2E tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    topicId = json.topic.id;
    expect(topicId).toBeTruthy();
  });

  it('setup: ensure User B exists', async () => {
    const { token, userId } = await getSecondUserToken();
    expect(token).toBeTruthy();
    expect(userId).toBeTruthy();
  });

  // ── Tests ──────────────────────────────────────────────────────────────

  it('1. Member generates single-use invite token -> 201, token + expiresAt', async () => {
    const res = await authPost(`/api/topics/${topicId}/invite`);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(typeof json.token).toBe('string');
    expect(json.token.length).toBeGreaterThan(0);
    expect(json.expiresAt).toBeTruthy();
    // Token should expire in the future
    expect(new Date(json.expiresAt).getTime()).toBeGreaterThan(Date.now());
    inviteToken = json.token;
  });

  it('2. User B joins topic using invite token -> 201', async () => {
    expect(inviteToken).toBeTruthy();
    const res = await secondUserPost(`/api/topics/join/${inviteToken}`);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.topicId).toBe(topicId);

    // Verify User B is now a member by fetching topic details
    const topicRes = await secondUserGet(`/api/topics/${topicId}`);
    expect(topicRes.status).toBe(200);
  });

  it('3. Reuse of already-used invite token -> 404 (token consumed)', async () => {
    expect(inviteToken).toBeTruthy();
    // User B already used the token and joined — token is now marked as used
    // A new third user (simulate via another dev-login) or User B tries again
    // User B is already a member so we test the lookup endpoint which checks usedBy
    const res = await authGet(`/api/topics/join/${inviteToken}`);
    // After the token is used (usedBy is set), the GET lookup should return 404
    // because the route only accepts tokens where usedBy IS NULL
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('4. Invalid (nonexistent) invite token -> 404', async () => {
    const fakeToken = 'deadbeefdeadbeef'; // 16 hex chars, valid format, nonexistent
    const res = await authGet(`/api/topics/join/${fakeToken}`);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });
});
