'use client';

import { useTranslation } from '@/lib/i18n/I18nProvider';
import styles from '@/app/docs/docs.module.css';

/** Shared by setup, topics and each circuit guide. */
export default function ProofWorkflowGuide() {
  const { t } = useTranslation();
  const text = (key: string) => t(`proofs.workflow${key}`);
  return <section data-proof-workflow className={`${styles.card} ${styles.proofWorkflow}`}>
    <h2>{text('Title')}</h2>
    <p>{text('Intro')}</p>
    <p>{text('Consent')}</p>
    <p>{text('App')}</p>
    <pre className={styles.code}>{`openstoa topics join <topicId> --method app --approved --wait
openstoa topics create --title "Members" --category-id <categoryId> --proof-type kyc --method app --approved --wait
openstoa topics join-invite <inviteCode> --method app --approved --wait`}</pre>
    <p>{text('Wait')}</p>
    <p>{text('Separate')}</p>
    <pre className={styles.code}>{`openstoa --json topics join <topicId>
openstoa --json proof continue <operationId> --approved --method app
openstoa --json proof status <operationId>
openstoa --json proof resume <operationId> --wait
openstoa --json proof cancel <operationId>`}</pre>
    <p>{text('Ai')}</p>
    <pre className={styles.code}>{`openstoa topics join <topicId> --method ai --approved --provider google --wait`}</pre>
    <p>{text('Resume')}</p>
    <p>{text('Mcp')}</p>
    <pre className={styles.code}>{`openstoa_topic_join {"topicId":"<topicId>","method":"app","approved":true}
openstoa_proof_status {"operationId":"<operationId>"}
openstoa_proof_resume {"operationId":"<operationId>"}
openstoa_proof_cancel {"operationId":"<operationId>"}`}</pre>
    <p>{text('Version')}</p>
  </section>;
}
