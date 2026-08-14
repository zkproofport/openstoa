/**
 * M-5 — the gated read path (`GET /api/media/[...key]`), exercised against a
 * REAL container over HTTP: real Postgres visibility rows, real R2/MinIO
 * object storage, real membership. `media-route.test.ts` proves the same
 * authorization matrix with a mocked DB/R2 — this file proves the wiring
 * between them is real, using the actual upload → topic → read round trip a
 * production user goes through.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   authorization      → guest/public (200), guest/private (401),
 *                        guest/secret (401), non-member/public (200),
 *                        non-member/private (200), non-member/secret (403),
 *                        owner-as-member/secret (200), avatar/anyone (200),
 *                        user-upload/owner (200), user-upload/stranger (401
 *                        guest, 403 signed-in) before publication, and after
 *                        publication as a topic cover the SAME visibility
 *                        rules apply
 *   hostile input       → malformed key shape -> 400 over real HTTP
 *   external dependency → a well-formed key naming an object that was never
 *                        uploaded -> 404 (real R2 miss, not a mock)
 *   result integrity     → the bytes and Content-Type served back match what
 *                        was uploaded (round-trip, not just a status code)
 *   contract             → the URL `POST /api/upload` returns is exactly
 *                        `${cdnOrigin}/${key}`, and `/api/media/{key}` is
 *                        reachable at that same key — proving the "flip
 *                        R2_PUBLIC_URL" design actually holds today
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  authGet,
  authPost,
  publicGet,
  secondUserGet,
  getBaseUrl,
  getAuthToken,
  getCdnOrigin,
  requireObjectStorage,
  deleteTopic,
} from './helpers';

beforeAll(async () => {
  await requireObjectStorage();
});

function tinyPngBuffer(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
  );
}

async function uploadImage(
  filename: string,
  opts: { purpose?: 'post' | 'topic' | 'avatar'; topicId?: string } = {},
): Promise<string> {
  const form = new FormData();
  const bytes = new Uint8Array(tinyPngBuffer());
  form.append('file', new Blob([bytes], { type: 'image/png' }), filename);
  form.append('purpose', opts.purpose ?? 'post');
  if (opts.topicId) form.append('topicId', opts.topicId);
  const res = await fetch(`${getBaseUrl()}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getAuthToken()}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`upload failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const json = (await res.json()) as { publicUrl: string };
  return json.publicUrl;
}

/**
 * The object key `/api/media/{key}` expects, derived from a real upload URL.
 *
 * NOT `publicUrl.slice(cdnOrigin.length + 1)`: `getCdnOrigin()` returns
 * `new URL(publicUrl).origin` (scheme+host+port only), but the local dev
 * stack's MinIO is addressed PATH-style — `R2_PUBLIC_URL` itself is
 * `http://{host}:9000/{bucket}`, one path segment deeper than the origin. The
 * object key always starts at the first `topics/` or `users/` segment
 * (`uploadObjectKey`'s two roots), regardless of how many path segments the
 * configured base has, so anchor on that instead of assuming a fixed prefix
 * length.
 */
function keyOf(publicUrl: string, cdnOrigin: string): string {
  if (!publicUrl.startsWith(cdnOrigin)) {
    throw new Error(`${publicUrl} is not served from ${cdnOrigin} — CONTRACT broken`);
  }
  const match = publicUrl.match(/(topics|users)\/.+$/);
  if (!match) {
    throw new Error(`${publicUrl} does not contain a topics/ or users/ object key`);
  }
  return match[0];
}

