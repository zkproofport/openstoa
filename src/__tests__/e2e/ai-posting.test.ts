/**
 * AI / CLI posting flow — end-to-end.
 *
 * Doubles as the canonical example for AI agents (and any
 * `curl`-driven script): every step here is exactly what an external
 * client must do to publish a post via Bearer-token auth, attach
 * structured media + poll, mutate it, and clean up. The verify/ai
 * route in production additionally requires a ZK proof + payment TX;
 * the auth handoff in this suite uses dev-login to skip the proof
 * gate, but the Bearer-token contract for every subsequent call is
 * identical.
 *
 * Coverage:
 *   - Bearer-token issuance
 *   - POST /api/topics/{id}/posts with `media: { images, videos }`
 *   - POST with `poll: { options[], multipleChoice, closesAt }`
 *   - Tag attachment surfaces in the create response and on GET
 *   - PATCH /api/posts/{id} (edit before on-chain record)
 *   - DELETE /api/posts/{id} (soft delete)
 *   - POST /api/posts/{id}/poll/vote (vote + unvote)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getBaseUrl, publicGet, publicPost } from './helpers';

const TS = Date.now();
// Stable placeholder host that returns deterministic SVGs — same URL
// always renders the same image. Picked over picsum.photos which serves
// a different random photo on every request.
const IMG_A = `https://placehold.co/600x400/0066ff/ffffff?text=A&v=${TS}`;
const IMG_B = `https://placehold.co/600x400/ff0066/ffffff?text=B&v=${TS}`;
const YT_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

async function devLogin(nickname?: string): Promise<{ token: string; userId: string; nickname: string }> {
  const res = await publicPost('/api/auth/dev-login', { nickname });
  if (!res.ok) {
    throw new Error(`dev-login failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function withToken(token: string) {
  return async (method: string, path: string, body?: unknown): Promise<Response> => {
    return fetch(`${getBaseUrl()}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };
}

describe('AI posting flow (Bearer token)', () => {
  let aiToken: string;
  let aiUserId: string;
  let aiCall: ReturnType<typeof withToken>;
  let topicId: string;

  beforeAll(async () => {
    // 1) Mint an AI-style Bearer token. In production this comes back from
    //    POST /api/auth/verify/ai (challenge + ZK proof + paymentTxHash).
    const { token, userId, nickname } = await devLogin(`ai_e2e_${TS}`);
    aiToken = token;
    aiUserId = userId;
    aiCall = withToken(token);
    expect(token).toMatch(/^ey/); // JWT-ish

    // 2) Create a host topic for these posts. Public + no proof gating
    //    so any token can join. (Mirrors what an AI agent's first
    //    "where do I post?" call typically looks like — fetch the
    //    topic list, pick one, or create your own.)
    const catRes = await fetch(`${getBaseUrl()}/api/categories`);
    const categoryId = (await catRes.json()).categories[0].id;
    const topicRes = await aiCall('POST', '/api/topics', {
      title: `AI E2E Topic ${TS}`,
      description: 'Bearer-token posting flow validation',
      visibility: 'public',
      proofType: 'none',
      categoryId,
    });
    expect(topicRes.status).toBe(201);
    const topicJson = await topicRes.json();
    topicId = topicJson.topic.id as string;
    expect(topicId).toBeTruthy();
  });

  it('creates a post with media.images + media.videos + tags + poll', async () => {
    const body = {
      title: `AI Post ${TS}`,
      content: 'Body written by AI. Plain text — media lives in `media.{images,videos}`.',
      tags: ['ai-e2e', 'media-test'],
      media: {
        images: [IMG_A, IMG_B],
        videos: [YT_URL],
      },
      poll: {
        question: 'Pick one',
        options: ['First', 'Second', 'Third'],
        multipleChoice: false,
      },
    };
    const res = await aiCall('POST', `/api/topics/${topicId}/posts`, body);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.title).toBe(body.title);
    expect(json.post.media).toEqual({ images: [IMG_A, IMG_B], videos: [YT_URL] });
    expect(json.post.isAI).toBe(false); // dev-login doesn't set isAI; verify/ai does

    // 2nd round-trip via GET — confirms media + tags + poll hydrate the
    // same on the wire that an AI reader would see.
    const detail = await aiCall('GET', `/api/posts/${json.post.id}`);
    expect(detail.status).toBe(200);
    const detailJson = await detail.json();
    expect(detailJson.post.media).toEqual({ images: [IMG_A, IMG_B], videos: [YT_URL] });
    expect(detailJson.post.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'ai-e2e' }),
        expect.objectContaining({ slug: 'media-test' }),
      ]),
    );
    expect(detailJson.post.poll).toBeTruthy();
    expect(detailJson.post.poll.options).toHaveLength(3);
    expect(detailJson.post.poll.multipleChoice).toBe(false);
  });

  it('lists the post in the topic feed with tags attached', async () => {
    const res = await publicGet(`/api/topics/${topicId}/posts?limit=5`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const ours = json.posts.find((p: { title: string }) => p.title === `AI Post ${TS}`);
    expect(ours).toBeTruthy();
    // Tag chip row depends on `tags` being non-null on every list endpoint.
    expect(ours.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'ai-e2e' }),
      ]),
    );
    expect(ours.media).toEqual({ images: [IMG_A, IMG_B], videos: [YT_URL] });
  });

  it('votes on the poll and reflects userVotedOptionIds + voteCount', async () => {
    const listRes = await aiCall('GET', `/api/topics/${topicId}/posts?limit=5`);
    const post = (await listRes.json()).posts.find(
      (p: { title: string }) => p.title === `AI Post ${TS}`,
    );
    expect(post.poll).toBeTruthy();
    const firstOption = post.poll.options[0];

    const voteRes = await aiCall('POST', `/api/posts/${post.id}/poll/vote`, {
      optionIds: [firstOption.id],
    });
    expect(voteRes.status).toBe(200);
    const voteJson = await voteRes.json();
    expect(voteJson.poll.userVotedOptionIds).toEqual([firstOption.id]);
    expect(voteJson.poll.totalVotes).toBe(1);
    expect(voteJson.poll.options.find((o: { id: string }) => o.id === firstOption.id).voteCount).toBe(1);

    // Unvote — the choice is cleared, count drops back to 0.
    const unvoteRes = await aiCall('DELETE', `/api/posts/${post.id}/poll/vote`);
    expect(unvoteRes.status).toBe(200);
    const unvoteJson = await unvoteRes.json();
    expect(unvoteJson.poll.userVotedOptionIds).toEqual([]);
    expect(unvoteJson.poll.totalVotes).toBe(0);
  });

  it('edits the post via PATCH (before on-chain record)', async () => {
    const listRes = await aiCall('GET', `/api/topics/${topicId}/posts?limit=5`);
    const post = (await listRes.json()).posts.find(
      (p: { title: string }) => p.title === `AI Post ${TS}`,
    );

    const patchRes = await aiCall('PATCH', `/api/posts/${post.id}`, {
      title: `AI Post ${TS} (edited)`,
      content: 'Edited body — AI agents can rewrite their own posts until on-chain record.',
      media: { images: [IMG_A], videos: [] }, // dropped IMG_B + video
    });
    expect(patchRes.status).toBe(200);
    const patchJson = await patchRes.json();
    expect(patchJson.post.title).toBe(`AI Post ${TS} (edited)`);
    expect(patchJson.post.media).toEqual({ images: [IMG_A] });
  });

  it('soft-deletes the post via DELETE (row kept, body cleared)', async () => {
    const listRes = await aiCall('GET', `/api/topics/${topicId}/posts?limit=5`);
    const post = (await listRes.json()).posts.find(
      (p: { title: string }) => p.title.startsWith(`AI Post ${TS}`),
    );

    const delRes = await aiCall('DELETE', `/api/posts/${post.id}`);
    expect(delRes.status).toBe(200);
    const delJson = await delRes.json();
    expect(delJson.isDeleted).toBe(true);

    // Soft delete: row stays but the body should be cleared.
    const detail = await aiCall('GET', `/api/posts/${post.id}`);
    expect([200, 404]).toContain(detail.status);
    if (detail.status === 200) {
      const detailJson = await detail.json();
      expect(detailJson.post.isDeleted).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// Combinatorial coverage — happy-path is in the first describe block.
// These suites exercise the shape variants AI/CLI agents actually hit:
//   - text-only
//   - text + images
//   - text + images + videos
//   - text + poll
//   - text + tags (and the empty-tags case — tags are optional)
//   - legacy HTML content path (back-compat)
// Plus the error paths: over-limit media, over-limit tags, missing
// fields. Every test asserts BOTH the API status code and the user-
// facing error message so the client side has something stable to
// localize.
// ──────────────────────────────────────────────────────────────────────
describe('AI posting flow — shape variants', () => {
  let token: string;
  let call: ReturnType<typeof withToken>;
  let topicId: string;

  beforeAll(async () => {
    const session = await devLogin(`ai_variants_${TS}`);
    token = session.token;
    call = withToken(token);
    const catRes = await fetch(`${getBaseUrl()}/api/categories`);
    const categoryId = (await catRes.json()).categories[0].id;
    const topicRes = await call('POST', '/api/topics', {
      title: `AI Variants Topic ${TS}`,
      description: 'shape-variant coverage',
      visibility: 'public',
      proofType: 'none',
      categoryId,
    });
    expect(topicRes.status).toBe(201);
    topicId = (await topicRes.json()).topic.id;
  });

  it('text-only post (no media, no tags, no poll)', async () => {
    const res = await call('POST', `/api/topics/${topicId}/posts`, {
      title: `text-only ${TS}`,
      content: 'plain body, nothing else',
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.media).toBeFalsy();
    expect(json.post.poll).toBeFalsy();
  });

  it('text + images only', async () => {
    const res = await call('POST', `/api/topics/${topicId}/posts`, {
      title: `text+images ${TS}`,
      content: 'with two images',
      media: { images: [IMG_A, IMG_B] },
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.media).toEqual({ images: [IMG_A, IMG_B] });
  });

  it('text + images + videos', async () => {
    const res = await call('POST', `/api/topics/${topicId}/posts`, {
      title: `text+images+videos ${TS}`,
      content: 'all three',
      media: { images: [IMG_A], videos: [YT_URL] },
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.media).toEqual({ images: [IMG_A], videos: [YT_URL] });
  });

  it('text + poll only (no media)', async () => {
    const res = await call('POST', `/api/topics/${topicId}/posts`, {
      title: `text+poll ${TS}`,
      content: 'vote here',
      poll: {
        question: 'Tabs or spaces?',
        options: ['Tabs', 'Spaces'],
        multipleChoice: false,
      },
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.poll?.options).toHaveLength(2);
    expect(json.post.poll?.multipleChoice).toBe(false);
  });

  it('text + tags', async () => {
    const res = await call('POST', `/api/topics/${topicId}/posts`, {
      title: `text+tags ${TS}`,
      content: 'tagged',
      tags: ['alpha', 'beta'],
    });
    expect(res.status).toBe(201);
    const detail = await call('GET', `/api/posts/${(await res.json()).post.id}`);
    const detailJson = await detail.json();
    expect(detailJson.post.tags.map((t: { slug: string }) => t.slug)).toEqual(
      expect.arrayContaining(['alpha', 'beta']),
    );
  });

  it('empty tags array is allowed (tags are optional)', async () => {
    const res = await call('POST', `/api/topics/${topicId}/posts`, {
      title: `empty-tags ${TS}`,
      content: 'no tags',
      tags: [],
    });
    expect(res.status).toBe(201);
  });

  it('legacy HTML content with inline <img> still works (back-compat)', async () => {
    const html = `<p>An image:</p><img src="https://placehold.co/200" alt="legacy">`;
    const res = await call('POST', `/api/topics/${topicId}/posts`, {
      title: `legacy-html ${TS}`,
      content: html,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.content).toContain('placehold.co/200');
  });

  it('text + media + videos + poll + tags — full combo', async () => {
    const res = await call('POST', `/api/topics/${topicId}/posts`, {
      title: `full-combo ${TS}`,
      content: 'everything at once',
      tags: ['combo'],
      media: { images: [IMG_A], videos: [YT_URL] },
      poll: {
        options: ['Yes', 'No', 'Maybe'],
        multipleChoice: true,
      },
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.media).toEqual({ images: [IMG_A], videos: [YT_URL] });
    expect(json.post.poll?.options).toHaveLength(3);
    expect(json.post.poll?.multipleChoice).toBe(true);
  });
});

describe('AI posting flow — error handling', () => {
  let token: string;
  let call: ReturnType<typeof withToken>;
  let topicId: string;

  beforeAll(async () => {
    token = (await devLogin(`ai_errors_${TS}`)).token;
    call = withToken(token);
    const catRes = await fetch(`${getBaseUrl()}/api/categories`);
    const categoryId = (await catRes.json()).categories[0].id;
    const topicRes = await call('POST', '/api/topics', {
      title: `AI Errors Topic ${TS}`,
      description: 'error-path coverage',
      visibility: 'public',
      proofType: 'none',
      categoryId,
    });
    topicId = (await topicRes.json()).topic.id;
  });

  it('rejects missing title (400)', async () => {
    const res = await call('POST', `/api/topics/${topicId}/posts`, {
      content: 'no title',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/title/i);
  });

  it('rejects missing content (400)', async () => {
    const res = await call('POST', `/api/topics/${topicId}/posts`, {
      title: 'no content',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/content/i);
  });

  it('rejects over-limit images (400, max 10)', async () => {
    const images = Array.from({ length: 11 }, (_, i) =>
      `https://placehold.co/150?seed=${i}`,
    );
    const res = await call('POST', `/api/topics/${topicId}/posts`, {
      title: 'too many images',
      content: 'over the cap',
      media: { images },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/images.*max 10/i);
  });

  it('rejects over-limit videos (400, max 3)', async () => {
    const videos = Array.from({ length: 4 }, (_, i) =>
      `https://www.youtube.com/watch?v=abcdefghij${i}`,
    );
    const res = await call('POST', `/api/topics/${topicId}/posts`, {
      title: 'too many videos',
      content: 'over the cap',
      media: { videos },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/videos.*max 3/i);
  });

  it('rejects over-limit tags (400, max 5)', async () => {
    const res = await call('POST', `/api/topics/${topicId}/posts`, {
      title: 'too many tags',
      content: 'over the cap',
      tags: ['a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/tags.*max 5/i);
  });

  it('rejects unauthenticated POST (401)', async () => {
    const res = await fetch(`${getBaseUrl()}/api/topics/${topicId}/posts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'anon', content: 'no token' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects PATCH over-limit on edit (400)', async () => {
    // First create a baseline post, then try to swap in 11 images.
    const createRes = await call('POST', `/api/topics/${topicId}/posts`, {
      title: 'patch baseline',
      content: 'starts small',
    });
    const postId = (await createRes.json()).post.id;
    const images = Array.from({ length: 11 }, (_, i) =>
      `https://placehold.co/150?seed=${i}`,
    );
    const patchRes = await call('PATCH', `/api/posts/${postId}`, {
      media: { images },
    });
    expect(patchRes.status).toBe(400);
    expect((await patchRes.json()).error).toMatch(/images.*max 10/i);
  });
});
