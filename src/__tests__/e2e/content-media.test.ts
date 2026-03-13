import { describe, it, expect } from 'vitest';
import { authGet, authPost, publicGet } from './helpers';

let topicId: string;
let categoryId: string;

/**
 * Helper: verify that media field is either absent or null.
 * Pre-deployment: staging still returns media: null (old code includes it in SELECT).
 * Post-deployment: media is removed from SELECT, so it won't appear at all.
 */
function expectNoMedia(obj: Record<string, unknown>) {
  if ('media' in obj) {
    expect(obj.media).toBeNull();
  }
}

describe.sequential('Content & Media handling', () => {
  // Setup
  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('setup: create test topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Content Test Topic ${Date.now()}`,
      description: 'Topic for content/media E2E tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    topicId = json.topic.id;
  });

  // Test 1: Post with plain text — media not meaningful
  it('POST creates post with no meaningful media in response', async () => {
    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Plain Text Post ${Date.now()}`,
      content: '<p>This is a plain text post without any media.</p>',
      tags: ['e2e-test'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.id).toBeTruthy();
    expectNoMedia(json.post);
  });

  // Test 2: Post with YouTube URL in content
  it('POST creates post with YouTube URL preserved in content', async () => {
    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `YouTube Post ${Date.now()}`,
      content: '<p>Check this out: https://www.youtube.com/watch?v=dQw4w9WgXcB</p>',
      tags: ['e2e-test'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.id).toBeTruthy();
    expect(json.post.content).toContain('youtube.com/watch');
    expectNoMedia(json.post);
  });

  // Test 3: Post with Vimeo URL in content
  it('POST creates post with Vimeo URL preserved in content', async () => {
    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Vimeo Post ${Date.now()}`,
      content: '<p>Watch: https://vimeo.com/123456789</p>',
      tags: ['e2e-test'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.id).toBeTruthy();
    expect(json.post.content).toContain('vimeo.com');
    expectNoMedia(json.post);
  });

  // Test 4: Post with base64 image — after deployment, should be extracted to CDN URL
  it('POST with base64 image in content creates post successfully', async () => {
    // Small 1x1 red PNG as base64
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    const contentWithBase64 = `<p>Here is an image:</p><img src="data:image/png;base64,${tinyPng}" alt="test">`;

    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Base64 Image Post ${Date.now()}`,
      content: contentWithBase64,
      tags: ['e2e-test'],
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.id).toBeTruthy();
    // After deployment: base64 is replaced with CDN URL
    // Before deployment: base64 is preserved as-is
    // Either way, the content should contain an <img> tag
    expect(json.post.content).toContain('<img');
    expectNoMedia(json.post);
  });

  // Test 4b: Verify base64 → CDN URL conversion via GET post detail
  it('GET post detail after base64 image post shows CDN URL (not data URI)', async () => {
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    const contentWithBase64 = `<p>CDN conversion test:</p><img src="data:image/png;base64,${tinyPng}" alt="cdn-check">`;

    const createRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Base64 CDN Conversion Test ${Date.now()}`,
      content: contentWithBase64,
      tags: ['e2e-test'],
    });
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    const postId = createJson.post.id;

    const detailRes = await authGet(`/api/posts/${postId}`);
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    const returnedContent: string = detailJson.post.content;

    // base64 data URI must be replaced with CDN URL
    expect(returnedContent).not.toContain('data:image');
    expect(returnedContent).toContain('https://media.zkproofport.app/');
    expectNoMedia(detailJson.post);
  });

  // Test 5: GET post detail
  it('GET post detail returns content without meaningful media', async () => {
    const createRes = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Detail Test Post ${Date.now()}`,
      content: '<p>Test content for detail check</p>',
    });
    expect(createRes.status).toBe(201);
    const createJson = await createRes.json();
    const postId = createJson.post.id;

    const detailRes = await authGet(`/api/posts/${postId}`);
    expect(detailRes.status).toBe(200);
    const detailJson = await detailRes.json();
    expectNoMedia(detailJson.post);
    expect(detailJson.post.content).toBeTruthy();
  });

  // Test 6: GET topic posts list
  it('GET topic posts list returns posts without meaningful media', async () => {
    const res = await authGet(`/api/topics/${topicId}/posts`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.posts.length).toBeGreaterThan(0);
    for (const post of json.posts) {
      expectNoMedia(post);
    }
  });

  // Test 7: Guest access
  it('GET posts as guest returns posts without meaningful media', async () => {
    const res = await publicGet(`/api/topics/${topicId}/posts`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.posts.length).toBeGreaterThan(0);
    for (const post of json.posts) {
      expectNoMedia(post);
    }
  });

  // Test 8: Post creation without media field succeeds
  it('POST without media field in request body succeeds', async () => {
    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `No Media Field Post ${Date.now()}`,
      content: '<p>Simple post without media field in request</p>',
    });
    expect(res.status).toBe(201);
  });

  // Test 9: Content with mixed images and text preserves external URLs
  it('POST with mixed content preserves non-base64 images', async () => {
    const content = '<p>Text before</p><img src="https://example.com/photo.jpg" alt="external"><p>Text after</p>';
    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `Mixed Content Post ${Date.now()}`,
      content,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.content).toContain('https://example.com/photo.jpg');
  });
});