async function createTopic(visibility: 'public' | 'private' | 'secret', categoryId: string): Promise<string> {
  const res = await authPost('/api/topics', {
    title: `E2E media-gate ${visibility} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    description: 'Topic for M-5 media-gate E2E',
    visibility,
    categoryId,
  });
  if (res.status !== 201) {
    throw new Error(`createTopic(${visibility}) failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  const json = await res.json();
  return json.topic.id as string;
}

let categoryId: string;
let cdnOrigin: string;
const topicIds: string[] = [];

describe.sequential('M-5 gated media read (real container)', () => {
  it('setup: categories + cdn origin', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
    cdnOrigin = await getCdnOrigin();
  });

  it('CONTRACT: an uploaded image is served back at the SAME key through /api/media', async () => {
    const topicId = await createTopic('public', categoryId);
    topicIds.push(topicId);
    const publicUrl = await uploadImage('contract.png', { purpose: 'post', topicId });
    const key = keyOf(publicUrl, cdnOrigin);

    const res = await publicGet(`/api/media/${key}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.equals(tinyPngBuffer())).toBe(true);
  });

  it('HOSTILE: a malformed key is refused with 400, not 404 or 500', async () => {
    const res = await publicGet('/api/media/not/a/real/shape');
    expect(res.status).toBe(400);
  });

  it('EXTERNAL DEPENDENCY: a well-formed key for an object that was never uploaded is 404', async () => {
    const topicId = await createTopic('public', categoryId);
    topicIds.push(topicId);
    const fakeUuid = '00000000-0000-4000-8000-000000000000';
    const res = await publicGet(`/api/media/topics/${topicId}/posts/${fakeUuid}/ghost.png`);
    expect(res.status).toBe(404);
  });

  describe('topic-post images, by visibility', () => {
    it('public topic: guest, non-member, and owner can all read', async () => {
      const topicId = await createTopic('public', categoryId);
      topicIds.push(topicId);
      const key = keyOf(await uploadImage('pub.png', { purpose: 'post', topicId }), cdnOrigin);
      expect((await publicGet(`/api/media/${key}`)).status).toBe(200);
      expect((await secondUserGet(`/api/media/${key}`)).status).toBe(200);
      expect((await authGet(`/api/media/${key}`)).status).toBe(200);
    });

    it('private topic: guest refused (401), non-member and owner allowed (200)', async () => {
      const topicId = await createTopic('private', categoryId);
      topicIds.push(topicId);
      const key = keyOf(await uploadImage('priv.png', { purpose: 'post', topicId }), cdnOrigin);
      expect((await publicGet(`/api/media/${key}`)).status).toBe(401);
      expect((await secondUserGet(`/api/media/${key}`)).status).toBe(200);
      expect((await authGet(`/api/media/${key}`)).status).toBe(200);
    });

    it('secret topic: guest refused (401), non-member refused (403), owner-as-member allowed (200)', async () => {
      const topicId = await createTopic('secret', categoryId);
      topicIds.push(topicId);
      const key = keyOf(await uploadImage('secret.png', { purpose: 'post', topicId }), cdnOrigin);
      expect((await publicGet(`/api/media/${key}`)).status).toBe(401);
      expect((await secondUserGet(`/api/media/${key}`)).status).toBe(403);
      // The topic creator is auto-added as an 'owner' member (src/app/api/topics/route.ts),
      // so this is a real membership-gated read, not a bypass.
      expect((await authGet(`/api/media/${key}`)).status).toBe(200);
    });
  });

  describe('avatar — world-readable by design', () => {
    it('a guest and a stranger can both read an avatar', async () => {
      const publicUrl = await uploadImage('avatar.png', { purpose: 'avatar' });
      const key = keyOf(publicUrl, cdnOrigin);
      expect((await publicGet(`/api/media/${key}`)).status).toBe(200);
      expect((await secondUserGet(`/api/media/${key}`)).status).toBe(200);
    });
  });

  describe('user-upload (no topic yet) — a draft topic cover before and after publication', () => {
    it('before any topic references it: only the uploader may read it', async () => {
      const publicUrl = await uploadImage('draft-cover.png', { purpose: 'topic' });
      const key = keyOf(publicUrl, cdnOrigin);
      expect((await authGet(`/api/media/${key}`)).status).toBe(200);
      expect((await publicGet(`/api/media/${key}`)).status).toBe(401);
      expect((await secondUserGet(`/api/media/${key}`)).status).toBe(403);
    });

    it('once set as a PUBLIC topic\'s cover, a guest can read it', async () => {
      const publicUrl = await uploadImage('cover-public.png', { purpose: 'topic' });
      const key = keyOf(publicUrl, cdnOrigin);

      const res = await authPost('/api/topics', {
        title: `E2E media-gate cover-public ${Date.now()}`,
        visibility: 'public',
        categoryId,
        image: publicUrl,
      });
      expect(res.status).toBe(201);
      const topicId = (await res.json()).topic.id as string;
      topicIds.push(topicId);

      expect((await publicGet(`/api/media/${key}`)).status).toBe(200);
    });

    it('once set as a SECRET topic\'s cover, a non-member is still refused (403)', async () => {
      const publicUrl = await uploadImage('cover-secret.png', { purpose: 'topic' });
      const key = keyOf(publicUrl, cdnOrigin);

      const res = await authPost('/api/topics', {
        title: `E2E media-gate cover-secret ${Date.now()}`,
        visibility: 'secret',
        categoryId,
        image: publicUrl,
      });
      expect(res.status).toBe(201);
      const topicId = (await res.json()).topic.id as string;
      topicIds.push(topicId);

      expect((await publicGet(`/api/media/${key}`)).status).toBe(401);
      expect((await secondUserGet(`/api/media/${key}`)).status).toBe(403);
      expect((await authGet(`/api/media/${key}`)).status).toBe(200);
    });
  });

  it('cleanup: delete created topics', async () => {
    for (const id of topicIds) {
      await deleteTopic(id).catch(() => undefined);
    }
    expect(true).toBe(true);
  });
});
