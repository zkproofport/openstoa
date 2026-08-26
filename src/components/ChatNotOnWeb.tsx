'use client';

import { useTranslation } from '@/lib/i18n/I18nProvider';

/**
 * What a browser gets where a chat room used to be.
 *
 * It says the same thing the server already says — `middleware.ts` answers
 * `403 CHAT_MOBILE_ONLY` with "Chat is available in the ZKProofport app." The
 * screen that stood here before said **"No messages yet"** over that refusal,
 * which was not a wording problem: the rail had just advertised
 * "🔒 Encrypted message · 1d" for the same room, so a person was told a message
 * existed and then told there were none, while the panel retried the same
 * permanent 403 every three seconds behind "Reconnecting to the chat server…".
 *
 * No link out. Deep-linking into a store page from an empty room is a guess
 * about where the reader is; the sentence is the whole message until the Chat
 * control comes back with somewhere real to point (see `lib/chatOnWeb.ts`).
 */
export default function ChatNotOnWeb() {
  const { t } = useTranslation();

  return (
    <div
      data-testid="chat-not-on-web"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-3)',
        minHeight: '60vh',
        padding: 'var(--space-6)',
        textAlign: 'center',
      }}
    >
      <h1 style={{ fontSize: 'var(--text-h2)', margin: 0 }}>{t('chat.notOnWeb.title')}</h1>
      <p style={{ fontSize: 'var(--text-body)', color: 'var(--muted)', margin: 0, maxWidth: '42ch' }}>
        {t('chat.notOnWeb.body')}
      </p>
    </div>
  );
}
