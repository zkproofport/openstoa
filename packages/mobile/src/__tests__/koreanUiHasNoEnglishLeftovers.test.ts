/**
 * THE KOREAN UI WAS PART ENGLISH ON A PHONE, IN THREE DIFFERENT PLACES.
 *
 * On R59T600DXYZ on 2026-08-27, with the language set to 한국어:
 *   - the profile settings read `Push notification settings`, and the whole
 *     chat-recovery screen — the one a person reaches when they are about to
 *     lose their history — was English end to end;
 *   - after the bodies were fixed, the bar ABOVE the recovery screen still
 *     said `Chat recovery` while the heading under it said `채팅 복구`;
 *   - tapping the paperclip opened a dialog reading `Attach image`,
 *     `PHOTO LIBRARY`, `PASTE FROM CLIPBOARD`, `CANCEL`.
 *
 * It was never a missing translation. Both dictionaries had exactly the same
 * keys and neither was missing one from the other; the sentences simply never
 * went through the dictionary. Counting keys would have reported everything
 * fine, which is why this file checks the code instead.
 *
 * ── The thing that keeps going wrong ──────────────────────────────────────
 *
 * Each round found a new PLACE user-visible words live, not a new mistake. So
 * this file is written as a LIST OF PLACES. When a fourth turns up — a toast,
 * a share sheet, a notification body — add the place here; do not fix the one
 * string and move on, because the next one is already waiting somewhere else.
 *
 * ── Two properties this file has to keep ──────────────────────────────────
 *
 * PROSE CANNOT SATISFY IT. Every pattern is anchored on a position that only
 * code occupies — inside a `<Text>` element, an alert's first argument, an
 * `accessibilityLabel`. An English sentence in a comment matches none of them,
 * which was checked by putting one there.
 *
 * IT READS WHOLE FILES, NOT LINES. The iOS attach sheet writes
 *
 *     options: [
 *       'Cancel',
 *
 * so the opening bracket and the string it opens never share a line. A
 * line-at-a-time scan called that clean while the sheet was English.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import en from '../i18n/locales/en.json';
import ko from '../i18n/locales/ko.json';

const SRC = path.join(__dirname, '..');

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(p);
    return /\.tsx?$/.test(p) ? [p] : [];
  });
}

/** Every file a person's eyes or a screen reader can reach. */
const UI_FILES = ['screens', 'components', 'navigation', 'hooks'].flatMap((d) =>
  walk(path.join(SRC, d)),
);

/**
 * The places words reach a person, each anchored so nothing else can match.
 *
 * Route names (`navigate('ChatRoom')`), request headers (`'Content-Type'`) and
 * HTTP methods (`'DELETE'`) are English on purpose and occupy none of these.
 */
const PLACES: ReadonlyArray<{ where: string; pattern: RegExp; group?: number }> = [
  { where: '화면 본문', pattern: /<Text[^>]*>\s*\{?'?([A-Z][A-Za-z0-9 ,.'&()/:?!×-]{3,}?)'?\}?\s*<\/Text>/g },
  { where: '화면 제목', pattern: /\btitle:\s*'([A-Z][^']{3,})'/g },
  { where: '대화상자 제목', pattern: /Alert\.alert\(\s*'([A-Za-z][^']{3,})'/g },
  { where: '대화상자 버튼', pattern: /\btext:\s*'([A-Za-z][^']{3,})'/g },
  { where: '선택지 목록', pattern: /\boptions:\s*\[\s*'([A-Za-z][^']{3,})'/g },
  { where: '낭독기 이름', pattern: /accessibilityLabel=["{]'?([A-Z][A-Za-z0-9 ,.'-]{3,}?)['}"]/g },
  { where: '입력창 안내', pattern: /placeholder=["{]'?([A-Z][A-Za-z0-9 ,.'?-]{3,}?)['}"]/g },
  /*
   * The fourth place, found in the HOST app after the first three were fixed
   * here: a button whose words ride in on a `label` prop rather than sitting
   * between `<Text>` tags. The mini-app has none today — the place is listed
   * so that stays true, which is the whole point of keeping a list of places.
   *
   * Both quote styles. Writing it for one is how `label="Clear"` survived a
   * sweep that caught `label={'Connect'}` on the line above it.
   */
  {
    where: '버튼 속성',
    pattern:
      /\b(?:label|buttonText|emptyText|heading|subtitle|caption|actionLabel|confirmText|cancelText)=(?:\{\s*)?(['"])([A-Z][^'"]{2,})\1/g,
    group: 2,
  },
];

/**
 * English that is RIGHT where it stands, each named rather than pattern-waved.
 *
 * A blanket "short strings are fine" rule would also excuse a genuinely
 * untranslated button, so every exemption earns its own line.
 */
const ENGLISH_ON_PURPOSE = new Set([
  'OpenStoa', // the product's name, on the boot screen — translating it is the defect
  'US, KR, JP', // an example of ISO country codes — the same in every language
]);

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

describe('the Korean UI does not fall back to English', () => {
  it('no place puts English in front of a Korean reader', () => {
    const offenders: string[] = [];
    for (const file of UI_FILES) {
      const text = fs.readFileSync(file, 'utf8');
      for (const { where, pattern, group } of PLACES) {
        pattern.lastIndex = 0;
        for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
          const word = m[group ?? 1].trim();
          if (ENGLISH_ON_PURPOSE.has(word)) continue;
          offenders.push(`${where} · ${path.relative(SRC, file)}:${lineOf(text, m.index)}  ${word}`);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('every Korean entry is actually Korean, not the English copied across', () => {
    const flat = (o: Record<string, unknown>, p = ''): Record<string, string> =>
      Object.entries(o).reduce<Record<string, string>>((acc, [k, v]) => {
        const key = p ? `${p}.${k}` : k;
        if (v && typeof v === 'object') Object.assign(acc, flat(v as Record<string, unknown>, key));
        else acc[key] = String(v);
        return acc;
      }, {});

    const e = flat(en as Record<string, unknown>);
    const k = flat(ko as Record<string, unknown>);

    // Same shape, or one language silently lost a screen.
    expect(Object.keys(k).sort()).toEqual(Object.keys(e).sort());

    const SAME_IN_BOTH_ON_PURPOSE = new Set([
      'openstoa.tabs.zkproofport', // the official product name — translating it is the defect
      'openstoa.members.actionsForMember', // renders only {{nickname}} — no words of its own
      'openstoa.topicCreate.proofTypes.kyc', // "KYC (Coinbase)" — Coinbase's product name
      'openstoa.topicCreate.proofTypes.googleWorkspace', // Google's product name
      'openstoa.topicCreate.proofTypes.microsoft365', // Microsoft's product name
    ]);

    // Below four letters there is no English sentence to speak of — "OK", "ZK",
    // "DM", a number, an arrow. A real untranslated sentence always exceeds it.
    const tooShortToBeASentence = (s: string) => !/[A-Za-z]{4}/.test(s);

    const englishInKorean = Object.keys(k).filter(
      (key) =>
        k[key] === e[key] && !SAME_IN_BOTH_ON_PURPOSE.has(key) && !tooShortToBeASentence(k[key]),
    );
    expect(englishInKorean).toEqual([]);
  });

  it('the file list is not empty — an empty sweep would pass silently', () => {
    // The scan above reports nothing when it reads nothing, and a broken path
    // looks exactly like a clean codebase.
    expect(UI_FILES.length).toBeGreaterThan(40);
  });
});
