/*
 * No user-facing string may hang its advice on deleting or reinstalling the app.
 *
 * WHY, in one measured fact. `expo-secure-store` — where the master_key, the MLS
 * keys and the device key all live — behaves DIFFERENTLY on the two platforms.
 * From Expo's own documentation:
 *
 *   iOS      "will persist across app uninstallations if the app is reinstalled
 *             with the same bundle ID"
 *   Android  "will not be preserved upon app uninstallation"
 *
 * So "back up before you delete the app" is true on Android and FALSE on iOS,
 * where deleting and reinstalling leaves every key exactly where it was. And the
 * reverse advice is worse: an iOS reader who is told a reinstall is safe will
 * believe it on their Android phone too.
 *
 * A person who catches one piece of advice being wrong stops believing the next
 * one — and the next one here is the sentence that decides whether they write
 * their recovery key down.
 *
 * WHAT TO SAY INSTEAD. The question is never "what did you do to the app", it is
 * "does this device still hold its keys". That is answerable — the backup state
 * comes from the server and the local keys are readable or they are not — and it
 * is the same sentence on both platforms.
 *
 * WHY A STRING SCAN. The failure is a sentence, not a branch. It cannot be
 * caught by exercising code, and it arrives when somebody writes a helpful line
 * in a locale file months from now.
 *
 * NARROWED 2026-08-26, and the narrowing is the point rather than a concession.
 * The ban was on the WORD, which also banned the one form of the sentence that
 * is true: naming the platform it is true ON. "on Android, reinstalling loses
 * the key" is a fact an Android reader needs and an iOS reader is not misled by.
 * Banning it cost real information and bought nothing.
 *
 * So the rule is now about the SENTENCE, not the file: a platform claim is an
 * offence unless the sentence making it names Android. Scoping to the sentence
 * is load-bearing — a locale that says "reinstalling loses your keys" in one
 * paragraph and mentions Android in another has still told an iPhone user
 * something false, and a file-wide search for "Android" would pass it.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract (THE guard) → no locale string bases advice on uninstalling
 *   integrity            → both locales are checked, not just English
 *   integrity            → the two locales carry the same keys, so neither can
 *                          quietly drop a warning the other has
 *   boundary             → the check reads the shipped files, not a copy
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCALES = join(HERE, '..', 'i18n', 'locales');

type Tree = { [k: string]: string | Tree };

function load(lang: string): Tree {
  return JSON.parse(readFileSync(join(LOCALES, `${lang}.json`), 'utf8')) as Tree;
}

function flatten(t: Tree, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(t)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push([path, v]);
    else out.push(...flatten(v, path));
  }
  return out;
}

/*
 * Phrases that make an OS action the reason. Deliberately narrow: "delete" and
 * "지우" appear all over an app that deletes messages and topics, and a scan that
 * cried wolf on those would be turned off within a week.
 */
const PLATFORM_CLAIMS = [
  'uninstall',
  'reinstall',
  'delete the app',
  'deleting the app',
  'remove the app',
  '앱을 지우',
  '앱을 삭제',
  '앱 삭제',
  '재설치',
  '다시 설치',
];

/**
 * The qualifier that makes a platform claim honest, in either locale.
 *
 * Only Android — naming iOS would be a claim in the wrong direction, since the
 * keys SURVIVE a reinstall there and no advice needs to be given about it.
 */
const ANDROID = ['android', '안드로이드'];

/** Split into sentences, keeping line breaks as boundaries. */
function sentences(v: string): string[] {
  return v.split(/(?<=[.!?。])\s+|\n+/).filter((x) => x.trim());
}

/**
 * Sentences that make an OS action the reason WITHOUT naming the platform it is
 * true on. Those, and only those, are the lie this file exists to stop.
 */
function unqualifiedClaims(v: string): string[] {
  return sentences(v).filter((sent) => {
    const low = sent.toLowerCase();
    if (!PLATFORM_CLAIMS.some((p) => low.includes(p))) return false;
    return !ANDROID.some((a) => low.includes(a));
  });
}

