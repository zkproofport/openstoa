import { describe, it, expect } from 'vitest';
import { authGet, authPost, publicGet } from './helpers';

let categoryId: string;
let topicId: string;

/** 1x1 red PNG as ArrayBuffer (compatible with fetch BodyInit) */
function tinyPng(): ArrayBuffer {
  const buf = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
  );
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** 1x1 red PNG as base64 data URI */
function tinyPngDataUri(): string {
  return `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==`;
}

describe.sequential('Media upload E2E', () => {
  // ── Setup ──────────────────────────────────────────────────────────────────

  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
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

  // ── Test 1: Presigned URL upload flow ──────────────────────────────────────

  it('POST /api/upload returns uploadUrl and publicUrl', async () => {
    const png = tinyPng();
    const res = await authPost('/api/upload', {
      filename: 'test-e2e.png',
      contentType: 'image/png',
      size: png.byteLength,
      purpose: 'post',
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.uploadUrl).toBeTruthy();
    expect(json.publicUrl).toBeTruthy();
    expect(json.publicUrl).toContain('media.zkproofport.app');
  });

  it('PUT to presigned uploadUrl succeeds (HTTP 200 or 204)', async () => {
    const png = tinyPng();

    // Step 1: get presigned URL
    const uploadRes = await authPost('/api/upload', {
      filename: 'test-e2e-put.png',
      contentType: 'image/png',
      size: png.byteLength,
      purpose: 'post',
    });
    expect(uploadRes.status).toBe(200);
    const { uploadUrl, publicUrl } = await uploadRes.json();

    // Step 2: PUT file data directly to presigned URL (no auth header)
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    });
    expect([200, 204]).toContain(putRes.status);

    // Step 3: GET publicUrl — CDN should serve the uploaded file
    const getRes = await fetch(publicUrl);
    expect(getRes.status).toBe(200);
  });

  // ── Test 2: CDN image URL in post content is preserved ────────────────────

  it('POST with CDN image URL in content preserves the URL', async () => {
    const png = tinyPng();

    // Upload image first
    const uploadRes = await authPost('/api/upload', {
      filename: 'cdn-in-post.png',
      contentType: 'image/png',
      size: png.byteLength,
      purpose: 'post',
    });
    expect(uploadRes.status).toBe(200);
    const { uploadUrl, publicUrl } = await uploadRes.json();

    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    });

    // Create post with CDN URL in content
    const content = `<p>Here is a CDN image:</p><img src="${publicUrl}" alt="uploaded">`;
    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `CDN Image Post ${Date.now()}`,
      content,
    });
    expect(postRes.status).toBe(201);
    const postJson = await postRes.json();
    const postId = postJson.post.id;

    // GET post and verify CDN URL is preserved
    const detailRes = await authGet(`/api/posts/${postId}`);
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    expect(detailJson.post.content).toContain(publicUrl);
  });

  // ── Test 3: Base64 → CDN conversion ───────────────────────────────────────

  it('POST with base64 image converts to CDN URL on GET', async () => {
    const content = `<p>Here is an embedded image:</p><img src="${tinyPngDataUri()}" alt="base64">`;

    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Base64 Conversion Post ${Date.now()}`,
      content,
    });
    expect(postRes.status).toBe(201);
    const postJson = await postRes.json();
    const postId = postJson.post.id;

    // GET post detail and verify base64 was replaced
    const detailRes = await authGet(`/api/posts/${postId}`);
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    const returnedContent: string = detailJson.post.content;

    // The base64 data URI must be replaced with a CDN URL
    expect(returnedContent).not.toContain('data:image');
    expect(returnedContent).toContain('https://media.zkproofport.app/');

    // Verify the CDN URL is accessible
    const cdnUrlMatch = returnedContent.match(/https:\/\/media\.zkproofport\.app\/[^"'\s]+/);
    expect(cdnUrlMatch).not.toBeNull();
    const cdnUrl = cdnUrlMatch![0];
    const cdnRes = await fetch(cdnUrl);
    expect(cdnRes.status).toBe(200);
  });

  // ── Test 4: YouTube URL in post content ───────────────────────────────────

  it('POST with YouTube URL in content preserves the URL', async () => {
    const youtubeUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcB';
    const content = `<p>Watch this video: ${youtubeUrl}</p>`;

    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `YouTube URL Post ${Date.now()}`,
      content,
    });
    expect(postRes.status).toBe(201);
    const postJson = await postRes.json();
    const postId = postJson.post.id;

    const detailRes = await authGet(`/api/posts/${postId}`);
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    expect(detailJson.post.content).toContain('youtube.com/watch');
    expect(detailJson.post.content).toContain('dQw4w9WgXcB');
  });

  // ── Test 5: Mixed content post ────────────────────────────────────────────

  it('POST with mixed content (CDN image + YouTube + Vimeo + text) preserves all', async () => {
    const png = tinyPng();

    // Upload image for CDN URL
    const uploadRes = await authPost('/api/upload', {
      filename: 'mixed-post-img.png',
      contentType: 'image/png',
      size: png.byteLength,
      purpose: 'post',
    });
    expect(uploadRes.status).toBe(200);
    const { uploadUrl, publicUrl } = await uploadRes.json();

    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: png,
    });

    const youtubeUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcB';
    const vimeoUrl = 'https://vimeo.com/123456789';
    const content = [
      '<p>Mixed content post</p>',
      `<img src="${publicUrl}" alt="cdn-image">`,
      `<p>YouTube: ${youtubeUrl}</p>`,
      `<p>Vimeo: ${vimeoUrl}</p>`,
      '<p>Some trailing text</p>',
    ].join('');

    const postRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Mixed Content Post ${Date.now()}`,
      content,
    });
    expect(postRes.status).toBe(201);
    const postJson = await postRes.json();
    const postId = postJson.post.id;

    const detailRes = await authGet(`/api/posts/${postId}`);
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    const returnedContent: string = detailJson.post.content;

    expect(returnedContent).toContain(publicUrl);
    expect(returnedContent).toContain('youtube.com/watch');
    expect(returnedContent).toContain('vimeo.com');
    expect(returnedContent).toContain('Mixed content post');
    expect(returnedContent).toContain('Some trailing text');
  });
});
