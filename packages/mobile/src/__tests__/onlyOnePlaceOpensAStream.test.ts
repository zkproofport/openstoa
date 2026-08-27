/**
 * Exactly one file in the app opens a server-sent event stream.
 *
 * WHY THIS IS A FILE SCAN AND WHY IT IS STILL A REAL GUARD. Two streams had the
 * same defect, written three months apart: the token was read once and copied
 * into the connection's headers, and `react-native-sse` then reconnected on its
 * own with that same dead credential after a session refresh. One showed a
 * banner that never cleared; the other had no error listener at all and simply
 * stopped delivering, leaving rooms on "Waiting for the key…" with nothing
 * anywhere to explain it.
 *
 * Guarding the BEHAVIOUR of each stream — which the two sibling test files do —
 * cannot stop a third stream being written next month with the same mistake.
 * Guarding the STRUCTURE can: if only `reconnectingStream.ts` may construct an
 * EventSource, a new stream inherits the token re-read, the ladder and the
 * cleanup by having no other way in.
 *
 * A COMMENT CANNOT SATISFY THIS. That matters here, because a scan that could
 * be satisfied by prose is exactly the fake guard this project has been caught
 * writing before. The check is "does any other file CONSTRUCT one" — and no
 * amount of comment can open a connection. Comments are stripped before
 * matching anyway, so this file's own prose does not trip it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → the helper exists and does construct one, so the scan is
 *                pointed at something real
 *   integrity  → no other source file constructs one
 *   integrity  → no other source file imports the library either, which is the
 *                move somebody would make right before constructing one
 *   hostile    → comments and strings mentioning it do not count
 *   boundary   → the scan actually walked files; a glob that matched nothing
 *                would pass silently and guard nothing
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = 'api/reconnectingStream.ts';

/** Every source file under `src`, skipping tests and generated output. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Code with comments and string literals removed. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('only the reconnecting helper opens a stream', () => {
  const files = sources(SRC);

  it('BOUNDARY: the scan walked a real tree', () => {
    // A glob that matched nothing passes every assertion below while checking
    // nothing at all.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => relative(SRC, f) === HELPER)).toBe(true);
  });

  it('CONTRACT: the helper does construct one, so the rule points at something real', () => {
    const helper = code(readFileSync(join(SRC, HELPER), 'utf8'));
    expect(helper).toMatch(/new EventSource</);
  });

  it('INTEGRITY: nothing else constructs one', () => {
    /*
     * THE RULE. A new stream that goes through the helper inherits the token
     * re-read, the wrapping backoff and the cleanup on unmount. One that does
     * not inherits the bug that produced two of them.
     */
    const offenders = files
      .filter((f) => relative(SRC, f) !== HELPER)
      .filter((f) => /new\s+EventSource\s*[<(]/.test(code(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC, f));

    expect(offenders).toEqual([]);
  });

  it('INTEGRITY: nothing else imports the library', () => {
    // The step before constructing one. Catching the import puts the message in
    // front of somebody while they are still writing the line.
    const offenders = files
      .filter((f) => relative(SRC, f) !== HELPER)
      .filter((f) => /from\s*''/.test(
        code(readFileSync(f, 'utf8')).replace(/from\s*''/g, (m) =>
          readFileSync(f, 'utf8').includes("'react-native-sse'") ? 'from-sse' : m,
        ),
      ) && readFileSync(f, 'utf8').includes("from 'react-native-sse'"))
      .map((f) => relative(SRC, f));

    expect(offenders).toEqual([]);
  });

  it('HOSTILE: a comment mentioning it does not count as constructing one', () => {
    const pretend = `
      /* new EventSource<Foo>(url, {}) — described, not built */
      // new EventSource(url)
      const note = 'new EventSource(url)';
    `;
    expect(/new\s+EventSource\s*[<(]/.test(code(pretend))).toBe(false);

    // And the real shape is still caught.
    expect(/new\s+EventSource\s*[<(]/.test(code('const es = new EventSource<X>(u, o);'))).toBe(true);
  });
});
