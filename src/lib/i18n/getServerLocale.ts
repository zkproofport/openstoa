import { cookies } from 'next/headers';
import { LOCALE_COOKIE, resolveLocale, type Locale } from './index';

/**
 * Server-side locale resolution for `src/app/layout.tsx` — reads the
 * `NEXT_LOCALE` cookie (written by a future client-side locale switcher) and
 * validates it. Missing cookie, unknown value, or any other garbage all fall
 * back to DEFAULT_LOCALE via `resolveLocale` — this function never throws,
 * so a malformed cookie can never break page render.
 */
export async function getServerLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  return resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value);
}
