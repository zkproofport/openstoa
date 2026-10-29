/**
 * The guard that makes the sign-in consolidation hold.
 *
 * `signInSurfaces.test.tsx` proves the two surfaces we have today render the
 * offered list. That is necessary and not sufficient: the defect it covers
 * was never "SignInSheet renders the wrong button". It was that a THIRD place
 * existed at all — the button list was duplicated per surface, so hiding a
 * method on `WelcomeScreen` left the sheet showing it, and a tester found it in
 * staging.
 * A rendering test can only ever cover the surfaces someone remembered to add
 * to it, which is the same failure one level up.
 *
 * So this file asserts the SHAPE instead: the label for a sign-in method may be
 * named in exactly one module, and every surface must reach it through
 * `offeredSignInMethods()`. Add a fourth screen that hardcodes "Sign in with
 * Google" and this goes red without anyone having to remember this file
 * exists.
 *
 * Kept as a source sweep, deliberately. The equivalent render-time check cannot
 * see a screen nobody imported into the test.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SIGN_IN_METHODS, methodIsOffered, offeredSignInMethods } from '../auth/signInMethods';

const SRC = join(__dirname, '..');

/** The one module allowed to name a sign-in method's label key. */
const SOURCE_OF_TRUTH = 'auth/signInMethods.ts';

/** Where the labels themselves live — data, not a rendering decision. */
const LOCALES = 'i18n/locales';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // __tests__ is excluded: a test naturally names the strings it asserts
      // on, and including it would make this file fail on itself.
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
      continue;
    }
    if (/\.(ts|tsx|json)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Strip line and block comments — prose about a method is fine, rendering it is not. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('sign-in methods have exactly one source', () => {
  it('CONTRACT: no file outside signInMethods.ts names a method label key', () => {
    const keys = SIGN_IN_METHODS.map((m) => m.labelKey);
    expect(keys.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (rel === SOURCE_OF_TRUTH || rel.startsWith(LOCALES)) continue;
      const body = stripComments(readFileSync(file, 'utf8'));
      for (const key of keys) {
        if (body.includes(key)) offenders.push(`${rel} names ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('CONTRACT: no file hardcodes a sign-in button label in English', () => {
    // The literal a new surface is most likely to paste in. i18n files hold the
    // translations legitimately; everywhere else this is a duplicated list
    // reappearing.
    const literals = ['Sign in with Google'];
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (rel.startsWith(LOCALES)) continue;
      const body = stripComments(readFileSync(file, 'utf8'));
      for (const literal of literals) {
        if (body.includes(literal)) offenders.push(`${rel} hardcodes "${literal}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('CONTRACT: only OIDC is declared; Mobile ID is gone, not hidden', () => {
    expect(SIGN_IN_METHODS.map((m) => m.id)).toEqual(['oidc']);
    for (const developerMode of [false, true]) {
      const ids = offeredSignInMethods({ developerMode }).map((m) => m.id);
      expect(ids, `developerMode=${developerMode}`).not.toContain('mdl');
    }
  });

  it('INTEGRITY: Google is still offered in both modes', () => {
    // Guards the fix from over-correcting into "nothing is offered".
    for (const developerMode of [false, true]) {
      const ids = offeredSignInMethods({ developerMode }).map((m) => m.id);
      expect(ids, `developerMode=${developerMode}`).toContain('oidc');
    }
  });

  it('INTEGRITY: every declared method has a label key that resolves', () => {
    const en = JSON.parse(
      readFileSync(join(SRC, 'i18n/locales/en.json'), 'utf8'),
    ) as Record<string, unknown>;
    const resolve = (key: string): unknown =>
      key.split('.').reduce<unknown>((node, part) => {
        if (node && typeof node === 'object' && part in node) {
          return (node as Record<string, unknown>)[part];
        }
        return undefined;
      }, en);

    for (const method of SIGN_IN_METHODS) {
      expect(resolve(method.labelKey), method.labelKey).toBeTypeOf('string');
    }
  });

  it('CONTRACT: a developer-only method lands behind Developer Mode', () => {
    // Calls the real `methodIsOffered` rather than restating the rule: a
    // re-derived copy can drift into something unfalsifiable and still pass.
    const devOnly = { ...SIGN_IN_METHODS[0], developerOnly: true };
    expect(methodIsOffered(devOnly, { developerMode: true })).toBe(true);
    expect(methodIsOffered(devOnly, { developerMode: false })).toBe(false);
    const disabled = { ...SIGN_IN_METHODS[0], enabled: false };
    expect(methodIsOffered(disabled, { developerMode: true })).toBe(false);

    // The copies above must not have leaked into the frozen shared array.
    expect(offeredSignInMethods({ developerMode: false }).map((m) => m.id)).toEqual(['oidc']);
  });
});
