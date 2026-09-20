'use client';
import {useTranslation} from '@/lib/i18n/I18nProvider';
import styles from '@/app/docs/docs.module.css';
export default function LoginGuide(){
  const {t}=useTranslation();const text=(key:string)=>t('docs.'+key);
  return <div data-login-guide>
    <section className={styles.card}><h2>{text('loginAppTitle')}</h2><p>{text('loginAppBody')}</p>
      <pre className={styles.code}>{'npm i -g @masselabs/openstoa-cli\nopenstoa login\nopenstoa whoami'}</pre>
      <p>{text('loginAppResume')}</p><pre className={styles.code}>{'openstoa --json login --method app --approved\nopenstoa --json login --operation-id <operationId> --wait\nopenstoa --json login --operation-id <operationId> --cancel'}</pre>
    </section>
    <section className={styles.card}><h2>{text('loginAiTitle')}</h2><p>{text('loginAiBody')}</p>
      <pre className={styles.code}>{'openstoa login --method ai --approved --wait\n# --google is an alias for --method ai'}</pre>
    </section>
    <section className={styles.card}><h2>{text('loginMcpTitle')}</h2><p>{text('loginMcpBody')}</p>
      <pre className={styles.code}>{'openstoa_authenticate {}\nopenstoa_authenticate {"method":"app","approved":true}\nopenstoa_authenticate {"operationId":"<operationId>"}\nopenstoa_whoami {}'}</pre>
      <p>{text('loginMcpAi')}</p><pre className={styles.code}>{'openstoa_authenticate {"method":"ai","approved":true}\nopenstoa_authenticate {"operationId":"<operationId>"}\nopenstoa_authenticate {"operationId":"<operationId>","cancel":true}'}</pre>
    </section>
    <section className={styles.card}><h2>{text('loginKeyTitle')}</h2><p>{text('loginKeyBody')}</p>
      <pre className={styles.code}>{'export OPENSTOA_API_KEY="osk_..."\nopenstoa topics list'}</pre><p>{text('loginCredentialChoice')}</p>
    </section>
    <section className={styles.card}><h2>{text('loginResponseTitle')}</h2><p>{text('loginResponseBody')}</p><p>{text('loginRedirectBody')}</p></section>
  </div>;
}
