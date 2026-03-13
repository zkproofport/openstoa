import { describe, it, expect } from 'vitest';
import { authGet, authPost, publicGet } from './helpers';

describe.sequential('Categories endpoints', () => {
  let categoryId: string;

  it('GET /api/categories returns category list', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.categories).toBeDefined();
    expect(Array.isArray(json.categories)).toBe(true);
    expect(json.categories.length).toBeGreaterThan(0);
    // Verify category structure
    const cat = json.categories[0];
    expect(cat.id).toBeTruthy();
    expect(cat.name).toBeTruthy();
    expect(cat.slug).toBeTruthy();
    categoryId = cat.id;
  });

  it('GET /api/categories is accessible without auth', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
  });

  it('GET /api/categories is accessible with auth', async () => {
    const res = await authGet('/api/categories');
    expect(res.status).toBe(200);
  });

  it('POST /api/topics requires categoryId', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E No Category ${Date.now()}`,
      visibility: 'public',
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('category');
  });

  it('POST /api/topics with categoryId succeeds', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E With Category ${Date.now()}`,
      description: 'Topic with category',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.topic.categoryId).toBe(categoryId);
    expect(json.topic.category).toBeDefined();
    expect(json.topic.category.id).toBe(categoryId);
  });

  it('GET /api/topics?view=all&category=<slug> filters by category', async () => {
    const catsRes = await publicGet('/api/categories');
    const cats = await catsRes.json();
    const slug = cats.categories[0].slug;

    const res = await publicGet(`/api/topics?view=all&category=${slug}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.topics)).toBe(true);
    // All returned topics should have the correct category
    for (const topic of json.topics) {
      if (topic.category) {
        expect(topic.category.slug).toBe(slug);
      }
    }
  });
});
