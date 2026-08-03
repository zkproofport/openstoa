import { useCallback, useEffect, useRef, useState } from 'react';
import i18n from 'i18next';
import { useHost } from '@openstoa/miniapp-bridge';
import {
  readStoredLanguage,
  resolveLanguage,
  writeStoredLanguage,
  type Language,
} from './language';

/**
 * The mini-app's language, plus the setter the in-app switcher calls.
 *
 * `HostApi` exposes `getLanguage()` / `onLanguageChange()` but no setter, so
 * changing the language means changing the shared i18next instance the host
 * already initialised — that is what re-renders copy — and persisting the
 * choice through `HostApi.localStore` so it survives the next mount.
 *
 * Once the user has picked inside OpenStoa that choice is an override: later
 * host emissions are ignored, otherwise the host would stomp the selection on
 * its next `onLanguageChange` and the switcher would read as broken. See
 * `./language.ts` for the precedence rules.
 */
export function useLanguage(): {
  language: Language;
  setLanguage: (next: Language) => void;
} {
  const host = useHost();
  // Ref, not state: the host subscription below must read the latest value
  // without re-subscribing (which would drop and re-attach the listener).
  const overrideRef = useRef<Language | null>(null);
  const [language, setLanguageState] = useState<Language>(() =>
    resolveLanguage(null, host.getLanguage()),
  );

  const setLanguage = useCallback(
    (next: Language) => {
      overrideRef.current = next;
      setLanguageState(next);
      // Applied optimistically. A rejected changeLanguage (missing bundle) or
      // a failed write costs persistence at worst — it must never leave the
      // row visually unselected after the user tapped it.
      void i18n.changeLanguage(next).catch(() => undefined);
      void writeStoredLanguage(host.localStore, next);
    },
    [host],
  );

  // Hydrate a previously stored override.
  useEffect(() => {
    let cancelled = false;
    void readStoredLanguage(host.localStore).then((stored) => {
      if (cancelled || !stored) return;
      overrideRef.current = stored;
      setLanguageState(stored);
      void i18n.changeLanguage(stored).catch(() => undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [host]);

  // Follow the host only while no in-app override exists. The host has
  // already switched i18next itself in that case, so this only syncs the
  // value the switcher renders as selected.
  useEffect(
    () =>
      host.onLanguageChange((next) => {
        if (overrideRef.current) return;
        setLanguageState(resolveLanguage(null, next));
      }),
    [host],
  );

  return { language, setLanguage };
}
