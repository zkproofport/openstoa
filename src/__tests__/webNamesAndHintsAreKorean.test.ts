/**
 * THE WEB'S ICON-ONLY BUTTONS HAD ENGLISH NAMES.
 *
 * Same defect as the two apps, third surface: a button with no visible words
 * gives a screen reader nothing but its `aria-label`, and those read `Close`,
 * `Previous image`, `Next image`, `Add reaction`, `Upvote`, `Downvote` on a
 * Korean page. Nobody browsing with their eyes would ever see it.
 *
 * Form hints and tooltips are here for the same reason — a placeholder is the
 * only instruction an empty field has.
 *
 * ── BODY TEXT IS NOW COVERED TOO, with one exemption ─────────────────────
 *
 * The note that used to sit here said the site's ordinary body text held about
 * thirty English strings and left them for later. Swept on 2026-08-28 with the
 * three shapes the mini-app's own guard had to learn one at a time, the real
 * count was 26 — and 16 of those are the DEVELOPER DOCS page, which is written
 * for people integrating against the API and is English on purpose. The four
 * that a reader could actually hit (a post's sign-in prompts, its Cancel, its
 * comment-box label) are fixed; brand names are exempt by name below.
 *
 * The docs page is exempt by PATH, not by pattern, so a new English sentence
 * anywhere else still fails.
 *
 * ── Prose cannot satisfy this ────────────────────────────────────────────
 *
 * Every pattern is anchored on an attribute only code writes. The English in
 * this comment matches none of them, which was checked by running it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import en from '../lib/i18n/locales/en.json';
import ko from '../lib/i18n/locales/ko.json';

const SRC = path.join(__dirname, '..');

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
    return p.endsWith('.tsx') ? [p] : [];
  });
}

const FILES = [...walk(path.join(SRC, 'app')), ...walk(path.join(SRC, 'components'))];

/** Where a name or a hint reaches a person. Add a place; don't fix one string. */
const PLACES: ReadonlyArray<{ where: string; pattern: RegExp }> = [
  { where: '낭독기 이름', pattern: /aria-label=(?:"([^"]{2,})"|\{'([^']{2,})'\})/g },
  { where: '툴팁', pattern: /\stitle=(?:"([^"]{2,})"|\{'([^']{2,})'\})/g },
  { where: '입력창 안내', pattern: /placeholder=(?:"([^"]{2,})"|\{'([^']{2,})'\})/g },
];

/*
 * ONLY A PLAIN LITERAL COUNTS. The first shape of this pattern accepted
 * anything after the `=`, so `aria-label={showMembers ? t('a') : t('b')}` —
 * already translated, three ways over — came back as the English string
 * `showMembers ? t(`. Eight of those drowned the two real findings.
 *
 * A value in braces is an expression, and an expression is where `t(...)`
 * lives. The exception is a brace wrapping one quoted string, which is a
 * literal wearing a hat.
 */

/** English that is right where it stands, each named rather than pattern-waved. */
const ENGLISH_ON_PURPOSE = new Set([
  // The word a person must TYPE to confirm deleting their account. Translating
  // it would mean the typed word no longer matches what the check compares —
  // the page already says so in a comment beside it.
  'DELETE',
  'OpenStoa', // the product's name, used as an image's alternative text
  'you@example.com', // an example address in an email field — not a sentence
]);

/** A dictionary key or a web address, not a sentence a person reads. */
function notASentence(s: string): boolean {
  return /^[a-z][\w]*(\.[\w]+)+$/.test(s) || /^(www\.|https?:\/\/)/.test(s);
}

