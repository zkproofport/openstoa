'use client';

import ProofWorkflowGuide from './ProofWorkflowGuide';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from '@/lib/i18n/I18nProvider';

export type ProofGuideKind = 'login' | 'workspace' | 'kyc' | 'country';

const circuits: Record<ProofGuideKind, string> = {
  login: 'oidc_domain_attestation',
  workspace: 'oidc_domain_attestation',
  kyc: 'coinbase_attestation',
  country: 'coinbase_country_attestation',
};
const references: Record<ProofGuideKind, readonly [string, string][]> = {
  login: [['/api/docs/openapi.json', 'openApiLink']],
  workspace: [
    ['/api/docs/proof-guide/google_workspace', 'googleWorkspaceLink'],
    ['/api/docs/proof-guide/microsoft_365', 'microsoftLink'],
  ],
  kyc: [['/api/docs/proof-guide/kyc', 'kycLink']],
  country: [['/api/docs/proof-guide/country', 'countryLink']],
};
const panel: CSSProperties = {
  border: '1px solid var(--color-border-default)',
  borderRadius: 'var(--radius-card)', padding: 'clamp(16px, 3vw, 24px)',
  minWidth: 0,
};
const code: CSSProperties = {
  background: 'var(--color-bg-secondary)', color: 'var(--color-text-primary)',
  borderRadius: 'var(--radius-control)', padding: 16, overflowX: 'auto',
  fontSize: 'var(--text-body-sm)', lineHeight: 1.7, whiteSpace: 'pre', maxWidth: '100%',
};

/** The parent docs shell owns navigation, page title, and the main landmark. */
export default function ProofGuide({ kind }: { kind: ProofGuideKind }) {
  const { t } = useTranslation();
  const text = (key: string) => t(`proofs.${key}`);
  const section = (title: string, children: ReactNode) => (
    <section style={panel}>
      <h2 style={{ margin: '0 0 12px', fontSize: 'var(--text-heading-sm)' }}>{text(title)}</h2>
      {children}
    </section>
  );
  return (
    <div data-proof-guide={kind} style={{ display: 'grid', gap: 20, minWidth: 0, lineHeight: 1.8, overflowWrap: 'anywhere' }}>
      {section('introLabel', <>
        <p>{text(`${kind}Intro`)}</p>
        <p><strong>{text('circuitLabel')}: </strong><code>{circuits[kind]}</code></p>
      </>)}
      {section('prepareTitle', <p>{text(`${kind}Prepare`)}</p>)}
      {section('generateTitle', <>
        <p>{text(`${kind}Generate`)}</p>
        {kind !== 'login' && <p>{text('commonRelay')}</p>}
        <p>{text('commonScope')}</p>
        <p>{text('commonAvailability')}</p>
      </>)}
      {section('verifyTitle', <>
        {kind !== 'login' && <><p>{text('commonVerification')}</p><p role="note"><strong>{text('commonVerificationLimit')}</strong></p></>}
        <p>{text(`${kind}Verify`)}</p>
      </>)}
      {section('privacyTitle', <>
        <p>{text(`${kind}Privacy`)}</p>
        <p>{text('commonBadges')}</p>
      </>)}
      {section('integrationTitle', kind === 'login' ? <>
        <p>{text('loginIntegration')}</p>
        <pre style={code}>{`openstoa login
openstoa --json whoami`}</pre>
      </> : <>
        <p>{text('commonAccess')}</p>
        <p>{text('commonExample')}</p>
        <pre style={code}>{`openstoa --json topics get "$TOPIC_ID"
openstoa topics join "$TOPIC_ID" \\
  --proof "$PROOF" \\
  --public-inputs "$PUBLIC_INPUTS"`}</pre>
      </>)}
      <ProofWorkflowGuide />
      {section('referenceTitle', <>
        <p>{text('referenceBody')}</p>
        <ul style={{ margin: 0, paddingInlineStart: 22 }}>
          {references[kind].map(([href, label]) => <li key={href}><a href={href} style={{ color: 'var(--color-brand-accent)' }}>{text(label)}</a></li>)}
        </ul>
      </>)}
    </div>
  );
}
