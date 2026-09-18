'use client';

/**
 * What the four kinds of room actually do — the page every other surface points
 * at when it makes a claim it cannot fit on one line.
 *
 * Every fact in the comparison is DERIVED (`src/lib/chatTierExplainer.ts`), not
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
import styles from '@/app/docs/docs.module.css';

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

export default function TiersGuide({ embedded = false }: { embedded?: boolean }) {
  const Container = embedded ? 'section' : 'main';
  const Heading = embedded ? 'h2' : 'h1';
  const { t } = useTranslation();

  const chatCell = (tier: ChatTier) =>
    tier === 'dm' ? t('tiersPage.chatAccessDm') : t('tiersPage.chatAccess');

  return (
    <>
      {!embedded && <Header />}
      <Container className={embedded ? styles.tiersEmbedded : styles.tiersStandalone}>
        {!embedded && <Link
          href="/docs"
          style={{
            fontSize: 'var(--text-body-sm)',
            color: 'var(--muted)',
            textDecoration: 'none',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {t('tiersPage.backToDocs')}
        </Link>}

        <Heading
          style={{
            fontSize: 'var(--text-heading-lg)',
            fontWeight: 800,
            letterSpacing: '-0.04em',
            lineHeight: 1.15,
            margin: 'var(--space-4) 0 var(--space-3)',
          }}
        >
          {t('tiersPage.title')}
        </Heading>
        <Body>{t('tiersPage.intro')}</Body>

        <p className={styles.comparisonCaption}>{t('tiersPage.table.caption')}</p>
        <div className={styles.tierGrid}>
          {TIER_ORDER.map((tier) => {
            const access = tierAccess(tier);
            const readable = operatorCanReadChat(tier);
            return (
              <article key={tier} className={styles.tierCard} data-testid={`tier-row-${tier}`} aria-labelledby={`tier-title-${tier}`}>
                <header>
                  <h3 id={`tier-title-${tier}`}>{t(`tiersPage.tiers.${tier}.name`)}</h3>
                  <p>{t(`tiersPage.tiers.${tier}.summary`)}</p>
                </header>
                <dl className={styles.tierFacts}>
                  <div><dt>{t('tiersPage.table.find')}</dt><dd>{t(`tiersPage.find.${access.find}`)}</dd></div>
                  <div><dt>{t('tiersPage.table.join')}</dt><dd>{t(`tiersPage.join.${access.join}`)}</dd></div>
                  <div><dt>{t('tiersPage.table.posts')}</dt><dd>{t(`tiersPage.posts.${access.posts}`)}</dd></div>
                  <div><dt>{t('tiersPage.table.chat')}</dt><dd>{chatCell(tier)}</dd></div>
                  <div className={styles.tierWideFact}><dt>{t('tiersPage.table.history')}</dt><dd>{t(`tiersPage.history.${historyClaimKey(tier)}`)}</dd></div>
                  <div className={styles.tierWideFact}>
                    <dt>{t('tiersPage.table.operator')}</dt>
                    {/* Keep this derived from the runtime policy, like the chat banner. */}
                    <dd data-testid={`tier-operator-${tier}`}>
                      <strong style={{ color: readable ? 'var(--color-status-warning)' : 'var(--color-brand-accent)' }}>
                        {readable ? t('tiersPage.operator.yes') : t('tiersPage.operator.no')}
                      </strong>
                      <p>{readable ? t('tiersPage.operator.yesDetail') : t('tiersPage.operator.noDetail')}</p>
                    </dd>
                  </div>
                </dl>
              </article>
            );
          })}
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
      </Container>
    </>
  );
}
