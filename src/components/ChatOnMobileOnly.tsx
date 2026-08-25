'use client';

/**
 * Chat lives on the phone. This is what the web says instead.
 *
 * WHY THERE IS NO WEB CHAT. A person holds their chat keys on ONE device, the
 * mobile app. A browser is the one place that rule cannot hold: signing out
 * cleared the session and nothing else, so the MLS ClientState stayed in
 * IndexedDB, the leaf identity in `localStorage`, and — worst, because it is
 * not even ciphertext — the decrypted-picture cache sat on disk. Closing the
 * browser changed none of it. On a library or office machine the next person
 * opens the same browser and reads the previous person's end-to-end encrypted
 * conversation.
 *
 * That is not something a "clear on sign-out" fixes in the way it needs fixing:
 * it depends on someone remembering to sign out, on a shared machine, on the
 * one screen where forgetting costs the most. The keys should never be there.
 *
 * So this replaces every chat surface on the web, and does the one useful thing
 * a chat surface can do from here: point at the app.
 */

import { useTranslation } from '@/lib/i18n/I18nProvider';

export interface ChatOnMobileOnlyProps {
  /**
   * Rendered inside a panel that already has its own frame (the chat rail), so
   * the notice must not draw a second border or claim the full viewport.
   */
  inline?: boolean;
}

const APP_STORE_URL = 'https://apps.apple.com/app/zkproofport/id0000000000';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.masselabs.zkproofport';

export default function ChatOnMobileOnly({ inline = false }: ChatOnMobileOnlyProps) {
  const { t } = useTranslation();

  return (
    <div
      data-testid="chat-on-mobile-only"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-4)',
        textAlign: 'center',
        padding: inline ? 'var(--space-6) var(--space-4)' : 'var(--space-8) var(--space-4)',
        // Fills the rail when inline, the page when not — either way it is the
        // whole of what chat looks like here, so it should not float.
        minHeight: inline ? '100%' : '60vh',
      }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: 'var(--text-title)',
          fontWeight: 700,
          letterSpacing: '-0.01em',
          color: 'var(--foreground)',
          textWrap: 'balance',
        }}
      >
        {t('chat.mobileOnly.title')}
      </h2>

      <p
        style={{
          margin: 0,
          maxWidth: '34rem',
          color: 'var(--muted)',
          fontSize: 'var(--text-body)',
          lineHeight: 1.6,
        }}
      >
        {t('chat.mobileOnly.body')}
      </p>

      <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', justifyContent: 'center' }}>
        {/*
          Both stores, not a device sniff. A person reading this on a desktop is
          not on the phone they will install to, so guessing the platform from
          the user agent would offer the wrong one to exactly the audience this
          screen has.
        */}
        <a
          className="os-button"
          href={APP_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ minHeight: 'var(--touch-target-min)', display: 'inline-flex', alignItems: 'center' }}
        >
          {t('chat.mobileOnly.appStore')}
        </a>
        <a
          className="os-button"
          href={PLAY_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ minHeight: 'var(--touch-target-min)', display: 'inline-flex', alignItems: 'center' }}
        >
          {t('chat.mobileOnly.playStore')}
        </a>
      </div>

      <p
        style={{
          margin: 0,
          maxWidth: '34rem',
          color: 'var(--ink-faint, var(--muted))',
          fontSize: 'var(--text-label)',
          lineHeight: 1.6,
        }}
      >
        {t('chat.mobileOnly.why')}
      </p>
    </div>
  );
}
