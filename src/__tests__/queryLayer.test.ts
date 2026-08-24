/**
 * The web and the mini-app use ONE data layer, and one set of keys.
 *
 * WHAT THIS EXISTS TO STOP. The mini-app has read through TanStack Query since
 * it was written. The web had no query layer at all, and grew what a query
 * layer prevents: seventeen call sites fetching `/api/auth/session`
 * independently, three separate caches for that one value, and two components
 * fetching the same topic side by side on every topic page. The first attempt
 * at a fix made it worse — two bespoke modules that re-implemented, badly, what
 * the sibling package already had, written without checking what the repo had
 * standardised on.
 *
 * So these are the assertions that keep that from happening again: the library
 * is present and at one version, the keys come from the shared package rather
 * than being spelled out per caller, and nothing reaches around the layer to
 * fetch the session directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === '.next') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe('ONE library, ONE version', () => {
  it('both packages declare @tanstack/react-query, at the same range', () => {
    const web = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const mobile = JSON.parse(readFileSync(join(ROOT, 'packages/mobile/package.json'), 'utf8'));
    const a = web.dependencies?.['@tanstack/react-query'];
    const b = mobile.dependencies?.['@tanstack/react-query'];
    expect(a, 'the web dropped the query layer').toBeDefined();
    expect(b, 'the mini-app dropped the query layer').toBeDefined();
    expect(
      a,
      `ranges drifted apart (web ${a}, mini-app ${b}) — the point is one idiom, not one library each`,
    ).toBe(b);
  });

  it('the web mounts a provider at the root', () => {
    const layout = readFileSync(join(ROOT, 'src/app/layout.tsx'), 'utf8');
    expect(layout).toContain('QueryProvider');
  });
});

describe('ONE set of keys', () => {
  it('the shared package is where they live', () => {
    const keys = readFileSync(join(ROOT, 'packages/api-types/src/queryKeys.ts'), 'utf8');
    for (const name of ['topicKeys', 'sessionKeys', 'listKeys', 'postKeys']) {
      expect(keys, `${name} is missing from the shared keys`).toContain(`export const ${name}`);
    }
    const index = readFileSync(join(ROOT, 'packages/api-types/src/index.ts'), 'utf8');
    expect(index, 'the keys are not exported from the package').toContain("export * from './queryKeys'");
  });

  it("no caller spells out a key the shared module already names", () => {
    /*
     * `['topic', id]` written by hand is the failure this prevents: it looks
     * right, it works, and it silently misses every invalidation written
     * against the shared key.
     */
    const offenders: string[] = [];
    const bare = /queryKey:\s*\[\s*['"`](topic|session|categories|post|bookmark|chat-history)['"`]/;
    for (const dir of ['src', 'packages/mobile/src']) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = file.slice(ROOT.length + 1);
        const src = readFileSync(file, 'utf8');
        if (bare.test(src)) offenders.push(rel);
      }
    }
    expect(
      offenders,
      `these hand-write a shared key; import it from @openstoa/api-types:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('NOTHING reaches around the layer', () => {
  it('client code reads the session through useSession, never a bare fetch', () => {
    /*
     * One exception, and it is a constraint rather than a shortcut:
     * `mls/webTransport` builds the MLS store lazily outside React, so there is
     * no provider to reach and no hook to call. The mini-app's crypto layer has
     * the same shape for the same reason.
     */
    const ALLOWED = ['lib/mls/webTransport.ts', 'lib/useSession.ts', 'middleware.ts'];
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, 'src'))) {
      const rel = file.slice(ROOT.length + 5);
      if (rel.startsWith('app/api/') || ALLOWED.includes(rel)) continue;
      const src = readFileSync(file, 'utf8');
      if (/(apiFetch|fetch)\(\s*['"`]\/api\/auth\/session/.test(src)) offenders.push(rel);
    }
    expect(
      offenders,
      `these fetch the session directly; use useSession() from @/lib/useSession:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the interim hand-rolled caches are gone', () => {
    // They were replaced by the library, and leaving one behind means two
    // answers to the same question again.
    for (const gone of ['src/lib/sessionCache.ts', 'src/lib/requestCache.ts']) {
      let exists = true;
      try {
        statSync(join(ROOT, gone));
      } catch {
        exists = false;
      }
      expect(exists, `${gone} came back`).toBe(false);
    }
  });
});
