import { describe, it, expect, beforeAll } from 'vitest';
import { authGet, authPost, authPatch, authDelete, getBaseUrl, getAuthToken, getCdnOrigin, requireObjectStorage, resolveMediaUrl } from './helpers';

// Every case in this file uploads. Without object storage they each fail on
// their own 500, which reads like the upload route is broken rather than like
// the environment has no credentials — so the condition is reported once here.
beforeAll(async () => {
  await requireObjectStorage();
});

let categoryId: string;
let topicId: string;

/** Literal-match a discovered origin (it carries `.` and `:`) inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
 *
 * `topicId` matters for M-5's gate, not just for filing: `uploadObjectKey`
 * classifies a key `topic-post` only when a topicId was actually given at
 * upload time — an object uploaded with none is `user-upload` (uploader-only
 * readable) FOREVER, even if its URL is later attached to a public post's
 * `media.images[]`. Per the real client contract (`POST /api/upload`'s own
 * JSDoc, `AGENTS.md`): "send topicId whenever you have one." Every caller
 * below that immediately attaches the result to a post inside `topicId` now
 * does — matching real client behaviour and what each test already asserted
 * ("should be reachable", "still reachable") before M-5's gate made the
 * omission observable. `uploadPng('x.png')` with no topicId stays the
 * deliberate case: an in-progress draft with genuinely no topic yet.
 */
