'use client';

import { useTranslation } from '@/lib/i18n/I18nProvider';

/** Shared by setup, topics and each circuit guide. */
export default function ProofWorkflowGuide() {
  const { t } = useTranslation();
  const text = (key: string) => t(`proofs.workflow${key}`);
  const code = { background: 'var(--color-bg-secondary)', padding: 16, borderRadius: 'var(--radius-control)', overflowX: 'auto' as const, whiteSpace: 'pre' as const, fontSize: 'var(--text-body-sm)', lineHeight: 1.7 };
  return <section data-proof-workflow style={{ marginTop: 24, lineHeight: 1.8, minWidth: 0 }}>
    <h2>{text('Title')}</h2>
    <p>{text('Intro')}</p>
    <p>{text('Consent')}</p>
    <p>{text('App')}</p>
    <pre style={code}>{`openstoa topics join <topicId> --method app --approved --wait
openstoa topics create --title "Members" --category-id <categoryId> --proof-type kyc --method app --approved --wait
openstoa topics join-invite <inviteCode> --method app --approved --wait`}</pre>
    <p>{text('Wait')}</p>
    <p>{text('Separate')}</p>
    <pre style={code}>{`openstoa --json topics join <topicId>
openstoa --json proof continue <operationId> --approved --method app
openstoa --json proof status <operationId>
openstoa --json proof resume <operationId> --wait
openstoa --json proof cancel <operationId>`}</pre>
    <p>{text('Ai')}</p>
    <pre style={code}>{`openstoa topics join <topicId> --method ai --approved --provider google --wait`}</pre>
    <p>{text('Resume')}</p>
    <p>{text('Mcp')}</p>
    <pre style={code}>{`openstoa_topic_join {"topicId":"<topicId>","method":"app","approved":true}
openstoa_proof_status {"operationId":"<operationId>"}
openstoa_proof_resume {"operationId":"<operationId>"}
openstoa_proof_cancel {"operationId":"<operationId>"}`}</pre>
    <p>{text('Version')}</p>
  </section>;
}
