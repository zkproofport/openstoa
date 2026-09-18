/**
 * An agent has to be able to LEARN about the personal space, not discover it
 * by being refused.
 *
 * OpenStoa's agent-facing docs are generated from the route JSDoc, so a
 * behaviour that lives only in code comments does not exist as far as an agent
 * is concerned. That is exactly what happened here: the space shipped, four
 * routes started refusing, `GET /api/topics` grew a whole new top-level field —
 * and every one of those facts was written in a `/* *\/` comment the generator
 * never reads.
 *
 * What that costs an agent: it lists topics and silently ignores `pinned`
 * because its schema does not mention it, so the one topic its user can always
 * reach is the one it never sees. Then it tries to invite someone, gets a 403
 * it has no explanation for, and writes a retry.
 *
 * The same drift, in the same shape, as the rename `token` field earlier today.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → the 200 schema DECLARES `pinned`, so it reaches the published OpenAPI
 *   contract  → the published OpenAPI actually carries it (the schema is not
 *               enough on its own — the generator has to have been re-run)
 *   contract  → each refusing route explains its own status in its description
 *   integrity → the CODE-JOIN page says 404, never 403 — a refusal there would
 *               confirm an account's private code names a real topic
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const document = JSON.parse(read('src/generated/openapi-spec.json'));
const operation = (path: string, method: string) => {
  const value = document.paths[path]?.[method];
  expect(value, `${method} ${path} is published`).toBeDefined();
  return value;
};

describe('what the published OpenAPI contract says about the space', () => {
  it('CONTRACT: the topics list schema declares `pinned`', () => {
    const route = read('src/app/api/topics/route.ts');
    const responses = route.slice(route.indexOf('*       200:'), route.indexOf('*       401:'));
    expect(responses).toContain('pinned:');
  });

  it('CONTRACT: the published topics schema preserves pinned and its ownership semantics', () => {
    const schema = operation('/api/topics', 'get').responses['200'].content['application/json'].schema;
    expect(schema.properties.pinned).toBeDefined();
    expect(schema.properties.pinned.nullable).toBe(true);
    const description = schema.properties.pinned.description;
    expect(description.toLowerCase()).toMatch(/own space|personal/);
    expect(description).toMatch(/CALLER|caller/);
    expect(description).toMatch(/guest/);
    expect(description).toMatch(/never another account/);
  });

  const REFUSALS: Array<[string, string, string, string]> = [
    ['generate invite', '/api/topics/{topicId}/invite', 'post', '403'],
    ['join topic', '/api/topics/{topicId}/join', 'post', '403'],
    ['lookup invite code', '/api/topics/join/{inviteCode}', 'get', '404'],
    ['leave topic', '/api/topics/{topicId}/leave', 'post', '409'],
  ];

  it.each(REFUSALS)('CONTRACT: %s explains its refusal', (_name, path, method, status) => {
    const published = operation(path, method);
    expect(published.description.toLowerCase()).toContain('personal space');
    expect(published.description).toContain(status);
    expect(published.responses[status]).toBeDefined();
  });

  it('INTEGRITY: code lookup documents 404 without confirming a private space exists', () => {
    const description = operation('/api/topics/join/{inviteCode}', 'get').description;
    const at = description.toLowerCase().indexOf('personal space');
    const sentence = description.slice(at, at + 260);
    expect(sentence).toContain('404');
    if (sentence.includes('403')) expect(sentence).toMatch(/not\s+403/);
  });
});