async function uploadPng(filename: string, topicId?: string): Promise<string> {
  const form = new FormData();
  // Wrap the Buffer in a plain Uint8Array so undici's Blob constructor sees an
  // ArrayBufferView (Buffer in @types/node@22 has a wider buffer type that no
  // longer matches BlobPart directly).
  const bytes = new Uint8Array(tinyPngBuffer());
  const blob = new Blob([bytes], { type: 'image/png' });
  form.append('file', blob, filename);
  form.append('purpose', 'post');
  if (topicId) form.append('topicId', topicId);
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

/**
 * Fetch a URL with a cache-busting query string. Required for any poll that
 * verifies R2 deletion: the upload route sets
 * `Cache-Control: public, max-age=31536000, immutable`, so once the
 * Cloudflare CDN serves the object once it'll keep returning the cached 200
 * even after R2 has dropped the underlying key. Adding a unique `?_cb=…`
 * query forces a fresh origin lookup, which surfaces the 404 we actually
 * want to assert on.
 *
 * `authenticated`: pass true for a `user-upload`-classified object (no
 * topicId at upload time) — M-5's gate answers a GUEST 401 unconditionally
 * for those, before it ever checks whether the object still exists, so an
 * unauthenticated poll can never observe a 404 for one. `topic-post` objects
 * in a public topic don't need this (guests are gate-allowed either way).
 */
async function fetchUncached(url: string, authenticated = false): Promise<Response> {
  // M-6: `url` is whatever `uploadPng` returned — root-relative on any
  // environment that has flipped `R2_PUBLIC_URL` (docs/design/
  // media-bucket-privatisation.md). `resolveMediaUrl` is a no-op on an
  // already-absolute URL, so resolving unconditionally is correct either way.
  const resolved = resolveMediaUrl(url, getBaseUrl())!;
  const sep = resolved.includes('?') ? '&' : '?';
  const cacheBusted = `${resolved}${sep}_cb=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return fetch(cacheBusted, authenticated ? { headers: { Authorization: `Bearer ${getAuthToken()}` } } : undefined);
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
    expect(publicUrl.endsWith('/round-trip.png')).toBe(true);

    // M-6 (docs/design/media-bucket-privatisation.md): the code now mints a
    // root-relative `R2_PUBLIC_URL` (`/api/media`), but flipping any GIVEN
    // environment's own env var to that value is a separate, later step per
    // environment — this test's target may or may not have flipped yet, so
    // it proves BOTH shapes resolve and fetch correctly rather than assuming
    // one. `resolveMediaUrl` is the mini-app's REAL `absolutizeMediaUrl`
    // (re-exported in helpers.ts, not a copy) — a no-op on an already-absolute
    // URL, so calling it unconditionally is correct either way.
    const isRelative = publicUrl.startsWith('/');
    if (isRelative) {
      expect(publicUrl.startsWith('/api/media/'), `${publicUrl} is relative but not under /api/media/`).toBe(true);
    } else {
      const cdnOrigin = await getCdnOrigin();
      expect(publicUrl.startsWith(`${cdnOrigin}/`), `${publicUrl} is not served from ${cdnOrigin}`).toBe(true);
    }

    const resolved = resolveMediaUrl(publicUrl, getBaseUrl());
    expect(resolved).toBe(isRelative ? `${getBaseUrl()}${publicUrl}` : publicUrl);

    // No topicId was given (genuinely no topic yet), so this key is
    // `user-upload`-classified — M-5's gate (unchanged by M-6) allows only
    // the uploader to read it until it's filed under a topic. Under the OLD
    // public bucket this "just worked" for anyone because there was no gate
    // at all; now that `/api/media` is a real enforcement point, "the
    // uploader reads back what they just uploaded" needs their own
    // credential, same as any other authenticated read.
    const getRes = await fetch(resolved!, { headers: { Authorization: `Bearer ${getAuthToken()}` } });
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
    const publicUrl = await uploadPng('attach-to-post.png', topicId);

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
    // `media.images` above already proves the stored value round-trips
    // through the server UNCHANGED — relative in, relative out — so this
    // confirms the same value the API actually returns to a client is what
    // resolves and fetches, not a separately-reconstructed URL.
    const cdnRes = await fetch(resolveMediaUrl(publicUrl, getBaseUrl())!);
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
    // M-6: the inserted `<img src>` is whatever `uploadToR2` returned —
    // root-relative (`/api/media/...`) on a flipped environment, so the CDN
    // ORIGIN never appears as a literal prefix inside the HTML at all in
    // that case. Match either shape rather than assuming the origin-prefixed
    // one.
    const cdnOrigin = await getCdnOrigin();
    const cdnMatch = returned.match(
      new RegExp(
        `(?:${escapeRegExp(cdnOrigin)}|/api/media)[^"'\\s]+\\.(?:png|jpg|jpeg|webp|gif)`,
        'i',
      ),
    );
    expect(cdnMatch).not.toBeNull();
    const cdnRes = await fetch(resolveMediaUrl(cdnMatch![0], getBaseUrl())!);
    expect(cdnRes.status).toBe(200);
  });

  // ── Test 4: PATCH with image swap deletes the orphan ───────────────────────

  it('PATCH media.images swap deletes the dropped R2 object', async () => {
    const oldUrl = await uploadPng('patch-old.png', topicId);
    const newUrl = await uploadPng('patch-new.png', topicId);

    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Orphan-on-patch ${Date.now()}`,
      content: 'will swap images',
      media: { images: [oldUrl] },
    });
    expect(postRes.status).toBe(201);
    const postId = (await postRes.json()).post.id;

    // Skip the "both reachable" pre-check — it would warm the CDN cache for
    // oldUrl and mask the deletion we're trying to assert (immutable cache).

    const patchRes = await authPatch(`/api/posts/${postId}`, {
      media: { images: [newUrl] },
    });
    expect(patchRes.status).toBe(200);

    // R2 is eventually-consistent; poll briefly with cache-busting query so
    // each request hits the origin instead of a stale CDN entry.
    let oldStatus = 200;
    for (let i = 0; i < 10 && oldStatus !== 404 && oldStatus !== 403; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const r = await fetchUncached(oldUrl);
      oldStatus = r.status;
    }
    expect([403, 404]).toContain(oldStatus);

    // New URL still reachable.
    expect((await fetchUncached(newUrl)).status).toBe(200);
  });

  // ── Test 5: DELETE post wipes all attached images ──────────────────────────

  it('DELETE post wipes all attached R2 images', async () => {
    const url1 = await uploadPng('on-delete-1.png', topicId);
    const url2 = await uploadPng('on-delete-2.png', topicId);

    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Orphan-on-delete ${Date.now()}`,
      content: 'will delete',
      media: { images: [url1, url2] },
    });
    expect(postRes.status).toBe(201);
    const postId = (await postRes.json()).post.id;

    const delRes = await authDelete(`/api/posts/${postId}`);
    expect(delRes.status).toBe(200);

    // Poll until both objects 404 (cache-busted so CDN-cached 200 doesn't
    // mask the deletion).
    for (const url of [url1, url2]) {
      let status = 200;
      for (let i = 0; i < 10 && status !== 404 && status !== 403; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const r = await fetchUncached(url);
        status = r.status;
      }
      expect([403, 404]).toContain(status);
    }
  });

  // ── Test 6: DELETE /api/upload — draft-cancel cleanup ──────────────────────

  it('DELETE /api/upload removes uploaded files owned by the caller', async () => {
    const url = await uploadPng('draft-cancel.png');
    // Skip pre-fetch — it would warm the CDN cache and mask the deletion.

    const cleanupRes = await authDelete('/api/upload', { urls: [url] });
    expect(cleanupRes.status).toBe(200);
    const summary = (await cleanupRes.json()) as { attempted: number; deleted: number };
    expect(summary.attempted).toBe(1);
    expect(summary.deleted).toBe(1);

    // No topicId (draft-cancel — genuinely no topic yet), so this key is
    // `user-upload`-classified — poll AS THE OWNER: an unauthenticated poll
    // always gets 401 from M-5's gate before it ever checks whether the
    // object still exists, so it could never observe the 404 this test is
    // actually trying to prove. Authenticated as the owner, the gate always
    // allows (owner short-circuit), so the only reachable outcome once truly
    // deleted is 404 — never 403.
    let status = 200;
    for (let i = 0; i < 10 && status !== 404; i++) {
      await new Promise((r) => setTimeout(r, 500));
      status = (await fetchUncached(url, true)).status;
    }
    expect(status).toBe(404);
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
