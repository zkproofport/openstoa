/**
 * The one topic whose ONLY way back is the backup must be in the backup.
 *
 * Every other secret topic has a second route: its chat keys also travel in an
 * invite link's fragment, so a member can be let back in. A personal space has
 * no invite — that is the feature — so the TAK keychain backup is the entire
 * recovery story, and the app now says so in as many words: "kept for you...
 * only your recovery code can bring this back".
 *
 * WHAT MAKES THIS FRAGILE. The uploader enumerates topics with a bare
 * `GET /api/topics`, which is the JOINED list. The browse list — the same
 * endpoint with `view=all` — deliberately EXCLUDES the personal space, because
 * an array that promises "every row matched your search and category filter"
 * cannot carry a row that matches neither. Switching this call to `view=all`
 * looks like using a more specific endpoint and would silently stop backing up
 * the space, and nothing would notice until somebody lost a phone.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → the enumeration uses the joined list, never the browse list
 *   integrity → it reads `topics`, so a `pinned`-only answer cannot slip past
 *   contract  → the ids feed the uploader rather than being read and dropped
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRANSPORT = readFileSync(join(SRC, 'crypto/mobileTransport.ts'), 'utf8');

/** The body of the function that lists topics to probe for keys. */
const ENUMERATION = (() => {
  const at = TRANSPORT.indexOf('async function joinedTopicIds');
  expect(at, 'joinedTopicIds is gone — the backup enumerates something else now').toBeGreaterThan(-1);
  return TRANSPORT.slice(at, TRANSPORT.indexOf('\n}', at));
})();

describe('what the TAK keychain backup enumerates', () => {
  it('CONTRACT: the JOINED list, never the browse list', () => {
    /*
     * `view=all` excludes the personal space by design. Using it here would
     * leave the space out of the backup — and the space is the one topic with
     * no other way home.
     */
    expect(ENUMERATION).toContain("'/api/topics'");
    expect(ENUMERATION).not.toContain('view=all');
  });

  it('INTEGRITY: it reads `topics`, so a pinned-only answer cannot slip past', () => {
    // The joined branch returns the space inside `topics`; reading only
    // `pinned` would work today and break the moment the shape moved.
    expect(ENUMERATION).toMatch(/res\.topics/);
  });

  it('CONTRACT: the ids actually reach the uploader', () => {
    // Enumerating and then not passing them is the same as not enumerating.
    const call = TRANSPORT.slice(TRANSPORT.indexOf('export async function uploadTakKeychainNow'));
    expect(call.slice(0, 900)).toMatch(/probeTopicIds\s*\?\?\s*\(await joinedTopicIds\(client\)\)/);
  });
});
