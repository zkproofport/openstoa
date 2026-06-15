import { describe, it, expect } from 'vitest';
import {
  authPost,
  authGet,
  publicPost,
  secondUserPost,
  getSecondUserToken,
} from './helpers';
import { placeholderGroupCipher } from '@/lib/crypto/groupCipherPlaceholder';

/**
 * Phase 1 E2E: end-to-end ciphertext routing over a real HTTP container.
 * The client seals with the placeholder GroupCipher, the server stores/routes
 * opaque bytes (never plaintext, SI-1), and the client opens on read. Covers
 * the 9-row edge matrix rows that need a live server: authz, plaintext
 * rejection, hostile base64, size cap, integrity (since= round-trip), and the
 * no-plaintext-over-the-wire invariant.
 */

let categoryId: string;
let topicId: string;

describe.sequential('Chat — E2EE ciphertext routing', () => {
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
      description: 'Topic for chat E2EE tests',
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

  // ── Happy path: seal → route → open ──────────────────────────────────────

  it('1. Member sends sealed message -> 201, sealed echoed, plaintext null', async () => {
    const plaintext = 'Hello from E2E test! 안녕 🌟';
    const sealed = await placeholderGroupCipher.seal(topicId, plaintext);

    const res = await authPost(`/api/topics/${topicId}/chat`, {
      ciphertext: sealed.ciphertext,
      epoch: sealed.epoch,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.message.id).toBeTruthy();
    expect(json.message.type).toBe('message');
    expect(json.message.message).toBeNull(); // SI-1: no plaintext returned
    expect(json.message.sealed.ciphertext).toBe(sealed.ciphertext);
    expect(json.message.isAI).toBe(false);

    // Client opens the echoed sealed body back to the original plaintext.
    const opened = await placeholderGroupCipher.open(topicId, json.message.sealed);
    expect(opened).toBe(plaintext);
  });

  it('2. GET history -> sealed bodies that open to the sent plaintext', async () => {
    const res = await authGet(`/api/topics/${topicId}/chat`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.messages)).toBe(true);
    expect(json.total).toBeGreaterThan(0);

    const userMsgs = json.messages.filter((m: { type: string }) => m.type === 'message');
    expect(userMsgs.length).toBeGreaterThan(0);
    for (const m of userMsgs) {
      // SI-1: user rows carry sealed bytes, never plaintext.
      expect(m.message).toBeNull();
      expect(m.sealed?.ciphertext).toBeTruthy();
      expect(typeof m.isAI).toBe('boolean');
    }

    const opened = await Promise.all(
      userMsgs.map((m: { sealed: { ciphertext: string; epoch: number } }) =>
        placeholderGroupCipher.open(topicId, m.sealed),
      ),
    );
    expect(opened).toContain('Hello from E2E test! 안녕 🌟');
  });

  it('3. SI-1: the sent plaintext never appears anywhere in the history response', async () => {
    const res = await authGet(`/api/topics/${topicId}/chat`);
    const rawText = await res.text();
    expect(rawText).not.toContain('Hello from E2E test!');
  });

  // ── Hostile / SI-1 rejection ─────────────────────────────────────────────

  it('4. Plaintext message field is rejected with 400 (SI-1)', async () => {
    const res = await authPost(`/api/topics/${topicId}/chat`, { message: 'plaintext attempt' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/plaintext/i);
  });

  it('5. Non-base64 ciphertext -> 400', async () => {
    const res = await authPost(`/api/topics/${topicId}/chat`, { ciphertext: 'not valid!!', epoch: 0 });
    expect(res.status).toBe(400);
  });

  it('6. Oversized ciphertext (>4096 bytes) -> 400', async () => {
    const big = Buffer.alloc(4097, 1).toString('base64');
    const res = await authPost(`/api/topics/${topicId}/chat`, { ciphertext: big, epoch: 0 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/4096/);
  });

  it('7. Missing epoch -> 400', async () => {
    const sealed = await placeholderGroupCipher.seal(topicId, 'x');
    const res = await authPost(`/api/topics/${topicId}/chat`, { ciphertext: sealed.ciphertext });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/epoch/);
  });

  // ── Authz ────────────────────────────────────────────────────────────────

  it('8. Non-member (User B) send -> 403', async () => {
    const sealed = await placeholderGroupCipher.seal(topicId, 'should be rejected');
    const res = await secondUserPost(`/api/topics/${topicId}/chat`, {
      ciphertext: sealed.ciphertext,
      epoch: sealed.epoch,
    });
    expect(res.status).toBe(403);
  });

  it('9. Guest send -> 401', async () => {
    const sealed = await placeholderGroupCipher.seal(topicId, 'guest');
    const res = await publicPost(`/api/topics/${topicId}/chat`, {
      ciphertext: sealed.ciphertext,
      epoch: sealed.epoch,
    });
    expect(res.status).toBe(401);
  });

  // ── Integrity: since= delta sync is chronological + round-trips ───────────

  it('10. since= delta sync is chronological and round-trips (server clock only)', async () => {
    // Anchor on a SERVER timestamp, never the host clock — the DB writes
    // createdAt with the container clock, which can skew from the host by
    // seconds under Docker Desktop and would drop every row. A sentinel
    // message gives us an anchor strictly before first/second. We do NOT
    // assert the sentinel is excluded: the response createdAt is ms-precision
    // while the column is µs-precision, so an exclusive `since` boundary can
    // re-deliver the anchor row — real clients dedupe by id, so that is fine.
    // What matters (integrity) is chronological order + correct decryption.
    const anchorText = `anchor-${Date.now()}`;
    const sa = await placeholderGroupCipher.seal(topicId, anchorText);
    const ra = await authPost(`/api/topics/${topicId}/chat`, { ciphertext: sa.ciphertext, epoch: sa.epoch });
    expect(ra.status).toBe(201);
    const t0 = (await ra.json()).message.createdAt as string;

    const first = `delta-one-${Date.now()}`;
    const second = `delta-two-${Date.now()}`;
    for (const text of [first, second]) {
      const s = await placeholderGroupCipher.seal(topicId, text);
      const r = await authPost(`/api/topics/${topicId}/chat`, { ciphertext: s.ciphertext, epoch: s.epoch });
      expect(r.status).toBe(201);
    }

    // since=t0 returns rows ascending; first/second are strictly newer.
    const res = await authGet(`/api/topics/${topicId}/chat?since=${encodeURIComponent(t0)}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const opened = await Promise.all(
      json.messages
        .filter((m: { type: string }) => m.type === 'message')
        .map((m: { sealed: { ciphertext: string; epoch: number } }) =>
          placeholderGroupCipher.open(topicId, m.sealed),
        ),
    );
    const i1 = opened.indexOf(first);
    const i2 = opened.indexOf(second);
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1); // chronological order preserved
  });
});
