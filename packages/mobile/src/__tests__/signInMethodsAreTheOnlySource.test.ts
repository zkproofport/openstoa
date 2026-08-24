/**
 * The guard that makes the sign-in consolidation hold.
 *
 * `welcomeMdlButton.test.tsx` proves the two surfaces we have today do not
 * offer Mobile ID. That is necessary and not sufficient: the defect it covers
 * was never "SignInSheet renders the wrong button". It was that a THIRD place
 * existed at all — the button list was duplicated per surface, so hiding mDL on
 * `WelcomeScreen` left the sheet showing it, and a tester found it in staging.
 * A rendering test can only ever cover the surfaces someone remembered to add
 * to it, which is the same failure one level up.
 *
 * So this file asserts the SHAPE instead: the label for a sign-in method may be
 * named in exactly one module, and every surface must reach it through
 * `offeredSignInMethods()`. Add a fourth screen that hardcodes "Sign in with
 * Mobile ID" and this goes red without anyone having to remember this file
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

/** Strip line and block comments — prose about mDL is fine, rendering it is not. */
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
    const literals = ['Sign in with Mobile ID', 'Sign in with Google'];
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

  it('CONTRACT: Mobile ID is not offered, with or without Developer Mode', () => {
    // `enabled` must outrank `developerOnly` — that ordering IS the fix. If a
    // later change makes Developer Mode able to reach a disabled method again,
    // the beta ships an mDL button to anyone who flips the toggle.
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

  it('CONTRACT: restoring mDL is one flag, and it lands behind Developer Mode', () => {
    // Merged from a parallel lane's `mdlSingleSource.test.tsx`, which is
    // deleted in favour of this file. Worth keeping because it pins the
    // RESTORE path, not just the hidden state: whoever turns mDL back on must
    // get Developer Mode gating with it, which is the only gate it ever had.
    //
    // It calls the real `methodIsOffered` rather than restating the rule. That
    // is load-bearing — a re-derived copy of the condition can drift into
    // something unfalsifiable and still pass with the real body deleted.
    const mdl = SIGN_IN_METHODS.find((m) => m.id === 'mdl');
    expect(mdl).toBeDefined();
    expect(mdl!.enabled).toBe(false);

    const restored = { ...mdl!, enabled: true };
    expect(methodIsOffered(restored, { developerMode: true })).toBe(true);
    expect(methodIsOffered(restored, { developerMode: false })).toBe(false);

    // The copy above must not have leaked into the frozen shared array.
    expect(offeredSignInMethods({ developerMode: true }).map((m) => m.id)).not.toContain('mdl');
  });
});
