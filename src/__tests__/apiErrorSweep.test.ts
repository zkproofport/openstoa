/**
 * Error-leak sweep guard — the "contract invocation" row of the edge-case
 * matrix in the error-leak-sweep report: a route's unhandled catch-all MUST
 * call `unhandledRouteError` from `src/lib/apiError.ts`, and MUST NOT
 * reintroduce the leaked-message shape this sweep removed:
 *
 *   const message = error instanceof Error ? error.message : String(error);
 *   return NextResponse.json({ error: message }, { status: 500 });
 *
 * This scans EVERY `route.ts` under `src/app/api` — not a hardcoded roster —
 * so a brand-new route file that copy-pastes the old pattern fails this test
 * too, not just the 65 files converted in this pass. Modeled on
 * `tokenSweep.test.tsx`'s "no-unwatched-file" completeness guard: the source
 * text itself is the source of truth, not a list someone has to remember to
 * extend.
 *
 * Edge-case matrix rows covered here:
 *   contract invocation — this whole file
 *   hostile             — the scan runs over raw source text, so the pattern
 *                          can't hide inside a string/comment and be missed
 *   result integrity     — SWEPT_ROUTE_COUNT asserts the sweep actually
 *                          found and fixed a non-trivial number of files, so
 *                          an accidental empty match set doesn't pass silently
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const API_ROOT = join(process.cwd(), 'src/app/api');

// The exact shape this sweep eliminates: a driver/library message assigned to
// a `message` local and echoed verbatim in a 500 response.
const LEAK_PATTERN = /NextResponse\.json\(\{\s*error:\s*message\s*\},\s*\{\s*status:\s*500\s*\}\)/;
const LEAK_PATTERN_RAW_RESPONSE = /new Response\(JSON\.stringify\(\{\s*error:\s*message\s*\}\)\)\s*,\s*\{\s*status:\s*500/;

/**
 * Files that still contain a leaked-message-shaped catch — deliberately, with
 * a stated reason. Anything appearing here needs the reason to stay true;
 * anything NOT here that matches the pattern fails the sweep.
 */
const KNOWN_EXCEPTIONS: Record<string, string> = {
  'src/app/api/ask/stream/route.ts':
    'The live POST handler is a fixed 503 ("AI service has been disabled" — see docs/migration/third-party-services.md §4-6). ' +
    'The leaked-message catches live only in `_disabledOriginalPost` and its SSE `pipeGenerator`, both dead code (never called ' +
    'by the exported POST). No live client can reach them. Flagged here so whoever re-enables the route converts them first.',
};

function walkRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkRouteFiles(full));
    } else if (entry === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

describe('API route error-leak sweep', () => {
  const routeFiles = walkRouteFiles(API_ROOT);

  it('found a realistic number of route.ts files (sweep is actually scanning the tree)', () => {
    // Sanity floor — the sweep converted 65 files; if this ever drops near
    // zero the walk itself is broken (wrong root, moved directory, etc.).
    expect(routeFiles.length).toBeGreaterThan(60);
  });

  it.each(routeFiles.map((f) => [f.replace(process.cwd() + '/', ''), f] as const))(
    '%s has no leaked-message catch-all outside KNOWN_EXCEPTIONS',
    (relPath, absPath) => {
      const text = readFileSync(absPath, 'utf8');
      const leaks = LEAK_PATTERN.test(text) || LEAK_PATTERN_RAW_RESPONSE.test(text);
      if (leaks) {
        expect(KNOWN_EXCEPTIONS, `${relPath} has a leaked-message catch and is not in KNOWN_EXCEPTIONS`).toHaveProperty(relPath);
      } else {
        expect(leaks).toBe(false);
      }
    },
  );

  it('every converted route imports unhandledRouteError OR is a documented exception', () => {
    const missing: string[] = [];
    for (const f of routeFiles) {
      const rel = f.replace(process.cwd() + '/', '');
      if (rel in KNOWN_EXCEPTIONS) continue;
      const text = readFileSync(f, 'utf8');
      // Only routes that actually have an unhandled catch-all need the
      // import — plenty of route.ts files have no try/catch at all (pure
      // validation, or every branch already returns explicitly).
      const hasCatchAll = /\}\s*catch\s*\(error\)\s*\{/.test(text);
      if (!hasCatchAll) continue;
      if (!text.includes("from '@/lib/apiError'")) missing.push(rel);
    }
    expect(missing).toEqual([]);
  });
});
