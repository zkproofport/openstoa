/**
 * UUID-format guard sweep — the "contract invocation" row for the malformed-
 * id follow-up (src/lib/uuid.ts). Every `route.ts` handler that destructures
 * a `[topicId]`/`[postId]`/`[commentId]`/`[keyId]` path param and hands it to
 * a Drizzle `eq(<uuid column>, id)` query MUST validate its shape before that
 * query runs — directly via `isValidUUID`, or indirectly via an equivalent
 * pre-existing check this sweep found and deliberately did NOT duplicate
 * (see KNOWN_INDIRECT_GUARDS below). A handler with neither is a regression:
 * a malformed id would reach Postgres and 500 with driver text again.
 *
 * Walks the actual route tree (not a hardcoded roster) so a new dynamic
 * route under one of these segments is checked automatically.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const API_ROOT = join(process.cwd(), 'src/app/api');
const UUID_SEGMENTS = ['[topicId]', '[postId]', '[commentId]', '[keyId]'];

/**
 * Handlers that validate the id's shape through a route-local mechanism that
 * already existed before this sweep, rather than a direct `isValidUUID(...)`
 * call at the top of the handler. Each entry names why duplicating the guard
 * would have been redundant dead code (verified: the codemod's first pass
 * DID insert a direct guard here, and it was removed after confirming the
 * pre-existing check already ran first and returned the same 400 shape).
 */
const KNOWN_INDIRECT_GUARDS: Record<string, string> = {
  'src/app/api/profile/api-keys/[keyId]/route.ts':
    "Both PATCH and DELETE already ran `UUID_RE.test(keyId)` (local regex, `{ error: 'keyId must be a uuid' }`, 400) before this sweep existed.",
  'src/app/api/topics/[topicId]/push/route.ts':
    "Both GET and PATCH call a shared `authorize(request, topicId)` helper that already ran `isUuid(topicId)` (from src/lib/pushPrefs.ts, `{ error: 'Invalid topicId' }`, 400) before any query.",
  'src/app/api/topics/[topicId]/chat/read/route.ts':
    "Both PUT and GET call a shared `gate(request, topicId)` helper that runs `isValidUUID(topicId)` (`{ error: 'Invalid topicId' }`, 400) before the membership query. The gate is shared precisely so the two handlers cannot disagree about who may write and who may read a cursor — an authorization check duplicated across handlers is one someone tightens on a single side.",
};

/**
 * The body of each exported route handler in a file.
 *
 * Shared by the two checks below so they cannot disagree about what "inside a
 * handler" means — the staleness check exists to catch an exemption whose
 * handler has since grown a direct guard, and it can only do that if it looks
 * at the same text the guard check does.
 */
function handlerSegments(text: string): Array<{ method: string; body: string }> {
  const funcMatches = [...text.matchAll(/export async function (GET|POST|PATCH|DELETE|PUT)\s*\(/g)];
  const bounds = [...funcMatches.map((m) => m.index!), text.length];
  return funcMatches.map((m, i) => ({ method: m[1], body: text.slice(bounds[i], bounds[i + 1]) }));
}

/**
 * The `*Id` path params a handler destructures but does NOT itself guard.
 *
 * ONE predicate, used by both checks below, because they are two sides of the
 * same question: the sweep fails when this is non-empty and there is no
 * exemption, and an exemption is stale exactly when this is empty.
 *
 * `isValidUUID(<that id>)` and not merely `isValidUUID(` — a handler can
 * legitimately validate a uuid from the BODY (`chat/read` checks `messageId`)
 * while taking the path param's guard from a helper, and a bare-substring test
 * reads that as a direct guard on the path param when it is nothing of the kind.
 */
function unguardedPathIds(segment: string): string[] {
  const destructure = segment.match(/const \{([^}]*)\}\s*=\s*await params;/);
  if (!destructure) return [];
  return destructure[1]
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.endsWith('Id'))
    .filter((id) => !segment.includes(`isValidUUID(${id})`));
}

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

const uuidRouteFiles = walkRouteFiles(API_ROOT).filter((f) =>
  UUID_SEGMENTS.some((seg) => f.includes(seg)),
);

describe('UUID path-param guard sweep', () => {
  it('found a realistic number of uuid-segment route files (sweep is actually scanning the tree)', () => {
    expect(uuidRouteFiles.length).toBeGreaterThanOrEqual(30);
  });

  it.each(uuidRouteFiles.map((f) => [f.replace(process.cwd() + '/', ''), f] as const))(
    '%s: every handler that destructures a uuid-shaped param guards it',
    (relPath, absPath) => {
      const text = readFileSync(absPath, 'utf8');
      const segments = handlerSegments(text);
      if (segments.length === 0) return; // no handlers at all (shouldn't happen for a route.ts)

      const isKnownIndirect = relPath in KNOWN_INDIRECT_GUARDS;
      for (const { method, body: segment } of segments) {
        for (const id of unguardedPathIds(segment)) {
          if (!isKnownIndirect) {
            expect.fail(
              `${relPath} ${method} destructures \`${id}\` but has no isValidUUID guard and is not in KNOWN_INDIRECT_GUARDS`,
            );
          }
        }
      }
    },
  );

  it('every file with a direct guard imports isValidUUID from @/lib/uuid', () => {
    const missing: string[] = [];
    for (const f of uuidRouteFiles) {
      const rel = f.replace(process.cwd() + '/', '');
      const text = readFileSync(f, 'utf8');
      if (text.includes('isValidUUID(') && !text.includes("from '@/lib/uuid'")) {
        missing.push(rel);
      }
    }
    expect(missing).toEqual([]);
  });

  it('KNOWN_INDIRECT_GUARDS entries genuinely have no direct in-handler guard (still true, not stale)', () => {
    /*
     * "Indirect" means the handler does not run the check ITSELF, not that the
     * file never names it. Two shapes qualify and both are real here: the guard
     * lives in another module (`push/route.ts` -> `lib/pushPrefs.isUuid`), or it
     * lives in a route-local helper that every handler delegates to
     * (`chat/read/route.ts` -> `gate()`). Asserting on the whole file text
     * would refuse the second shape and push routes toward duplicating an
     * authorization check across handlers — which is exactly the arrangement
     * that gets tightened on one side and not the other.
     *
     * What the check still catches, which is the point: an entry becomes stale
     * the moment a handler grows its own `isValidUUID(...)` and the exemption is
     * left behind.
     */
    for (const rel of Object.keys(KNOWN_INDIRECT_GUARDS)) {
      const text = readFileSync(join(process.cwd(), rel), 'utf8');
      const segments = handlerSegments(text);
      const destructuring = segments.filter((seg) => /const \{[^}]*\}\s*=\s*await params;/.test(seg.body));
      expect(
        destructuring.length,
        `${rel} no longer destructures a path param in any handler — the entry describes nothing`,
      ).toBeGreaterThan(0);
      for (const { method, body } of destructuring) {
        expect(
          unguardedPathIds(body).length,
          `${rel} ${method} now guards its path param directly — remove its KNOWN_INDIRECT_GUARDS entry`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
