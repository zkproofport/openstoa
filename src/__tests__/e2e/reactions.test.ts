import { describe, it, expect } from 'vitest';
import {
  authPost,
  authGet,
  publicPost,
  secondUserPost,
  secondUserGet,
  getSecondUserToken,
} from './helpers';

let categoryId: string;
let topicId: string;
let postId: string;

describe.sequential('Reactions (Emoji)', () => {
  // ── Setup ──────────────────────────────────────────────────────────────

  it('setup: fetch categories', async () => {
    const res = await authGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.categories)).toBe(true);
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('setup: User A creates a public topic and post', async () => {
    const topicRes = await authPost('/api/topics', {
      title: `E2E Reactions Topic ${Date.now()}`,
      description: 'Topic for reactions E2E tests',
      visibility: 'public',
      categoryId,
    });
    expect(topicRes.status).toBe(201);
    const topicJson = await topicRes.json();
    topicId = topicJson.topic.id;
    expect(topicId).toBeTruthy();

    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `E2E Reactions Post ${Date.now()}`,
      content: 'Post for reactions E2E tests.',
    });
    expect(postRes.status).toBe(201);
    const postJson = await postRes.json();
    postId = postJson.post.id;
    expect(postId).toBeTruthy();
  });

  it('setup: ensure User B exists', async () => {
    const { token, userId } = await getSecondUserToken();
    expect(token).toBeTruthy();
    expect(userId).toBeTruthy();
  });

  // ── Tests ──────────────────────────────────────────────────────────────

  it('1. Member adds emoji reaction (👍) -> { added: true }', async () => {
    const res = await authPost(`/api/posts/${postId}/reactions`, { emoji: '👍' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.added).toBe(true);
  });

  it('2. Member sends same emoji again -> reaction cancelled (toggle), { added: false }', async () => {
    const res = await authPost(`/api/posts/${postId}/reactions`, { emoji: '👍' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.added).toBe(false);
  });

  it('3. Member can add multiple different emojis simultaneously', async () => {
    // Add 👍 first
    const r1 = await authPost(`/api/posts/${postId}/reactions`, { emoji: '👍' });
    expect(r1.status).toBe(200);
    expect((await r1.json()).added).toBe(true);

    // Add ❤️ separately (different emoji — should be independent)
    const r2 = await authPost(`/api/posts/${postId}/reactions`, { emoji: '❤️' });
    expect(r2.status).toBe(200);
    expect((await r2.json()).added).toBe(true);

    // Add 🔥 separately
    const r3 = await authPost(`/api/posts/${postId}/reactions`, { emoji: '🔥' });
    expect(r3.status).toBe(200);
    expect((await r3.json()).added).toBe(true);
  });

  it('4. GET reactions returns emoji, count, userReacted per emoji', async () => {
    const res = await authGet(`/api/posts/${postId}/reactions`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.reactions)).toBe(true);

    // We added 👍, ❤️, 🔥 in test 3 (👍 was toggled off/on so it exists)
    const emojis = json.reactions.map((r: { emoji: string }) => r.emoji);
    expect(emojis).toContain('👍');
    expect(emojis).toContain('❤️');
    expect(emojis).toContain('🔥');

    // Each item must have required fields
    for (const reaction of json.reactions) {
      expect(typeof reaction.emoji).toBe('string');
      expect(typeof reaction.count).toBe('number');
      expect(reaction.count).toBeGreaterThan(0);
      expect(typeof reaction.userReacted).toBe('boolean');
    }

    // The authenticated user should have userReacted: true for emojis they added
    const thumbs = json.reactions.find((r: { emoji: string }) => r.emoji === '👍');
    expect(thumbs).toBeTruthy();
    expect(thumbs.userReacted).toBe(true);
  });

  it('5. Non-member (User B) react attempt -> 403 (membership check required)', async () => {
    // User B is authenticated but not a member of the topic.
    const res = await secondUserPost(`/api/posts/${postId}/reactions`, { emoji: '🎉' });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('6. Guest (unauthenticated) react attempt -> 401', async () => {
    const res = await publicPost(`/api/posts/${postId}/reactions`, { emoji: '👍' });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('7. Invalid emoji -> 400', async () => {
    const res = await authPost(`/api/posts/${postId}/reactions`, { emoji: '🦄' });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('8. GET reactions as guest -> 200, userReacted: false for all', async () => {
    const res = await fetch(
      `${process.env.E2E_BASE_URL || 'https://stg-community.zkproofport.app'}/api/posts/${postId}/reactions`,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.reactions)).toBe(true);
    for (const reaction of json.reactions) {
      expect(reaction.userReacted).toBe(false);
    }
  });
});
