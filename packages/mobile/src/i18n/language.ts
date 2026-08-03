/**
 * Language selection for the mini-app.
 *
 * The host owns the initial language (`HostApi.getLanguage()` /
 * `onLanguageChange`) — the mini-app never reads the OS locale directly,
 * exactly the way `ThemeContext` never reads the OS colour scheme. What the
 * host does NOT provide is a setter, so an in-app switcher has to do two
 * things: change the shared i18next instance (which is what actually
 * re-renders both host and mini-app copy) and remember the choice locally so
 * it survives the next mount.
 *
 * That local memory is an OVERRIDE: once the user has picked a language
 * inside OpenStoa, host-emitted language changes stop being followed. Without
 * that rule the host would silently stomp the user's choice on the next
 * `onLanguageChange` emission and the switcher would look broken.
 *
 * Everything here is pure/injectable so it can be tested without a renderer.
 */

export const SUPPORTED_LANGUAGES = ['en', 'ko'] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Fallback when neither an override nor a usable host value exists. */
export const DEFAULT_LANGUAGE: Language = 'en';

/**
 * Endonyms — each option is written in its OWN language. A user who has the
 * app stuck in a language they can't read still has to be able to find their
 * way out, which they cannot do if the list says "Korean" in Korean.
 */
export const LANGUAGE_LABELS: Record<Language, string> = {
  en: 'English',
  ko: '한국어',
};

/** Key in `HostApi.localStore`. Namespaced so it can't collide with host keys. */
export const LANGUAGE_STORAGE_KEY = 'openstoa.language';

/** Longest input `normalizeLanguage` will even look at. A BCP-47 tag that
 *  matters here is at most a handful of chars; anything longer is junk (or a
 *  hostile payload) and is rejected before any string work happens. */
const MAX_TAG_LENGTH = 64;

/**
 * Coerces an arbitrary value to a supported language, or null.
 *
 * Accepts the exact codes plus the common region-tagged forms the host or a
 * persisted value can carry (`ko-KR`, `en_US`, `EN`, padded whitespace).
 * Everything else — including `null`, `undefined`, non-strings, empty and
 * whitespace-only strings, and unsupported languages like `ja` — is null so
 * the caller falls back explicitly rather than half-applying a bad value.
 */
export function normalizeLanguage(raw: unknown): Language | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > MAX_TAG_LENGTH) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Take the primary subtag: `ko-KR` / `ko_KR` / `ko-Hang-KR` → `ko`.
  const primary = trimmed.split(/[-_]/, 1)[0].toLowerCase();
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(primary)
    ? (primary as Language)
    : null;
}

/**
 * Which language the mini-app should be showing.
 *
 * Precedence: the user's stored override, then whatever the host reports,
 * then `DEFAULT_LANGUAGE`. Each input is normalized independently so a
 * corrupt override falls through to the host instead of poisoning the result.
 */
export function resolveLanguage(stored: unknown, hostLanguage: unknown): Language {
  return normalizeLanguage(stored) ?? normalizeLanguage(hostLanguage) ?? DEFAULT_LANGUAGE;
}

/** Minimal slice of `HostApi.localStore` this module needs. */
export interface LanguageStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/**
 * Reads the stored override. A missing store, a rejected read, or a corrupt
 * value all resolve to null — a language preference is never worth
 * propagating a storage failure into a screen.
 */
export async function readStoredLanguage(
  store: LanguageStore | undefined,
): Promise<Language | null> {
  if (!store) return null;
  try {
    return normalizeLanguage(await store.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * Persists the override. Returns whether it stuck, so a caller can decide
 * whether the choice will survive a remount — but a false NEVER aborts the
 * in-session language change, which has already been applied by then.
 */
export async function writeStoredLanguage(
  store: LanguageStore | undefined,
  language: Language,
): Promise<boolean> {
  if (!store) return false;
  try {
    await store.setItem(LANGUAGE_STORAGE_KEY, language);
    return true;
  } catch {
    return false;
  }
}
