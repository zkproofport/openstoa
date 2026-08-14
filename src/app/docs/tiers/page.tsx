'use client';

/**
 * What the four kinds of room actually do — the page every other surface points
 * at when it makes a claim it cannot fit on one line.
 *
 * Every cell in the table is DERIVED (`src/lib/chatTierExplainer.ts`), not
 * typed out here: the encryption column comes from `serverMayHoldKey`, the
 * history column from `historyForLaterJoiner`, and the access columns from one
 * table that cites the route enforcing each value. A page that restated any of
 * them would be a fifth place to get this wrong — and three of the four places
 * that described tiers before this change were already wrong about `private`.
 *
 * Reachable from: the chat banner (both clients), the topic-creation screen
 * (both clients), and `/docs`.
 */

import Link from 'next/link';
import Header from '@/components/Header';
import { useTranslation } from '@/lib/i18n/I18nProvider';
import {
  TIER_ORDER,
  historyClaimKey,
  operatorCanReadChat,
  tierAccess,
} from '@/lib/chatTierExplainer';
import type { ChatTier } from '@/lib/chatTierPolicy';

const cellStyle: React.CSSProperties = {
  padding: 'var(--space-3)',
  borderBottom: '1px solid var(--border)',
  fontSize: 'var(--text-body-sm)',
  color: 'var(--color-text-secondary)',
  verticalAlign: 'top',
  lineHeight: 1.6,
};

const headCellStyle: React.CSSProperties = {
  ...cellStyle,
  color: 'var(--color-text-primary)',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  textAlign: 'left',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 'var(--space-7)' }}>
      <h2
        style={{
          fontSize: 'var(--text-heading-sm)',
          fontWeight: 700,
          letterSpacing: '-0.03em',
          margin: '0 0 var(--space-3)',
          color: 'var(--color-text-primary)',
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        fontSize: 'var(--text-body-sm)',
        color: 'var(--color-text-secondary)',
        lineHeight: 1.75,
        margin: '0 0 var(--space-3)',
      }}
    >
      {children}
    </p>
  );
}

/** A consequence the reader will not guess. Same strip treatment as the banner. */
function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        fontSize: 'var(--text-body-sm)',
        lineHeight: 1.75,
        margin: 0,
        padding: 'var(--space-3) var(--space-4)',
        color: 'var(--color-status-warning)',
        background: 'color-mix(in srgb, var(--color-status-warning) 10%, transparent)',
        border: '1px solid color-mix(in srgb, var(--color-status-warning) 25%, transparent)',
        borderRadius: 'var(--radius-card)',
      }}
    >
      {children}
    </p>
  );
}

export default function TiersPage() {
  const { t } = useTranslation();

  const chatCell = (tier: ChatTier) =>
    tier === 'dm' ? t('tiersPage.chatAccessDm') : t('tiersPage.chatAccess');

  return (
    <>
      <Header />
      <main style={{ maxWidth: 'var(--read-max)', margin: '0 auto', padding: 'var(--space-6) var(--space-5) var(--space-7)' }}>
        <Link
          href="/docs"
          style={{
            fontSize: 'var(--text-body-sm)',
            color: 'var(--muted)',
            textDecoration: 'none',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {t('tiersPage.backToDocs')}
        </Link>

        <h1
          style={{
            fontSize: 'var(--text-heading-lg)',
            fontWeight: 800,
            letterSpacing: '-0.04em',
            lineHeight: 1.15,
            margin: 'var(--space-4) 0 var(--space-3)',
          }}
        >
          {t('tiersPage.title')}
        </h1>
        <Body>{t('tiersPage.intro')}</Body>

        {/* The table scrolls inside its own box: six columns never fit a phone,
            and a page that scrolls sideways is worse than a table that does. */}
        <div style={{ overflowX: 'auto', marginTop: 'var(--space-5)' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 720 }}>
            <caption
              style={{
                captionSide: 'top',
                textAlign: 'left',
                fontSize: 'var(--text-caption)',
                color: 'var(--muted)',
                paddingBottom: 'var(--space-2)',
              }}
            >
              {t('tiersPage.table.caption')}
            </caption>
            <thead>
              <tr>
                <th scope="col" style={headCellStyle}>{t('tiersPage.table.tier')}</th>
                <th scope="col" style={headCellStyle}>{t('tiersPage.table.find')}</th>
                <th scope="col" style={headCellStyle}>{t('tiersPage.table.join')}</th>
                <th scope="col" style={headCellStyle}>{t('tiersPage.table.posts')}</th>
                <th scope="col" style={headCellStyle}>{t('tiersPage.table.chat')}</th>
                <th scope="col" style={headCellStyle}>{t('tiersPage.table.history')}</th>
                <th scope="col" style={headCellStyle}>{t('tiersPage.table.operator')}</th>
              </tr>
            </thead>
            <tbody>
              {TIER_ORDER.map((tier) => {
                const access = tierAccess(tier);
                const readable = operatorCanReadChat(tier);
                return (
                  <tr key={tier} data-testid={`tier-row-${tier}`}>
                    <th scope="row" style={headCellStyle}>
                      <div>{t(`tiersPage.tiers.${tier}.name`)}</div>
                      <div style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 'var(--text-caption)', whiteSpace: 'normal', maxWidth: 200 }}>
                        {t(`tiersPage.tiers.${tier}.summary`)}
                      </div>
                    </th>
                    <td style={cellStyle}>{t(`tiersPage.find.${access.find}`)}</td>
                    <td style={cellStyle}>{t(`tiersPage.join.${access.join}`)}</td>
                    <td style={cellStyle}>{t(`tiersPage.posts.${access.posts}`)}</td>
                    <td style={cellStyle}>{chatCell(tier)}</td>
                    <td style={cellStyle}>{t(`tiersPage.history.${historyClaimKey(tier)}`)}</td>
                    {/* Derived from the same function the banner uses, so the
                        table and the room can never disagree. */}
                    <td
                      style={{
                        ...cellStyle,
                        color: readable ? 'var(--color-status-warning)' : 'var(--color-brand-accent)',
                        fontWeight: 600,
                      }}
                      data-testid={`tier-operator-${tier}`}
                    >
                      {readable ? t('tiersPage.operator.yes') : t('tiersPage.operator.no')}
                      <div style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 'var(--text-caption)', marginTop: 4, maxWidth: 260 }}>
                        {readable ? t('tiersPage.operator.yesDetail') : t('tiersPage.operator.noDetail')}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* The distinction the whole tier model rests on, and the one readers
            get wrong: `private` is about the conversation, not the posts. */}
        <Section title={t('tiersPage.sections.postsVsChatTitle')}>
          <Body>{t('tiersPage.sections.postsVsChatBody')}</Body>
        </Section>

        <Section title={t('tiersPage.sections.historyTitle')}>
          <Body>{t('tiersPage.sections.historyBody')}</Body>
        </Section>

        <Section title={t('tiersPage.sections.retentionTitle')}>
          <Body>{t('tiersPage.sections.retentionBody')}</Body>
          <Warning>{t('tiersPage.sections.retentionCeiling')}</Warning>
        </Section>

        <Section title={t('tiersPage.sections.devicesTitle')}>
          <Body>{t('tiersPage.sections.devicesBody')}</Body>
          <Warning>{t('tiersPage.sections.devicesWarning')}</Warning>
        </Section>

        <Section title={t('tiersPage.sections.mediaTitle')}>
          <Body>{t('tiersPage.sections.mediaBody')}</Body>
        </Section>
      </main>
    </>
  );
}
