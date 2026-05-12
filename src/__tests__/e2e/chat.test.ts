import { describe, it, expect } from 'vitest';
import {
  authPost,
  authGet,
  publicPost,
  publicGet,
  secondUserPost,
  getSecondUserToken,
} from './helpers';

let categoryId: string;
let topicId: string;

describe.sequential('Chat — send, history, @ask, non-member', () => {
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
      title: `E2E Chat Topic ${Date.now()}`,
      description: 'Topic for chat E2E tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    topicId = json.topic.id;
    expect(topicId).toBeTruthy();
  });

  it('setup: ensure User B exists (non-member)', async () => {
    const { token, userId } = await getSecondUserToken();
    expect(token).toBeTruthy();
    expect(userId).toBeTruthy();
  });

  // ── Tests ──────────────────────────────────────────────────────────────

  it('1. Member sends chat message -> 201, message returned with isAI field', async () => {
    const res = await authPost(`/api/topics/${topicId}/chat`, {
      message: 'Hello from E2E test!',
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.message).toBeDefined();
    expect(json.message.id).toBeTruthy();
    expect(json.message.message).toBe('Hello from E2E test!');
    expect(json.message.type).toBe('message');
    expect(json.message.topicId).toBe(topicId);
    expect(json.message.nickname).toBeTruthy();
    expect(json.message.createdAt).toBeTruthy();
    // dev-login session is not AI — isAI should be false
    expect(json.message.isAI).toBe(false);
  });

  it('2. GET chat history -> 200, messages[] + total returned', async () => {
    const res = await authGet(`/api/topics/${topicId}/chat`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.messages)).toBe(true);
    expect(typeof json.total).toBe('number');
    expect(json.total).toBeGreaterThan(0);

    // Each message must have required fields including isAI
    for (const msg of json.messages) {
      expect(typeof msg.id).toBe('string');
      expect(typeof msg.message).toBe('string');
      expect(typeof msg.type).toBe('string');
      expect(typeof msg.nickname).toBe('string');
      expect(msg.createdAt).toBeTruthy();
      expect(typeof msg.isAI).toBe('boolean');
    }

    // The message we sent should appear in history
    const found = json.messages.find((m: { message: string }) => m.message === 'Hello from E2E test!');
    expect(found).toBeDefined();
  });

  it('3. @ask prefix is now a plain message (no AI auto-reply)', async () => {
    // The legacy @ask magic command was removed. Sending a message that
    // starts with "@ask " should be stored verbatim with type='message'
    // and must NOT trigger an automatic AI reply. AI participation will
    // return as a first-class topic member (isAI user), not as a parser
    // on the send endpoint.
    const res = await authPost(`/api/topics/${topicId}/chat`, {
      message: '@ask What is OpenStoa?',
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.message.message).toBe('@ask What is OpenStoa?');
    expect(json.message.type).toBe('message');

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const historyRes = await authGet(`/api/topics/${topicId}/chat`);
    expect(historyRes.status).toBe(200);
    const historyJson = await historyRes.json();

    const aiMsg = historyJson.messages.find(
      (m: { type: string }) => m.type === 'ai',
    );
    expect(aiMsg).toBeUndefined();
  });

  it('4. Non-member (User B) chat attempt -> 403', async () => {
    // User B has not joined the topic
    const res = await secondUserPost(`/api/topics/${topicId}/chat`, {
      message: 'Should be rejected',
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('5. Empty message -> 400', async () => {
    const res = await authPost(`/api/topics/${topicId}/chat`, {
      message: '',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('6. Missing message field -> 400', async () => {
    const res = await authPost(`/api/topics/${topicId}/chat`, {});
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('7. Guest POST chat -> 401', async () => {
    const res = await publicPost(`/api/topics/${topicId}/chat`, {
      message: 'Guest should be rejected',
    });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });

  it('8. GET chat history — paging with limit/offset', async () => {
    const res = await authGet(`/api/topics/${topicId}/chat?limit=1&offset=0`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.messages)).toBe(true);
    expect(json.messages.length).toBeLessThanOrEqual(1);
    expect(typeof json.total).toBe('number');
  });
});
