'use client';

import { Fragment, useEffect, useState } from 'react';
import Header from '@/components/Header';
import CliGuide from '@/components/docs/CliGuide';
import LegacyGuide from '@/components/docs/LegacyGuide';
import ApiPolicyGuide from '@/components/docs/ApiPolicyGuide';
import LoginGuide from '@/components/docs/LoginGuide';
import ProofWorkflowGuide from '@/components/docs/ProofWorkflowGuide';
import ProofGuide from '@/components/docs/ProofGuide';
import TiersGuide from '@/components/docs/TiersGuide';
import { useTranslation } from '@/lib/i18n/I18nProvider';
import { DOCS_TOPICS, resolveDocsTopic, type DocsTopic } from '@/lib/docs/navigation';
import styles from '@/app/docs/docs.module.css';

export default function DocsPage({ initialTopic = 'intro' }: { initialTopic?: DocsTopic }) {
  const { t } = useTranslation();
  const text = (key: string) => t('docs.' + key);
  const [topic, setTopic] = useState<DocsTopic>(initialTopic);
  useEffect(() => {
    const sync = () => setTopic(resolveDocsTopic(window.location.hash || new URLSearchParams(window.location.search).get('topic') || initialTopic));
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('popstate', sync); };
  }, [initialTopic]);
  const selected = DOCS_TOPICS.find(item => item.id === topic)!;
  const proofKind = topic.startsWith('proof-') ? topic.slice(6) as 'login' | 'workspace' | 'kyc' | 'country' : null;
  return <div className={styles.shell}>
    <Header />
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <p className={styles.brand}>{text('docsTitle')}</p>
        <nav aria-label={text('navLabel')}>
          {DOCS_TOPICS.map((item, index) => <Fragment key={item.id}>
            {(index === 0 || DOCS_TOPICS[index - 1].group !== item.group) && <p className={styles.group}>{text(item.group)}</p>}
            <a className={styles.link} href={`/docs?topic=${item.id}#${item.id}`} aria-current={topic === item.id ? 'page' : undefined}>{text(item.label)}</a>
          </Fragment>)}
        </nav>
      </aside>
      <main className={styles.article} data-docs-topic={topic}>
        <p className={styles.eyebrow}>OpenStoa / {text(selected.group)}</p>
        <h1 className={styles.title}>{text(selected.label)}</h1>
        {topic === 'intro' && <>
          <p className={styles.lead}>{text('introLead')}</p>
          <div className={styles.privacyGrid}>
            {([{ feature: 'Login', target: 'proof-login' }, { feature: 'Proof', target: 'proof-workspace' }, { feature: 'Chat', target: 'chat' }] as const).map(({ feature, target }) => <section className={styles.privacyCard} key={feature} data-privacy-feature={feature.toLowerCase()}>
              <h2>{text(`introPrivacy${feature}Title`)}</h2>
              <p>{text(`introPrivacy${feature}Body`)}</p>
              <a href={`/docs?topic=${target}#${target}`}>{text(`introPrivacy${feature}Link`)} →</a>
            </section>)}
          </div>
          <p className={styles.privacyNote}>{text('introPrivacyLimits')}</p>
          <LegacyGuide section="intro" />
          <div className={styles.card}><h2>{text('introStartTitle')}</h2><p>{text('introStartBody')}</p><a href="/docs?topic=login#login">{text('navLogin')} →</a></div>
        </>}
        {topic === 'login' && <>
          <p className={styles.lead}>{text('loginLead')}</p>
          <section className={styles.card}><h2>{text('humanLoginTitle')}</h2><p>{text('humanLoginBody')}</p><a href="/docs?topic=proof-login#proof-login">{text('humanLoginProofLink')} →</a></section>
          <LoginGuide />
          <ProofWorkflowGuide />
          <section className={styles.card} id="mcp-setup"><h2>{text('mcpSetupTitle')}</h2><p>{text('mcpSetupBody')}</p>
            <pre className={styles.code}>{JSON.stringify({mcpServers: {openstoa: {command: 'npx', args: ['-y', '@masselabs/openstoa-mcp'], env: {OPENSTOA_BASE_URL: 'https://www.openstoa.xyz'}}}}, null, 2)}</pre>
            <p>{text('mcpCheckBody')}</p><pre className={styles.code}>{'openstoa_whoami {}\nopenstoa_topics_list {"view":"all"}'}</pre>
          </section>
          <section className={styles.card}><h2>{text('loginPermissionsTitle')}</h2><p>{text('loginPermissionsBody')}</p><p>{text('cliStateBody')}</p><a href="/docs?topic=chat#chat">{text('navChat')} →</a></section>
        </>}
        {topic === 'topics' && <><p className={styles.lead}>{text('topicsLead')}</p><CliGuide view="topics" /><ProofWorkflowGuide /><section className={styles.card}><h2>{text('topicsCreateTitle')}</h2><p>{text('topicsCreateBody')}</p><pre className={styles.code}>{'openstoa categories\nopenstoa topics create --title "New topic" --category-id <categoryId> --visibility public --proof-type none\nopenstoa topics join <topicId>\nopenstoa topics leave <topicId>'}</pre></section><TiersGuide embedded /></>}
        {topic === 'posts' && <><p className={styles.lead}>{text('postsLead')}</p><CliGuide view="posts" /><LegacyGuide section="posts" /></>}
        {topic === 'chat' && <><p className={styles.lead}>{text('chatLead')}</p><CliGuide view="chat" /></>}
        {proofKind && <ProofGuide kind={proofKind} />}
        {topic === 'commands' && <CliGuide view="commands" />}
        {topic === 'rest' && <><p className={styles.lead}>{text('restLead')}</p><LegacyGuide section="rest" /><ApiPolicyGuide /></>}
      </main>
    </div>
  </div>;
}
