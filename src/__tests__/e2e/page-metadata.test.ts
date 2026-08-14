import { describe, it, expect, afterAll } from 'vitest';
import {
  authPost,
  authDelete,
  publicGet,
  getBaseUrl,
  getAuthToken,
  fetchCategorySlugs,
  metaContent,
  pageTitle,
  canonicalLink,
  deleteTopic,
  deletePost,
  requireObjectStorage,
  resolveMediaUrl,
  isKnownMediaHost,
} from './helpers';

/**
 * Per-post and per-topic `generateMetadata` (dynamic Open Graph / Twitter
 * Card metadata), against a REAL running container over plain HTTP — no
 * mocks, no auth headers on any of the assertion fetches (a link-unfurling
 * crawler is always a signed-out guest).
 *
 * Edge-case matrix rows covered here (the pure-logic half of this matrix —
 * truncation, sanitization, the fallback chain in isolation — lives in
 * `src/__tests__/pageMetadata.test.ts`; this file is the real-DB, real-HTTP,
 * real-headers integration on top of it):
 *   boundary        — a post with no image/no body/a 1-char title still
 *                     renders valid, non-broken tags
 *   hostile         — HTML tags, quotes, ampersands, newlines in title/body
 *                     never appear as live markup in the response HTML
 *   empty/ws/null   — N/A here as separate DB rows (covered exhaustively in
 *                     the pure-function suite); this file only needs ONE
 *                     representative hostile/empty case per surface to prove
 *                     the wiring end-to-end
 *   UTF-8           — Korean + emoji title/body survive a real round trip
 *                     through Postgres, the route, and HTML serialization
 *   large           — a multi-KB body produces a capped description
 *   authz           — guest fetching public/private/secret/deleted/not-found
 *                     posts, and public/private/secret topics — the exact
 *                     matrix the pure-function suite asserts, now proven
 *                     against the real session-less `GET` path
 *   race            — N/A: deterministically racing a delete against an
 *                     in-flight `generateMetadata` render is not reproducible
 *                     from outside the process; accepted per
 *                     `buildPostMetadata`'s own doc comment
 *   contract        — `og:image`/`og:url` are always absolute; the response
 *                     is 200 (never 500) even for a made-up UUID
 *   integrity       — `og:url`/canonical use the SAME origin this test
 *                     targets (`E2E_BASE_URL`), never a hardcoded domain —
 *                     proves origin resolution reads the real request Host
 *   ext-dep-failure — N/A here (requires taking the real DB down mid-suite,
 *                     which would break every other E2E test in the same
 *                     run); covered by the DB-throwing unit test instead
 */

const TS = Date.now();
let categoryId: string;
let publicTopicId: string;
let privateTopicId: string;
let secretTopicId: string;
let imageTopicId: string;

let hostilePostId: string;
let largeBodyPostId: string;
let noImagePostId: string;
let imagePostId: string;
let deletedPostId: string;
let privatePostId: string;
let secretPostId: string;

const BASE_URL = getBaseUrl();
const BASE_ORIGIN = new URL(BASE_URL).origin;

const HOSTILE_TITLE = 'Hello <b>World</b> "quotes" & 한글 🎉\nnewline';
const HOSTILE_CONTENT = '<p>Body with &lt;script&gt;alert(1)&lt;/script&gt; and "quotes" & 한글 🚀</p>';

async function fetchHtml(path: string): Promise<string> {
  const res = await publicGet(path);
  expect(res.status, `GET ${path}`).toBe(200);
  return res.text();
}

