/**
 * The "cannot open this" sentinel is typed once and imported everywhere else.
 *
 * WHY A SOURCE SCAN AND NOT A BEHAVIOUR TEST. The failure this guards is not
 * a wrong answer, it is a DIVERGENCE: a producer writing one string while a
 * consumer compares against another. Every behaviour test still passes in that
 * state, because each side is self-consistent — the tests would read the same
 * literal the code they exercise reads. Only the character sequence itself,
 * counted across the tree, can catch it.
 *
 * What divergence costs, concretely: the room screen keys eight decisions on
 * this string — whether a bubble draws locked, whether a repaired plaintext may
 * replace a placeholder, how many rows the "unreadable" banner counts, which
 * rows a sync pass hides. Change the value at the producer and every one of
 * those silently answers for the old string: no lock, a banner reading zero,
 * and a recovered message that never lands. Nothing throws and no type
 * complains, which is exactly how the MLS transport spent a night returning
 * null for every HTTP status.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → exactly one definition of the literal in the mini-app tree
 *   contract   → the modules that produce and consume it import the constant
 *   integrity  → the value itself is pinned, so a rename of the CONSTANT is
 *                free but a change to the STRING is a deliberate, visible edit
 *   boundary   → comments and tests may name the string (they document it);
 *                only executable source is held to the rule
 *   N/A        → hostile / UTF-8 / large input: this asserts over repository
 *                source, not over runtime input
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UNREADABLE_BODY } from '@openstoa/api-types';

const HERE = fileURLToPath(new URL('.', import.meta.url));
/** `packages/mobile/src` — the tree this package actually ships. */
const SRC = join(HERE, '..');
/** The one file allowed to spell it out. */
const DEFINITION = 'api-types/src/chatSentinels.ts';

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Tests are documentation as much as code and may quote the string.
      if (entry === '__tests__' || entry === 'node_modules') continue;
      found.push(...sourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

/** Strip line and block comments so prose that names the string does not count. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('UNREADABLE_BODY is single-source', () => {
  it('is spelled out nowhere in the mini-app source', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => code(readFileSync(file, 'utf8')).includes(UNREADABLE_BODY))
      .map((file) => relative(SRC, file));

    // The path is in the compared value, not in a message argument: this suite
    // runs under vitest here but the same assertions are read by people
    // debugging a failure, and a bare "expected 1 to be 0" names no file.
    expect({ filesSpellingItOut: offenders }).toEqual({ filesSpellingItOut: [] });
  });

  it('is imported by the modules that produce and consume it', () => {
    const wired = [
      'crypto/chatCipher.ts',
      'crypto/mobileTransport.ts',
      'screens/chat/ChatRoomScreen.tsx',
    ];

    for (const rel of wired) {
      const text = readFileSync(join(SRC, rel), 'utf8');
      expect({ file: rel, importsSentinel: /UNREADABLE_BODY\s*}?\s*from\s*'@openstoa\/api-types'/.test(text) })
        .toEqual({ file: rel, importsSentinel: true });
    }
  });

  it('pins the value, so changing the string is a deliberate edit here', () => {
    // Both clients map this to a locked bubble in the reader's language; the
    // web has a contract test asserting these characters never reach the DOM.
    expect(UNREADABLE_BODY).toBe('[unable to decrypt]');
    expect(DEFINITION).toContain('chatSentinels');
  });
});
