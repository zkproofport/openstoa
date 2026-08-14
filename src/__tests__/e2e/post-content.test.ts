import { describe, it, expect } from 'vitest';
import { authGet, authPost, authPatch, publicGet, getBaseUrl, getAuthToken, getCdnOrigin, imgSrcs, isKnownMediaHost, R2_HOSTS, resolveMediaUrl } from './helpers';

// 1x1 red PNG buffer — small enough to inline.
function tinyPngBuffer(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
  );
}

const TS = Date.now();

let categoryId: string;
let topicId: string;

// Post IDs shared across tests
let plainTextPostId: string;
let htmlPostId: string;
let youtubePostId: string;
let youtubeShortsPostId: string;
let vimeoPostId: string;
let externalImagePostId: string;
let base64PostId: string;
let mixedPostId: string;
let gifPostId: string;
let multiYoutubePostId: string;

describe.sequential('Post rich content E2E', () => {
  // ── Setup ────────────────────────────────────────────────────────────────

  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('setup: create public topic for rich content tests', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Rich Content Topic ${TS}`,
      description: 'Topic for post rich content E2E tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    topicId = json.topic.id;
    expect(topicId).toBeTruthy();
  });

  // ── TC1: Plain text post ─────────────────────────────────────────────────

  it('TC1: plain text post — content stored and returned exactly', async () => {
    const content = `Plain text post for E2E test ${TS}. No HTML tags at all.`;
    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Plain Text Post ${TS}`,
      content,
      tags: ['e2e-rich-content'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    plainTextPostId = json.post.id;
    expect(plainTextPostId).toBeTruthy();

    // GET and verify content
    const getRes = await authGet(`/api/posts/${plainTextPostId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.post.content).toContain(`Plain text post for E2E test ${TS}`);
  });

  // ── TC2: HTML formatted content ──────────────────────────────────────────

  it('TC2: HTML formatted content — tags preserved', async () => {
    const content = [
      '<p>This is a <strong>bold</strong> and <em>italic</em> paragraph.</p>',
      '<br>',
      '<ul><li>Item one</li><li>Item two</li><li>Item three</li></ul>',
      '<p>Final paragraph with <strong>more bold</strong>.</p>',
    ].join('');

    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `HTML Formatted Post ${TS}`,
      content,
      tags: ['e2e-rich-content'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    htmlPostId = json.post.id;

    const getRes = await authGet(`/api/posts/${htmlPostId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    const returned: string = getJson.post.content;

    expect(returned).toContain('<strong>bold</strong>');
    expect(returned).toContain('<em>italic</em>');
    expect(returned).toContain('<ul>');
    expect(returned).toContain('<li>Item one</li>');
    expect(returned).toContain('<li>Item two</li>');
  });

  // ── TC3: YouTube URL ─────────────────────────────────────────────────────

  it('TC3: YouTube watch URL preserved in content', async () => {
    const ytUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const content = `<p>Watch this: ${ytUrl}</p>`;

    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `YouTube Post ${TS}`,
      content,
      tags: ['e2e-rich-content'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    youtubePostId = json.post.id;

    const getRes = await authGet(`/api/posts/${youtubePostId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.post.content).toContain('youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('TC3b: youtu.be short URL preserved in content', async () => {
    const shortUrl = 'https://youtu.be/dQw4w9WgXcQ';
    const content = `<p>Short link: ${shortUrl}</p>`;

    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `YouTube Short URL Post ${TS}`,
      content,
      tags: ['e2e-rich-content'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();

    const getRes = await authGet(`/api/posts/${json.post.id}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.post.content).toContain('youtu.be/dQw4w9WgXcQ');
  });

  // ── TC4: YouTube Shorts URL ──────────────────────────────────────────────

  it('TC4: YouTube Shorts URL preserved in content', async () => {
    const shortsUrl = 'https://www.youtube.com/shorts/dQw4w9WgXcQ';
    const content = `<p>Check this short: ${shortsUrl}</p>`;

    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `YouTube Shorts Post ${TS}`,
      content,
      tags: ['e2e-rich-content'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    youtubeShortsPostId = json.post.id;

    const getRes = await authGet(`/api/posts/${youtubeShortsPostId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.post.content).toContain('youtube.com/shorts/dQw4w9WgXcQ');
  });

  // ── TC5: Vimeo URL ───────────────────────────────────────────────────────

  it('TC5: Vimeo URL preserved in content', async () => {
    const vimeoUrl = 'https://vimeo.com/76979871';
    const content = `<p>Vimeo video: ${vimeoUrl}</p>`;

    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Vimeo Post ${TS}`,
      content,
      tags: ['e2e-rich-content'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    vimeoPostId = json.post.id;

    const getRes = await authGet(`/api/posts/${vimeoPostId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.post.content).toContain('vimeo.com/76979871');
  });

  // ── TC6: External image URL ──────────────────────────────────────────────

  it('TC6: external image URL preserved in content', async () => {
    const content = '<p>An image:</p><img src="https://placehold.co/150" alt="placeholder">';

    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `External Image Post ${TS}`,
      content,
      tags: ['e2e-rich-content'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    externalImagePostId = json.post.id;

    const getRes = await authGet(`/api/posts/${externalImagePostId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.post.content).toContain('<img');
    expect(getJson.post.content).toContain('https://placehold.co/150');
  });

  // ── TC7: Base64 image auto-upload to R2 CDN ──────────────────────────────

  it('TC7: base64 image replaced with R2 CDN URL', async () => {
    // Resolved first: `uploadBase64Images` swallows upload errors and leaves the
    // data URI in place, so on an environment without object storage this case
    // would otherwise fail as an unexplained content diff.
    const cdnOrigin = await getCdnOrigin();

    const tinyPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAE0lEQVQYV2P8z8Dwn4EIwMgwFACk1QkJFbp+DwAAAABJRU5ErkJggg==';
    const content = `<p>Embedded image:</p><img src="data:image/png;base64,${tinyPngBase64}" alt="tiny">`;

    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Base64 Image Post ${TS}`,
      content,
      tags: ['e2e-rich-content'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    base64PostId = json.post.id;

    // GET post — base64 should be replaced with CDN URL
    const getRes = await authGet(`/api/posts/${base64PostId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    const returned: string = getJson.post.content;

    // base64 data URI must NOT remain
    expect(returned).not.toContain('data:image/png;base64,');
    // …and what replaced it must be a real object on THIS environment's CDN,
    // still inside the <img> tag — not merely "some URL somewhere". M-6:
    // `srcs[0]` is root-relative on a flipped environment, which `new URL()`
    // cannot parse without a base — resolve against the app origin first
    // rather than assuming it's already absolute.
    const srcs = imgSrcs(returned);
    expect(srcs).toHaveLength(1);
    const uploaded = new URL(srcs[0], getBaseUrl());
    expect(uploaded.origin).toBe(srcs[0].startsWith('/') ? new URL(getBaseUrl()).origin : cdnOrigin);
    expect(uploaded.pathname.length).toBeGreaterThan(1);
    expect((await fetch(uploaded.href)).status).toBe(200);
  });

  // ── TC8: Mixed content — text + YouTube + external image + bold ──────────

  it('TC8: mixed content — all media types preserved', async () => {
    const content = [
      '<p><strong>Check this out!</strong></p>',
      '<p>https://www.youtube.com/watch?v=dQw4w9WgXcQ</p>',
      '<p><img src="https://placehold.co/300x200" alt="placeholder"></p>',
      '<p>What do you think?</p>',
    ].join('');

    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Mixed Content Post ${TS}`,
      content,
      tags: ['e2e-rich-content'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    mixedPostId = json.post.id;

    const getRes = await authGet(`/api/posts/${mixedPostId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    const returned: string = getJson.post.content;

    expect(returned).toContain('<strong>Check this out!</strong>');
    expect(returned).toContain('youtube.com/watch?v=dQw4w9WgXcQ');
    expect(returned).toContain('https://placehold.co/300x200');
    expect(returned).toContain('What do you think?');
  });

  // ── TC9: GIF URL ─────────────────────────────────────────────────────────

  it('TC9: GIF image URL preserved in content', async () => {
    const gifUrl =
      'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExMDRpbWxpMHdmNzl4NzRxbzN3a2x0Y2d6M3NrdXZhbHV6OXV0dSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/JIX9t2j0ZTN9S/giphy.gif';
    const content = `<p>Funny GIF:</p><img src="${gifUrl}" alt="gif">`;

    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `GIF Post ${TS}`,
      content,
      tags: ['e2e-rich-content'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    gifPostId = json.post.id;

    const getRes = await authGet(`/api/posts/${gifPostId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.post.content).toContain('giphy.gif');
    expect(getJson.post.content).toContain('<img');
  });

  // ── TC10: Edit post preserves rich content ───────────────────────────────

  it('TC10: PATCH post with rich content — updated content preserved', async () => {
    const updatedContent = [
      '<p><strong>Updated!</strong> New content with video and image.</p>',
      '<p>https://www.youtube.com/watch?v=oHg5SJYRHA0</p>',
      '<p><img src="https://placehold.co/400x300" alt="updated-img"></p>',
    ].join('');

    const res = await authPatch(`/api/posts/${mixedPostId}`, {
      content: updatedContent,
    });
    expect(res.status).toBe(200);

    const getRes = await authGet(`/api/posts/${mixedPostId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    const returned: string = getJson.post.content;

    expect(returned).toContain('<strong>Updated!</strong>');
    expect(returned).toContain('youtube.com/watch?v=oHg5SJYRHA0');
    expect(returned).toContain('https://placehold.co/400x300');
  });

  // ── TC11: Multiple YouTube URLs ──────────────────────────────────────────

  it('TC11: multiple YouTube URLs — all 3 preserved', async () => {
    const urls = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=oHg5SJYRHA0',
      'https://www.youtube.com/watch?v=9bZkp7q19f0',
    ];
    const content = urls.map((url) => `<p>${url}</p>`).join('');

    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Multi YouTube Post ${TS}`,
      content,
      tags: ['e2e-rich-content'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    multiYoutubePostId = json.post.id;

    const getRes = await authGet(`/api/posts/${multiYoutubePostId}`);
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    const returned: string = getJson.post.content;

    expect(returned).toContain('dQw4w9WgXcQ');
    expect(returned).toContain('oHg5SJYRHA0');
    expect(returned).toContain('9bZkp7q19f0');
  });

  // ── TC12: Upload multipart flow ───────────────────────────────────────────

  it('TC12: POST /api/upload (multipart) returns publicUrl on the CDN', async () => {
    // Names the environment gate (object storage configured?) before the status
    // assertion below reports it as a bare 500.
    const cdnOrigin = await getCdnOrigin();

    const form = new FormData();
    const bytes = new Uint8Array(tinyPngBuffer());
    form.append('file', new Blob([bytes], { type: 'image/png' }), `test-rich-content-${TS}.png`);
    form.append('purpose', 'post');
    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAuthToken()}` },
      body: form,
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.publicUrl).toBe('string');
    // M-6 (docs/design/media-bucket-privatisation.md): `R2_PUBLIC_URL` is
    // root-relative on a flipped environment, so `publicUrl` is now the SAME
    // origin as the app — the opposite of what this test asserted before
    // M-6 ("served off a separate CDN host, never the app origin"). Whether
    // THIS target has flipped is a separate, later per-environment step, so
    // prove whichever shape it actually returned rather than assuming one.
    if (json.publicUrl.startsWith('/')) {
      expect(json.publicUrl.startsWith('/api/media/'), `${json.publicUrl} is relative but not under /api/media/`).toBe(true);
      expect(new URL(json.publicUrl, getBaseUrl()).origin).toBe(new URL(getBaseUrl()).origin);
    } else {
      const url = new URL(json.publicUrl);
      // On the object store, not served back off the app origin. A deployed
      // environment must be one of the app's own R2 hosts over https, so cache
      // busting applies to it; a local stack serves from the MinIO that dev.sh
      // starts, whose address is the developer's LAN IP over http and cannot be
      // enumerated in advance.
      expect(isKnownMediaHost(url.hostname), `${url.hostname} is neither an R2 host nor a local one`).toBe(true);
      if (R2_HOSTS.includes(url.hostname)) expect(url.protocol).toBe('https:');
      expect(url.origin).not.toBe(new URL(getBaseUrl()).origin);
      expect(url.origin).toBe(cdnOrigin);
    }
    // No topicId was sent (genuinely no topic for this standalone upload
    // check), so this key is `user-upload`-classified — M-5's gate (real
    // now that `/api/media` enforces it instead of a public bucket bypassing
    // it) allows only the uploader to read it back.
    const cdn = await fetch(resolveMediaUrl(json.publicUrl, getBaseUrl())!, {
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    });
    expect(cdn.status).toBe(200);
  });

  // ── TC13: Upload validation — non-image rejected ─────────────────────────

  it('TC13: POST /api/upload with non-image MIME → 400', async () => {
    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'application/pdf' }), 'note.pdf');
    form.append('purpose', 'post');
    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAuthToken()}` },
      body: form,
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    const errorText = JSON.stringify(json).toLowerCase();
    expect(errorText).toContain('image');
  });

  // ── TC14: Upload validation — missing file field ─────────────────────────

  it('TC14: POST /api/upload without file field → 400', async () => {
    const form = new FormData();
    form.append('purpose', 'post');
    const res = await fetch(`${getBaseUrl()}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAuthToken()}` },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  // ── TC15: Guest reads rich content post in public topic ──────────────────

  it('TC15: guest reads mixed content post in public topic → 200', async () => {
    const res = await publicGet(`/api/posts/${mixedPostId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const returned: string = json.post.content;

    // After TC10 edit, content should contain updated values
    expect(returned).toContain('youtube.com/watch');
    expect(returned).toContain('<img');
    expect(returned).toBeTruthy();
  });
});