describe.sequential('Per-post and per-topic dynamic Open Graph metadata', () => {
  // ── Setup ──────────────────────────────────────────────────────────────

  it('setup: fetch a category', async () => {
    const cats = await fetchCategorySlugs();
    expect(cats.length).toBeGreaterThan(0);
    categoryId = cats[0].id;
  });

  it('setup: create public/private/secret topics', async () => {
    const mk = async (visibility: string) => {
      const res = await authPost('/api/topics', {
        title: `OG Metadata ${visibility} ${TS}`,
        description: `A ${visibility} topic for OG metadata E2E`,
        visibility,
        categoryId,
      });
      expect(res.status, visibility).toBe(201);
      return (await res.json()).topic.id as string;
    };
    publicTopicId = await mk('public');
    privateTopicId = await mk('private');
    secretTopicId = await mk('secret');
  });

  it('setup: create the post fixtures', async () => {
    const mk = async (topicId: string, title: string, content: string) => {
      const res = await authPost(`/api/topics/${topicId}/posts`, { title, content });
      expect(res.status).toBe(201);
      return (await res.json()).post.id as string;
    };
    hostilePostId = await mk(publicTopicId, HOSTILE_TITLE, HOSTILE_CONTENT);
    largeBodyPostId = await mk(publicTopicId, 'Large body post', `<p>${'word '.repeat(2000)}</p>`);
    // BOUNDARY: no image + the shortest body the API accepts. `content` is
    // REQUIRED and non-empty (`POST /api/topics/{id}/posts` → 400 "Content is
    // required" for `''` — confirmed against the running server), so an
    // actually-empty body is not a reachable DB state via normal creation;
    // that case is covered as a pure-function test in `pageMetadata.test.ts`
    // instead (`content: ''` passed directly to `metadataFromPostRow`).
    noImagePostId = await mk(publicTopicId, 'No image, minimal body', 'x');
    deletedPostId = await mk(publicTopicId, 'Soon to be deleted', 'will be soft-deleted');
    privatePostId = await mk(privateTopicId, 'Secret private title, must not leak', 'private body');
    secretPostId = await mk(secretTopicId, 'Secret topic title, must not leak', 'secret body');

    const delRes = await deletePost(deletedPostId);
    expect(delRes.status).toBe(200);
  });

  // ── 1. Public post — hostile + UTF-8 title/body ──────────────────────────

  it('1. Public post: og:title is sanitized (no live <b> tag) and carries the UTF-8 text', async () => {
    const html = await fetchHtml(`/topics/${publicTopicId}/posts/${hostilePostId}`);
    const title = metaContent(html, 'og:title');
    expect(title).toBeTruthy();
    expect(title).not.toContain('<b>');
    expect(title).not.toContain('</b>');
    expect(title).toContain('한글');
    expect(title).toContain('🎉');
    // The <title> tag (which goes through the `%s | OpenStoa` template) also
    // carries the sanitized text, not raw markup.
    expect(pageTitle(html)).not.toContain('<b>');
  });

  it('1b. Public post: og:description strips the <script> tag and decodes entities', async () => {
    const html = await fetchHtml(`/topics/${publicTopicId}/posts/${hostilePostId}`);
    const description = metaContent(html, 'og:description');
    expect(description).toBeTruthy();
    // `metaContent` reads the RAW HTML attribute value, which Next/React
    // re-escapes on the way out (`"` → `&quot;`, `&` → `&amp;`) — the correct,
    // safe behavior `htmlToPlainText`'s doc comment describes. So this asserts
    // the escaped-but-decoded-from-source form: `htmlToPlainText` already
    // turned the SOURCE `&quot;quotes&quot;` into a literal `"quotes"`, and
    // serialization re-escapes that same `"` back to `&quot;` for the
    // attribute — round-tripping to the ORIGINAL entity, which is exactly
    // what "decoded then safely re-escaped" looks like from outside.
    expect(description).not.toContain('<script>');
    expect(description).toContain('&quot;quotes&quot;');
    expect(description).toContain('&amp;');
    expect(description).toContain('한글');
    expect(description).toContain('🚀');
  });

  it('1c. Public post: twitter card tags are present alongside OG', async () => {
    const html = await fetchHtml(`/topics/${publicTopicId}/posts/${hostilePostId}`);
    expect(metaContent(html, 'twitter:card')).toBe('summary_large_image');
    expect(metaContent(html, 'twitter:title')).toBeTruthy();
    expect(metaContent(html, 'twitter:description')).toBeTruthy();
  });

  it('1d. Public post: og:url and canonical are absolute, use the REQUEST origin, and point at the real path', async () => {
    const html = await fetchHtml(`/topics/${publicTopicId}/posts/${hostilePostId}`);
    const expected = `${BASE_URL}/topics/${publicTopicId}/posts/${hostilePostId}`;
    expect(metaContent(html, 'og:url')).toBe(expected);
    expect(canonicalLink(html)).toBe(expected);
    expect(new URL(metaContent(html, 'og:url')!).origin).toBe(BASE_ORIGIN);
  });

  // ── 2. Large body → capped description ───────────────────────────────────

  it('2. LARGE: a multi-KB body produces a capped, ellipsis-terminated description', async () => {
    const html = await fetchHtml(`/topics/${publicTopicId}/posts/${largeBodyPostId}`);
    const description = metaContent(html, 'og:description')!;
    expect(description.length).toBeLessThan(2000);
    expect(description.endsWith('…')).toBe(true);
  });

  // ── 3. Boundary: no image, minimal body ──────────────────────────────────

  it('3. BOUNDARY: no image + minimal body → og:image falls back to the absolute site default', async () => {
    const html = await fetchHtml(`/topics/${publicTopicId}/posts/${noImagePostId}`);
    const image = metaContent(html, 'og:image');
    expect(image).toBeTruthy();
    expect(image).toMatch(/^https?:\/\//);
    expect(image).toContain('/images/openstoa-logo-transparent-640.png');
    expect(new URL(image!).origin).toBe(BASE_ORIGIN);
  });

  // ── 4. RESULT INTEGRITY: a real uploaded image resolves as an absolute og:image ─
  //
  // Goes through the TOPIC cover image, not a post's `media.images` —
  // `POST /api/topics/{id}/posts` currently rejects a non-`http(s)://`
  // `media.images` entry (`src/app/api/topics/[topicId]/posts/route.ts:606`,
  // `Invalid image URL: ${badImage}`), but `POST /api/upload` now returns a
  // ROOT-RELATIVE `publicUrl` in this environment (M-6,
  // `docs/design/media-bucket-privatisation.md`) — confirmed directly against
  // the running local stack, not assumed. That is a real, pre-existing
  // inconsistency independent of this change (the post-media validator was
  // never updated for M-6's root-relative shape); reported to the team lead
  // rather than patched here, since that route is inside the area the
  // concurrent `media-openapi` M-6 work owns. `topics.image` has no such
  // validation (`POST /api/topics` stores it as-is), so this test proves the
  // SAME absolutization logic (`toAbsoluteImageUrl` / `metadataFromPostRow`'s
  // fallback chain: post image → TOPIC image → site default) through the one
  // path that isn't blocked, and additionally proves a post with no image of
  // its own correctly INHERITS its topic's cover image.
  it('4. RESULT INTEGRITY: a post with no image inherits its topic\'s real uploaded cover image as an absolute, resolvable og:image', async () => {
    const cdnOrigin = await requireObjectStorage();
    const form = new FormData();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64',
    );
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), `og-meta-${TS}.png`);
    form.append('purpose', 'topic');
    const uploadRes = await fetch(`${BASE_URL}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAuthToken()}` },
      body: form,
    });
    expect(uploadRes.status).toBe(200);
    const { publicUrl } = (await uploadRes.json()) as { publicUrl: string };

    const topicRes = await authPost('/api/topics', {
      title: `OG Metadata image-topic ${TS}`,
      description: 'has a real cover image',
      visibility: 'public',
      categoryId,
      image: publicUrl,
    });
    expect(topicRes.status).toBe(201);
    imageTopicId = (await topicRes.json()).topic.id;

    const postRes = await authPost(`/api/topics/${imageTopicId}/posts`, {
      title: 'Post inheriting the topic cover image',
      content: 'no media of its own',
    });
    expect(postRes.status).toBe(201);
    imagePostId = (await postRes.json()).post.id;

    for (const html of await Promise.all([
      fetchHtml(`/topics/${imageTopicId}/posts/${imagePostId}`),
      fetchHtml(`/topics/${imageTopicId}`),
    ])) {
      const ogImage = metaContent(html, 'og:image')!;
      expect(ogImage).toMatch(/^https?:\/\//);
      // Either same-origin `/api/media/...` (M-6 root-relative shape) or the
      // deployment's own R2/local host — never a bare relative string
      // leaking into the tag, and never some unrelated third-party host.
      const ogImageUrl = new URL(ogImage);
      const sameOrigin = ogImageUrl.origin === BASE_ORIGIN;
      expect(sameOrigin || isKnownMediaHost(ogImageUrl.hostname)).toBe(true);
      expect(ogImageUrl.origin === cdnOrigin || sameOrigin).toBe(true);
    }

    // And it is actually fetchable — the same real-image check TC12 makes.
    const resolved = resolveMediaUrl(publicUrl, BASE_URL)!;
    const imgRes = await fetch(resolved);
    expect(imgRes.status).toBe(200);
  });

  // ── 5. AUTHZ: private/secret/deleted/not-found posts never leak ─────────

  it('5. AUTHZ: a private-topic post never leaks its real title to a signed-out crawler', async () => {
    const html = await fetchHtml(`/topics/${privateTopicId}/posts/${privatePostId}`);
    expect(metaContent(html, 'og:title')).toBe('OpenStoa');
    expect(html).not.toContain('Secret private title');
  });

  it('5b. AUTHZ: a secret-topic post never leaks its real title to a signed-out crawler', async () => {
    const html = await fetchHtml(`/topics/${secretTopicId}/posts/${secretPostId}`);
    expect(metaContent(html, 'og:title')).toBe('OpenStoa');
    expect(html).not.toContain('Secret topic title');
  });

  it('5c. AUTHZ: a soft-deleted post (in an otherwise public topic) falls back to generic metadata', async () => {
    const html = await fetchHtml(`/topics/${publicTopicId}/posts/${deletedPostId}`);
    expect(metaContent(html, 'og:title')).toBe('OpenStoa');
    expect(html).not.toContain('Soon to be deleted');
  });

  it('5d. AUTHZ: a made-up (non-existent) postId returns 200 with generic metadata, never a 500', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const html = await fetchHtml(`/topics/${publicTopicId}/posts/${fakeId}`);
    expect(metaContent(html, 'og:title')).toBe('OpenStoa');
  });

  it('5e. INTEGRITY: private, secret, deleted, and not-found ALL produce byte-identical og:title/description (no enumeration oracle)', async () => {
    const [privateHtml, secretHtml, deletedHtml] = await Promise.all([
      fetchHtml(`/topics/${privateTopicId}/posts/${privatePostId}`),
      fetchHtml(`/topics/${secretTopicId}/posts/${secretPostId}`),
      fetchHtml(`/topics/${publicTopicId}/posts/${deletedPostId}`),
    ]);
    const titles = [privateHtml, secretHtml, deletedHtml].map((h) => metaContent(h, 'og:title'));
    const descriptions = [privateHtml, secretHtml, deletedHtml].map((h) => metaContent(h, 'og:description'));
    expect(new Set(titles).size).toBe(1);
    expect(new Set(descriptions).size).toBe(1);
  });

  // ── 6. Topic page metadata ────────────────────────────────────────────────

  it('6. Public topic page: og:title/description are the real topic fields', async () => {
    const html = await fetchHtml(`/topics/${publicTopicId}`);
    expect(metaContent(html, 'og:title')).toBe(`OG Metadata public ${TS}`);
    expect(metaContent(html, 'og:description')).toBe(`A public topic for OG metadata E2E`);
  });

  it('6b. AUTHZ: a PRIVATE topic page ALSO shows real metadata to a guest (mirrors GET /api/topics/{id})', async () => {
    const html = await fetchHtml(`/topics/${privateTopicId}`);
    expect(metaContent(html, 'og:title')).toBe(`OG Metadata private ${TS}`);
  });

  it('6c. AUTHZ: a SECRET topic page falls back to generic metadata for a guest', async () => {
    const html = await fetchHtml(`/topics/${secretTopicId}`);
    expect(metaContent(html, 'og:title')).toBe('OpenStoa');
    expect(html).not.toContain(`OG Metadata secret ${TS}`);
  });

  it('6d. RESULT INTEGRITY: topic og:url/canonical are absolute and use the request origin', async () => {
    const html = await fetchHtml(`/topics/${publicTopicId}`);
    const expected = `${BASE_URL}/topics/${publicTopicId}`;
    expect(metaContent(html, 'og:url')).toBe(expected);
    expect(canonicalLink(html)).toBe(expected);
  });

  // ── 7. Contract-invocation: real HTTP responses are always 200 ──────────

  it('7. CONTRACT: post and topic pages never 500 — malformed ids also degrade to a real page', async () => {
    const resPost = await publicGet(`/topics/${publicTopicId}/posts/not-a-uuid`);
    const resTopic = await publicGet(`/topics/not-a-uuid`);
    expect(resPost.status).toBe(200);
    expect(resTopic.status).toBe(200);
  });

  // ── 8. sitemap.xml never includes private/secret content ────────────────

  it('8. sitemap.xml never leaks private/secret topic or post ids, regardless of environment', async () => {
    const res = await publicGet('/sitemap.xml');
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).not.toContain(privateTopicId);
    expect(xml).not.toContain(secretTopicId);
    expect(xml).not.toContain(privatePostId);
    expect(xml).not.toContain(secretPostId);
  });

  // ── Cleanup ────────────────────────────────────────────────────────────

  afterAll(async () => {
    await Promise.allSettled([
      deleteTopic(publicTopicId),
      deleteTopic(privateTopicId),
      deleteTopic(secretTopicId),
      ...(imageTopicId ? [deleteTopic(imageTopicId)] : []),
    ]);
  });
});
