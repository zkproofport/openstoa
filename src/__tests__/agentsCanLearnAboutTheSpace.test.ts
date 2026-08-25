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
 *   contract  → the 200 schema DECLARES `pinned`, so it reaches the skill file
 *   contract  → the generated skill actually carries it (the schema is not
 *               enough on its own — the generator has to have been re-run)
 *   contract  → each refusing route explains its own status in its description
 *   integrity → the CODE-JOIN page says 404, never 403 — a refusal there would
 *               confirm an account's private code names a real topic
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('what the generated agent docs say about the space', () => {
  it('CONTRACT: the topics list schema declares `pinned`', () => {
    const route = read('src/app/api/topics/route.ts');
    const responses = route.slice(route.indexOf('*       200:'), route.indexOf('*       401:'));
    expect(responses).toContain('pinned:');
  });

  it('CONTRACT: the generated skill carries it, with what it is', () => {
    /*
     * Asserted on the OUTPUT, not just the source: the schema being right and
     * the skill being stale is the whole failure mode — the generator has to
     * have been re-run, which is why `prebuild` does it.
     */
    const skill = read('public/skills/api/topics/list-topics/SKILL.md');
    expect(skill).toContain('pinned');
    expect(skill.toLowerCase()).toMatch(/own space|personal/);
  });

  const REFUSALS: Array<[string, string, string]> = [
    ['generate-invite-token', 'api/topics/generate-invite-token', '403'],
    ['join-topic', 'api/topics/join-topic', '403'],
    ['lookup-invite-code', 'api/topics/lookup-invite-code', '404'],
    ['leave-topic', 'api/members/leave-topic', '409'],
  ];

  it.each(REFUSALS)('CONTRACT: %s explains its refusal', (_name, path, status) => {
    const file = `public/skills/${path}/SKILL.md`;
    expect(existsSync(join(ROOT, file)), `${file} was not generated`).toBe(true);
    const skill = read(file);
    expect(skill.toLowerCase()).toContain('personal space');
    expect(skill).toContain(status);
  });

  it('INTEGRITY: the code-join page says 404 and never 403', () => {
    /*
     * The one place the status itself is a security property. A 403 would tell
     * whoever is probing codes that this one names a real topic — which is to
     * say, that an account exists and this is its space.
     */
    const skill = read('public/skills/api/topics/lookup-invite-code/SKILL.md');
    const at = skill.toLowerCase().indexOf('personal space');
    const sentence = skill.slice(at, at + 260);
    expect(sentence).toContain('404');
    /*
     * 403 may appear, but only as the contrast — "404 here, not 403" is the
     * clearest way to say it and is worth keeping. What must never appear is
     * 403 offered as the answer, so the mention is required to be a denial.
     */
    if (sentence.includes('403')) expect(sentence).toMatch(/not\s+403/);
  });
});
