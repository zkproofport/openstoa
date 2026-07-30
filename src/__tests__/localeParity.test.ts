/**
 * Locale-file key parity — catches the case where a key is added to one
 * locale's JSON and forgotten in the other. `translate()` itself degrades
 * gracefully when this happens (falls back to en, then to the raw key —
 * see i18n.test.ts), so this test's job isn't to prevent a crash, it's to
 * flag drift loudly at CI time instead of silently shipping an English
 * string on the Korean surface (or vice versa).
 */
import { describe, it, expect } from 'vitest';
import en from '@/lib/i18n/locales/en.json';
import ko from '@/lib/i18n/locales/ko.json';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectKeyPaths(node: any, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix];
  return Object.keys(node).flatMap((k) => collectKeyPaths(node[k], prefix ? `${prefix}.${k}` : k));
}

describe('en.json / ko.json key parity', () => {
  const enKeys = new Set(collectKeyPaths(en));
  const koKeys = new Set(collectKeyPaths(ko));

  it('every en key exists in ko (no untranslated-into-Korean gap)', () => {
    const missingInKo = [...enKeys].filter((k) => !koKeys.has(k));
    expect(missingInKo).toEqual([]);
  });

  it('every ko key exists in en (no Korean-only orphan key)', () => {
    const missingInEn = [...koKeys].filter((k) => !enKeys.has(k));
    expect(missingInEn).toEqual([]);
  });

  it('neither dictionary is empty (a parity check over two empty sets is meaningless)', () => {
    expect(enKeys.size).toBeGreaterThan(0);
    expect(koKeys.size).toBeGreaterThan(0);
  });

  it('no leaf value is an empty or whitespace-only string in either locale', () => {
    for (const [name, keys, dict] of [
      ['en', enKeys, en] as const,
      ['ko', koKeys, ko] as const,
    ]) {
      for (const key of keys) {
        const value = key.split('.').reduce<unknown>(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (node, seg) => (node as any)?.[seg],
          dict,
        );
        expect(typeof value === 'string' && value.trim().length > 0, `${name}.${key}`).toBe(true);
      }
    }
  });
});
