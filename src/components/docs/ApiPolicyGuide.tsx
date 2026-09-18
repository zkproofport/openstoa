 'use client';
import {API_AUTHORIZATION_POLICIES} from '@/lib/apiAuthorizationPolicies';
import {useTranslation} from '@/lib/i18n/I18nProvider';
export default function ApiPolicyGuide(){
 const {t}=useTranslation();
 return <section style={{marginTop:32}}><h2>{t('docs.apiPolicyTitle')}</h2><p>{t('docs.apiPolicyBody')}</p>
 <div style={{overflowX:'auto'}}><table style={{width:'100%',fontSize:'var(--text-caption)',borderCollapse:'collapse'}}><tbody>
 {Object.entries(API_AUTHORIZATION_POLICIES).flatMap(([route,methods])=>Object.entries(methods).map(([method,policy])=><tr key={method+route}>
 <td style={{padding:8,borderBottom:'1px solid var(--color-border-default)'}}><code>{method} {route}</code></td>
 <td style={{padding:8,borderBottom:'1px solid var(--color-border-default)'}}>{policy.kind==='capability'?<code>{[...(policy.all??[]),...(policy.any?.length?['('+policy.any.join(' or ')+')']:[])].join(', ')}</code>:t('docs.apiPolicy'+policy.kind[0].toUpperCase()+policy.kind.slice(1))}</td>
 </tr>))}</tbody></table></div></section>;
}
