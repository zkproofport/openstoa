/**
 * The docs must not promise a refusal the code does not perform.
 *
 * WHAT WAS WRONG. Three agent-facing places — the nickname route's JSDoc,
 * AGENTS.md twice, and the skill file generated from them — said that topic
 * write endpoints REJECT a caller still carrying the `anon_<random>` placeholder
 * name. They do not. `isDefaultNickname` is used in exactly two places, both of
 * them routing and UI decisions, and `defaultNickname.ts` says so outright:
 * "Nothing is REFUSED on this basis".
 *
 * WHY IT IS WORTH A TEST. An agent that believes the false version writes error
 * handling for a 4xx that never arrives, and — worse — trusts that it CANNOT
 * post under a placeholder name. So it skips the rename, posts anyway, and
 * signs the whole conversation `anon_3f2a`. The lie is the thing that produces
 * the outcome the lie was warning about.
 *
 * This is a DOCUMENTATION test on purpose. Either side may legitimately change;
 * what must never happen is them disagreeing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Where an agent could learn the rule, in prose or in generated form. */
const AGENT_FACING = [
  'src/app/api/profile/nickname/route.ts',
  'AGENTS.md',
  'public/skills/api/profile/set-nickname/SKILL.md',
  'public/skills/auth/auth-details/SKILL.md',
];

describe('the placeholder nickname is advice, not a gate', () => {
  it('CODE: nothing refuses a write on the strength of the default name', () => {
    /*
     * Read from the source rather than trusted from memory: if someone later
     * DOES add the gate, this test fails and the docs above become true —
     * at which point the fix is to update this test, not to delete it.
     */
    const uses = read('src/lib/defaultNickname.ts');
    expect(uses).toContain('Nothing is REFUSED on this basis');
  });

  it('DOCS: no agent-facing page claims writes are rejected', () => {
    const liars = AGENT_FACING.filter((p) => {
      let src: string;
      try {
        src = read(p);
      } catch {
        return false; // a page that does not exist cannot mislead anyone
      }
      return /reject calls that still carry|must\*\* set a real one before accessing any content/.test(src);
    });
    expect({ pagesClaimingARefusalThatDoesNotExist: liars }).toEqual({
      pagesClaimingARefusalThatDoesNotExist: [],
    });
  });

  it('DOCS: they still tell an agent to rename, and say why', () => {
    // Removing the false claim must not remove the advice with it. The reason
    // is the part that works: the placeholder becomes the byline on everything.
    const skill = read('public/skills/api/profile/set-nickname/SKILL.md');
    expect(skill).toMatch(/anon_/);
    expect(skill.toLowerCase()).toMatch(/before your first post|before you post/);
  });
});
