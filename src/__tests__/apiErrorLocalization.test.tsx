// @vitest-environment jsdom
/** Edge cases: known auth/member/owner errors and async API failures; unknown
 * empty/whitespace/null/undefined/non-string/hostile/Unicode/oversized inputs;
 * numeric interpolation boundaries; EN/KO integrity and rendered UI wiring.
 * Server authorization, DB/RPC, and real HTTP E2E are unchanged and outside this
 * client-only mapping test. User-authored content must remain byte-for-byte. */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localizeApiError } from '@/lib/i18n/errorMessages';
import { translate, type Locale } from '@/lib/i18n';
import { I18nProvider } from '@/lib/i18n/I18nProvider';
import PollRenderer from '@/components/PollRenderer';
import type { Poll } from '@/lib/polls';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const translator = (locale: Locale) => (key: string, params?: Record<string, string | number>) => translate(locale, key, params);
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
});

describe('safe API error localization', () => {
  it.each(['en', 'ko'] as const)('maps actionable wire errors in %s', (locale) => {
    const t = translator(locale);
    for (const [message, key] of [
      ['Not authenticated', 'signIn'], ['Not a member of this topic', 'memberRequired'],
      ['Nickname already taken', 'nicknameTaken'], ['Rate limit exceeded', 'rateLimit'],
      ['This topic requires an invite code', 'inviteRequired'],
      ['Invalid or unverifiable topic proof', 'proofFailed'],
      ['Invalid country predicate', 'countryBlocked'],
      ['Transfer topic ownership before leaving', 'transferFirst'],
      ['Poll is closed', 'pollClosed'], ['Post is locked after on-chain record', 'postLocked'],
    ]) {
      expect(localizeApiError(new Error(message), t)).toBe(t(`apiErrors.${key}`));
    }
    if (locale === 'ko') expect(localizeApiError('Nickname already taken', t)).toMatch(/[가-힣]/);
  });

  it.each([undefined, null, '', ' ', '\n\t', 0, 1, {}, { error: 'Not authenticated' },
    'constructor', '__proto__', '<script>alert(1)</script>', 'SQL SELECT * FROM users',
    '%_\\', '내부 오류: 비밀 🔑', 'x'.repeat(500), 'x'.repeat(501), 'x'.repeat(1000)])(
    'does not expose unknown input %#', (input) => {
      const t = translator('ko');
      expect(localizeApiError(input, t, 'poll.voteFailed')).toBe(t('poll.voteFailed'));
    },
  );

  it('only preserves explicitly trusted local validation messages', () => {
    const t = translator('ko');
    const message = t('accountRecovery.invalidRecoveryCode');
    expect(localizeApiError(new Error(message), t)).toBe(message);
    expect(localizeApiError(new Error(`${message} secret`), t)).toBe(t('apiErrors.generic'));
  });

  it('interpolates bounded numeric wire fields without reflecting arbitrary text', () => {
    const t = translator('ko');
    for (const minutes of [0, 1, 59]) {
      expect(localizeApiError(`Post must be at least 1 hour old. ${minutes} minutes remaining.`, t))
        .toBe(t('apiErrors.recordWait', { minutes }));
    }
    expect(localizeApiError('Daily record limit reached (3/day)', t)).toBe(t('apiErrors.recordLimit', { count: 3 }));
    expect(localizeApiError('Title must be 200 characters or less', t)).toBe(t('apiErrors.titleLength', { max: 200 }));
    expect(localizeApiError('Content must be 9999999 characters or less', t)).toBe(t('apiErrors.generic'));
    expect(localizeApiError('Title must be <script> characters or less', t)).toBe(t('apiErrors.generic'));
  });

  it('provides localized passkey cancellation guidance without browser diagnostics', () => {
    const t = translator('ko');
    expect(localizeApiError(new DOMException('internal browser reason', 'NotAllowedError'), t)).toBe(t('apiErrors.passkeyCancelled'));
  });

  it.each([
    ['ko', 'Poll is closed', 'apiErrors.pollClosed'],
    ['ko', 'Database password=secret', 'poll.voteFailed'],
    ['en', 'Poll is closed', 'apiErrors.pollClosed'],
  ] as const)('renders %s vote failures safely (%s)', async (locale, message, key) => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const onVote = vi.fn().mockRejectedValue(new Error(message));
    const poll = {
      id: 'poll', postId: 'post', question: '사용자 질문 User content 🔐',
      options: [{ id: 'a', text: 'User option A', position: 0, voteCount: 0 }],
      multipleChoice: false, isClosed: false, totalVotes: 0, userVotedOptionIds: [], closesAt: null,
    } as unknown as Poll;
    await act(async () => root!.render(<I18nProvider initialLocale={locale}>
      <PollRenderer poll={poll} onVote={onVote} onUnvote={vi.fn()} />
    </I18nProvider>));
    await act(async () => container!.querySelector('button')!.click());
    expect(onVote).toHaveBeenCalledWith(['a']);
    expect(container.textContent).toContain(translate(locale, key));
    expect(container.textContent).toContain(poll.question);
    if (locale === 'ko') expect(container.textContent).not.toContain(message);
  });
});
