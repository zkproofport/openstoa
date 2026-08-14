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
      const funcMatches = [...text.matchAll(/export async function (GET|POST|PATCH|DELETE|PUT)\s*\(/g)];
      if (funcMatches.length === 0) return; // no handlers at all (shouldn't happen for a route.ts)

      const bounds = [...funcMatches.map((m) => m.index!), text.length];
      for (let i = 0; i < funcMatches.length; i++) {
        const segment = text.slice(bounds[i], bounds[i + 1]);
        const destructure = segment.match(/const \{([^}]*)\}\s*=\s*await params;/);
        if (!destructure) continue;
        const ids = destructure[1].split(',').map((s) => s.trim()).filter((s) => s.endsWith('Id'));
        for (const id of ids) {
          const hasDirectGuard = segment.includes(`isValidUUID(${id})`);
          const isKnownIndirect = relPath in KNOWN_INDIRECT_GUARDS;
          if (!hasDirectGuard && !isKnownIndirect) {
            expect.fail(
              `${relPath} ${funcMatches[i][1]} destructures \`${id}\` but has no isValidUUID guard and is not in KNOWN_INDIRECT_GUARDS`,
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

  it('KNOWN_INDIRECT_GUARDS entries genuinely have no direct isValidUUID call (still true, not stale)', () => {
    for (const rel of Object.keys(KNOWN_INDIRECT_GUARDS)) {
      const text = readFileSync(join(process.cwd(), rel), 'utf8');
      expect(text.includes('isValidUUID(')).toBe(false);
    }
  });
});
