/**
 * `getServerLocale()` — the server half of the i18n scaffold, used by
 * `src/app/layout.tsx` to set `<html lang>`. `next/headers` is mocked so the
 * cookie value is fully controlled; the validation logic itself is covered
 * exhaustively by `resolveLocale` in `i18n.test.ts` — this file only proves
 * the wiring (cookie name, async cookies() call) is correct.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const cookieStoreMock = {
  get: vi.fn<(name: string) => { value: string } | undefined>(),
};

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => cookieStoreMock),
}));

beforeEach(() => {
  cookieStoreMock.get.mockReset();
});

describe('getServerLocale', () => {
  it('reads the NEXT_LOCALE cookie by name', async () => {
    cookieStoreMock.get.mockReturnValue({ value: 'ko' });
    const { getServerLocale } = await import('@/lib/i18n/getServerLocale');

    const locale = await getServerLocale();

    expect(cookieStoreMock.get).toHaveBeenCalledWith('NEXT_LOCALE');
    expect(locale).toBe('ko');
  });

  it('missing cookie -> DEFAULT_LOCALE, never throws', async () => {
    cookieStoreMock.get.mockReturnValue(undefined);
    const { getServerLocale } = await import('@/lib/i18n/getServerLocale');

    await expect(getServerLocale()).resolves.toBe('en');
  });

  it('garbage cookie value -> DEFAULT_LOCALE, never throws', async () => {
    cookieStoreMock.get.mockReturnValue({ value: 'not-a-real-locale' });
    const { getServerLocale } = await import('@/lib/i18n/getServerLocale');

    await expect(getServerLocale()).resolves.toBe('en');
  });
});