describe('the web names its controls in Korean', () => {
  /*
   * Body text, as three shapes rather than one — each learned from a defect the
   * previous shape could not see, on the mini-app, on 2026-08-27:
   *   a whole English sentence between tags;
   *   a sentence GLUED from expressions and bare words, which no whole-string
   *     rule can match;
   *   a call to the translator carrying an English `defaultValue` for a key the
   *     Korean file never had, where the English is in the one place it is
   *     supposed to be and the fallback is what a person reads.
   */
  it('no screen puts an English sentence in front of a Korean reader', () => {
    const BRAND = new Set([
      'ERC-8004', // a standard's number
      'Masse Labs', // the company
      'OpenStoa AI', // the product
      'Ask OpenStoa AI', // the product, as a control
      'ZKProofport',
      'OpenStoa',
    ]);
    /** English on purpose: written for developers integrating against the API. */
    const ENGLISH_ON_PURPOSE_PATH = 'app/docs/';

    const WHOLE = /<(?:p|h1|h2|h3|h4|span|button|label|li|td|th)\b[^>]*>\s*([A-Z][A-Za-z0-9 ,.'&()/:?!-]{4,}?)\s*<\//g;
    const CALL = /\bt\(\s*'([^']+)'\s*,\s*\{[^}]*defaultValue:\s*'([^']*)'/g;

    const hasKoKey = (dotted: string): boolean => {
      let cur: unknown = ko;
      for (const part of dotted.split('.')) {
        if (typeof cur !== 'object' || cur === null) return false;
        cur = (cur as Record<string, unknown>)[part];
      }
      return typeof cur === 'string' && cur.length > 0;
    };

    const found: string[] = [];
    for (const file of FILES) {
      const rel = path.relative(SRC, file);
      if (rel.startsWith(ENGLISH_ON_PURPOSE_PATH)) continue;
      const text = fs.readFileSync(file, 'utf8');

      for (const m of text.matchAll(WHOLE)) {
        const word = m[1].replace(/\s+/g, ' ').trim();
        if (BRAND.has(word)) continue;
        found.push(`화면 본문 · ${rel}:${text.slice(0, m.index).split('\n').length}  "${word}"`);
      }
      for (const m of text.matchAll(CALL)) {
        if (hasKoKey(m[1])) continue;
        found.push(`빠진 번역 · ${rel}:${text.slice(0, m.index).split('\n').length}  ${m[1]} → "${m[2]}"`);
      }
    }

    expect(found).toEqual([]);
  });

  it('the sweep is not empty — a broken path looks exactly like a clean site', () => {
    expect(FILES.length).toBeGreaterThan(40);
  });

  it('no control name, tooltip or field hint is left in English', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = fs.readFileSync(file, 'utf8');
      for (const { where, pattern } of PLACES) {
        pattern.lastIndex = 0;
        for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
          const word = (m[1] ?? m[2] ?? '').replace(/\s+/g, ' ').trim();
          if (!/[A-Za-z]{3}/.test(word) || /[가-힣]/.test(word)) continue;
          if (notASentence(word) || ENGLISH_ON_PURPOSE.has(word)) continue;
          offenders.push(
            `${where} · ${path.relative(SRC, file)}:${text.slice(0, m.index).split('\n').length}  ${word}`,
          );
        }
      }
    }
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  it('both dictionaries hold the same keys, or one locale lost a screen', () => {
    const flat = (o: Record<string, unknown>, p = ''): Record<string, string> =>
      Object.entries(o).reduce<Record<string, string>>((acc, [k, v]) => {
        const key = p ? `${p}.${k}` : k;
        if (v && typeof v === 'object') Object.assign(acc, flat(v as Record<string, unknown>, key));
        else acc[key] = String(v);
        return acc;
      }, {});
    const e = flat(en as Record<string, unknown>);
    const k = flat(ko as Record<string, unknown>);
    expect(Object.keys(k).sort()).toEqual(Object.keys(e).sort());
  });

  it('every name and hint added here is actually Korean', () => {
    /*
     * Checked on the entries this file is responsible for rather than the
     * whole catalogue — the rest of the web dictionary is a separate job and
     * a guard that fails on day one gets skipped.
     */
    /*
     * Narrowed to the one section this file owns, not the whole catalogue.
     * The dictionary nests deeper than two levels — `profilePage.validation`
     * is an object — so claiming every section is flat is simply false, and
     * the compiler said so.
     */
    const names = (ko as unknown as { a11y: Record<string, string> }).a11y;
    const english = Object.entries(names).filter(([, v]) => !/[가-힣]/.test(v));
    expect(english).toEqual([]);
    expect(Object.keys(names).length).toBeGreaterThan(12);
  });
});
