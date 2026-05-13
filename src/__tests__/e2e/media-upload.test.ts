import { describe, it, expect } from 'vitest';
import { authGet, authPost, authPatch, authDelete, getBaseUrl, getAuthToken } from './helpers';

let categoryId: string;
let topicId: string;

/** 1x1 red PNG buffer (binary, not base64 — used for multipart bodies) */
function tinyPngBuffer(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
  );
}

/** 1x1 red PNG as base64 data URI (for legacy HTML-content inline image tests) */
function tinyPngDataUri(): string {
  return `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==`;
}

/**
 * POST /api/upload as multipart/form-data — mirrors the mobile client's
 * `uploadFile` and the production multipart route added in f4a6877.
 * Returns the public CDN URL.
 */
async function uploadPng(filename: string): Promise<string> {
  const form = new FormData();
  // Wrap the Buffer in a plain Uint8Array so undici's Blob constructor sees an
  // ArrayBufferView (Buffer in @types/node@22 has a wider buffer type that no
  // longer matches BlobPart directly).
  const bytes = new Uint8Array(tinyPngBuffer());
  const blob = new Blob([bytes], { type: 'image/png' });
  form.append('file', blob, filename);
  form.append('purpose', 'post');
  const res = await fetch(`${getBaseUrl()}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getAuthToken()}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`upload failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as { publicUrl: string };
  return json.publicUrl;
}

describe.sequential('Media upload E2E (multipart + R2 orphan cleanup)', () => {
  // ── Setup ──────────────────────────────────────────────────────────────────

  it('setup: fetch categories', async () => {
    const res = await fetch(`${getBaseUrl()}/api/categories`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('setup: create test topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Media Upload Topic ${Date.now()}`,
      description: 'Topic for media upload E2E tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    topicId = json.topic.id;
  });

  // ── Test 1: Multipart round-trip ───────────────────────────────────────────

  it('POST /api/upload (multipart) returns publicUrl that serves the file', async () => {
    const publicUrl = await uploadPng('round-trip.png');
    expect(publicUrl).toMatch(/^https:\/\/[^/]+\/.+\/round-trip\.png$/);

    const getRes = await fetch(publicUrl);
    expect(getRes.status).toBe(200);
    const buf = Buffer.from(await getRes.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
  });

  it('POST /api/upload rejects missing file field', async () => {
    const form = new FormData();
    form.append('purpose', 'post');
    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAuthToken()}` },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/upload rejects non-image MIME', async () => {
    const form = new FormData();
    form.append('file', new Blob(['not an image'], { type: 'text/plain' }), 'note.txt');
    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAuthToken()}` },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  // ── Test 2: Upload → POST with media.images → image stays reachable ────────

  it('upload → POST /api/topics/:id/posts with media.images preserves the URL', async () => {
    const publicUrl = await uploadPng('attach-to-post.png');

    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Attach-to-post ${Date.now()}`,
      content: 'media.images structured payload',
      media: { images: [publicUrl] },
    });
    expect(postRes.status).toBe(201);
    const postJson = await postRes.json();
    const postId = postJson.post.id;

    const detailRes = await authGet(`/api/posts/${postId}`);
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json();
    expect(detail.post.media?.images).toEqual([publicUrl]);

    // The CDN object should still be reachable while the post exists.
    const cdnRes = await fetch(publicUrl);
    expect(cdnRes.status).toBe(200);
  });

  // ── Test 3: Base64 → CDN conversion (legacy HTML path) ─────────────────────

  it('POST with base64 image in HTML content converts to CDN URL', async () => {
    const content = `<p>Here is an embedded image:</p><img src="${tinyPngDataUri()}" alt="base64">`;
    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Base64 Conversion Post ${Date.now()}`,
      content,
    });
    expect(postRes.status).toBe(201);
    const postId = (await postRes.json()).post.id;

    const detail = await (await authGet(`/api/posts/${postId}`)).json();
    const returned: string = detail.post.content;
    expect(returned).not.toContain('data:image');
    const cdnMatch = returned.match(/https:\/\/[^"'\s]+\.(?:png|jpg|jpeg|webp|gif)/i);
    expect(cdnMatch).not.toBeNull();
    const cdnRes = await fetch(cdnMatch![0]);
    expect(cdnRes.status).toBe(200);
  });

  // ── Test 4: PATCH with image swap deletes the orphan ───────────────────────

  it('PATCH media.images swap deletes the dropped R2 object', async () => {
    const oldUrl = await uploadPng('patch-old.png');
    const newUrl = await uploadPng('patch-new.png');

    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Orphan-on-patch ${Date.now()}`,
      content: 'will swap images',
      media: { images: [oldUrl] },
    });
    expect(postRes.status).toBe(201);
    const postId = (await postRes.json()).post.id;

    // Both URLs reachable before the swap.
    expect((await fetch(oldUrl)).status).toBe(200);
    expect((await fetch(newUrl)).status).toBe(200);

    const patchRes = await authPatch(`/api/posts/${postId}`, {
      media: { images: [newUrl] },
    });
    expect(patchRes.status).toBe(200);

    // CDN is eventually-consistent; poll briefly until the old key 404s.
    let oldStatus = 200;
    for (let i = 0; i < 10 && oldStatus !== 404 && oldStatus !== 403; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const r = await fetch(oldUrl);
      oldStatus = r.status;
    }
    expect([403, 404]).toContain(oldStatus);

    // New URL still reachable.
    expect((await fetch(newUrl)).status).toBe(200);
  });

  // ── Test 5: DELETE post wipes all attached images ──────────────────────────

  it('DELETE post wipes all attached R2 images', async () => {
    const url1 = await uploadPng('on-delete-1.png');
    const url2 = await uploadPng('on-delete-2.png');

    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Orphan-on-delete ${Date.now()}`,
      content: 'will delete',
      media: { images: [url1, url2] },
    });
    expect(postRes.status).toBe(201);
    const postId = (await postRes.json()).post.id;

    const delRes = await authDelete(`/api/posts/${postId}`);
    expect(delRes.status).toBe(200);

    // Poll until both objects 404.
    for (const url of [url1, url2]) {
      let status = 200;
      for (let i = 0; i < 10 && status !== 404 && status !== 403; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const r = await fetch(url);
        status = r.status;
      }
      expect([403, 404]).toContain(status);
    }
  });

  // ── Test 6: DELETE /api/upload — draft-cancel cleanup ──────────────────────

  it('DELETE /api/upload removes uploaded files owned by the caller', async () => {
    const url = await uploadPng('draft-cancel.png');
    expect((await fetch(url)).status).toBe(200);

    const cleanupRes = await authDelete('/api/upload', { urls: [url] });
    expect(cleanupRes.status).toBe(200);
    const summary = (await cleanupRes.json()) as { attempted: number; deleted: number };
    expect(summary.attempted).toBe(1);
    expect(summary.deleted).toBe(1);

    let status = 200;
    for (let i = 0; i < 10 && status !== 404 && status !== 403; i++) {
      await new Promise((r) => setTimeout(r, 500));
      status = (await fetch(url)).status;
    }
    expect([403, 404]).toContain(status);
  });

  it("DELETE /api/upload skips URLs not owned by the caller", async () => {
    // Forge a URL with a different userId segment. The server should refuse
    // to delete it (skipped, not deleted) — this guards against URL-guessing
    // attacks where one user tries to nuke another user's uploads.
    const fakeUrl = 'https://media.zkproofport.app/staging/posts/00000000-0000-0000-0000-000000000000/abc/forged.png';
    const cleanupRes = await authDelete('/api/upload', { urls: [fakeUrl] });
    expect(cleanupRes.status).toBe(200);
    const summary = (await cleanupRes.json()) as { attempted: number; deleted: number; skipped: number };
    expect(summary.attempted).toBe(1);
    expect(summary.deleted).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it('DELETE /api/upload rejects bad body', async () => {
    const res = await authDelete('/api/upload', { urls: 'not-an-array' });
    expect(res.status).toBe(400);
  });
});