describe('backup advice does not depend on what you did to the app', () => {
  it.each(['en', 'ko'])('CONTRACT: no %s string bases advice on uninstalling', (lang) => {
    const offenders = flatten(load(lang)).flatMap(([k, v]) =>
      unqualifiedClaims(v).map((sent) => `${k}: ${sent}`),
    );

    expect(offenders).toEqual([]);
  });

  it('HOSTILE: the narrowing did not turn the guard off', () => {
    /*
     * The whole risk of scoping to the sentence is that the scope swallows the
     * rule. These are the three shapes that matter, checked directly rather than
     * inferred from the locale files passing.
     */
    // The original lie, still caught.
    expect(unqualifiedClaims('Back up before you delete the app.')).toHaveLength(1);
    expect(unqualifiedClaims('앱을 삭제하기 전에 백업하세요.')).toHaveLength(1);
    // The honest form, allowed.
    expect(unqualifiedClaims('On Android, reinstalling the app loses the key.')).toHaveLength(0);
    expect(unqualifiedClaims('안드로이드에서 앱을 다시 설치하면 키가 사라집니다.')).toHaveLength(0);
    // THE CASE THE SCOPE EXISTS FOR: the qualifier in a DIFFERENT sentence does
    // not launder the claim. A file-wide search for "Android" would pass this.
    expect(
      unqualifiedClaims('We support Android and iOS.\nReinstalling the app loses your keys.'),
    ).toHaveLength(1);
  });

  it('INTEGRITY: the two locales carry the same keys', () => {
    /*
     * A warning that exists in one language and not the other is a warning half
     * the users never see — and the half that is missing is invisible, because
     * i18n falls back to the key or to English without complaining.
     */
    const en = new Set(flatten(load('en')).map(([k]) => k));
    const ko = new Set(flatten(load('ko')).map(([k]) => k));

    expect([...en].filter((k) => !ko.has(k))).toEqual([]);
    expect([...ko].filter((k) => !en.has(k))).toEqual([]);
  });

  it('CONTRACT: the recovery copy speaks about KEYS, not about the app', () => {
    // The positive half. Absence of the wrong wording is not presence of the
    // right wording — a string could say nothing useful at all and still pass
    // the case above.
    const en = Object.fromEntries(flatten(load('en')));
    const body = en['openstoa.firstRunRecovery.bodyFirstRun'];

    expect(body).toBeTruthy();
    expect(body.toLowerCase()).toContain('key');
  });
});

/*
 * A second lie, found by a person reading the screen on 2026-08-27.
 *
 * The sheet said "It is shown once. Store it somewhere you will still have if
 * this phone is gone." / "한 번만 보여집니다." — and the very next thing the app
 * did was file a copy in the person's own space, where they then found it. The
 * user's words: "이 이후 사라진다는 건 거짓 과장 제공 같은데".
 *
 * They are right, and it is the same failure as the platform lie one paragraph
 * up: a warning caught being wrong takes the next warning down with it. Here
 * the next warning is the one that actually matters — the copy is sealed under
 * the very key it protects, so it is NOT a backup, and somebody who has learned
 * to discount this sheet will discount that too.
 *
 * SCOPED TO THE SHEET, not the whole file. `recoveryCodeNote` and
 * `sendRecoveryNote` explain in their own headers that the key "is shown once,
 * in a sheet" — which is true of the SHEET and is why the note exists. The lie
 * is only a lie when the sheet claims the code exists nowhere else while the
 * app is putting it somewhere else.
 */
const SINGLE_SHOWING = ['shown once', 'shown only once', 'only see it once', '한 번만 보여', '한 번만 표시', '다시 볼 수 없'];

describe('the recovery sheet does not claim the code vanishes', () => {
  it.each(['en', 'ko'])('CONTRACT: no %s sheet string says it is shown once', (lang) => {
    /*
     * The note is filed unconditionally — `FirstRunRecovery` calls
     * `sendRecoveryNote` as soon as a code exists — so there is no configuration
     * in which the claim would be true, and no exemption to carve out.
     */
    const offenders = flatten(load(lang))
      .filter(([k]) => k.startsWith('openstoa.firstRunRecovery.'))
      .filter(([, v]) => SINGLE_SHOWING.some((p) => v.toLowerCase().includes(p)))
      .map(([k, v]) => `${k}: ${v}`);

    expect(offenders).toEqual([]);
  });

  it('CONTRACT: the sheet says where the copy is AND that it is not a backup', () => {
    /*
     * The positive half, and the reason this is not simply a ban. Deleting the
     * false sentence and leaving nothing would be worse than the lie: the person
     * would not know a copy exists, and would not know why the copy cannot save
     * them. Both halves have to be on screen.
     */
    for (const lang of ['en', 'ko']) {
      const warn = Object.fromEntries(flatten(load(lang)))['openstoa.firstRunRecovery.warning'];
      expect(warn, `${lang} warning`).toBeTruthy();
      // Where it is.
      expect(warn.toLowerCase(), `${lang} names the space`).toMatch(/own space|나만의 공간/);
      // Why it is not enough. The instruction has to be actionable: keep one
      // somewhere this app cannot reach.
      expect(warn.toLowerCase(), `${lang} says keep one outside`).toMatch(/outside this app|앱 밖에/);
    }
  });

  it('HOSTILE: the scan catches the sentence it was written for', () => {
    // The exact string that shipped, in both languages. Without this, a typo in
    // the pattern list would leave the guard permanently green and useless.
    const shipped = ['It is shown once. Store it somewhere you will still have if this phone is gone.', '한 번만 보여집니다. 이 휴대폰이 없어져도 남아 있을 곳에 보관하세요.'];
    for (const sent of shipped) {
      expect(SINGLE_SHOWING.some((p) => sent.toLowerCase().includes(p)), sent).toBe(true);
    }
  });
});
