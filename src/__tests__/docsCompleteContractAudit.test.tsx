// @vitest-environment jsdom
/** Factual prose contracts; source/API inspection established these behaviors.
 * These tests do not generate proofs or exercise external services. */
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe,expect,it} from 'vitest';
import {translate} from '@/lib/i18n';
import {I18nProvider} from '@/lib/i18n/I18nProvider';
import {DOCS_TOPICS} from '@/lib/docs/navigation';
import {FAQ_DOCS} from '@/lib/docs/faq';
import ProofGuide from '@/components/docs/ProofGuide';

it('inventory covers every current docs subject and FAQ references resolve',()=>{
 expect(DOCS_TOPICS.map(topic=>topic.id)).toEqual(['intro','login','topics','posts','chat','proof-login','proof-workspace','proof-kyc','proof-country','commands','rest']);
 for(const entry of Object.values(FAQ_DOCS)){
  expect(DOCS_TOPICS.some(topic=>topic.id===entry.topic)).toBe(true);
  for(const locale of ['en','ko'] as const)for(const key of entry.keys)expect(translate(locale,key)).not.toBe(key);
 }
});
describe.each(['en','ko'] as const)('complete factual copy (%s)',locale=>{
 it.each(['post_vote','post_bookmark','post_record','post_react','post_poll_vote'])('%s describes readable-topic actions without inventing membership requirements',operation=>{
  const text=translate(locale,'docs.cliOp_'+operation);
  expect(text).not.toMatch(/Requires topic membership|토픽 멤버(?:십)?(?:가 |여야|만| 자격이)|토픽 참여가 필요/i);
  expect(text).toMatch(locale==='en'?/secret/i:/비밀/);
 });
 it('lists generic workspace among supported topic proof types',()=>{
  expect(translate(locale,'docs.cliTopicsCreate')).toMatch(/\bworkspace\b/);
 });
 it('describes numeric newest-message history grants as well as time/epoch grants',()=>{
  const text=translate(locale,'docs.cliHistoryBody');expect(text).toMatch(/(?<![:\w])N(?!\w)/);expect(text).toMatch(locale==='en'?/newest|latest|message count/i:/최근|메시지 ?수|N개|N건/);
 });
 it.each(['workspace','kyc','country'] as const)('%s proof generation does not promise to create a login session',kind=>{
  const host=document.createElement('div');host.innerHTML=renderToStaticMarkup(<I18nProvider initialLocale={locale}><ProofGuide kind={kind}/></I18nProvider>);
  const generation=Array.from(host.querySelectorAll('section')).find(section=>section.querySelector('h2')?.textContent===translate(locale,'proofs.generateTitle'));
  expect(generation).toBeDefined();expect(generation!.textContent).not.toMatch(/saves (?:the |its |a |resulting )*session|세션을 저장|세션.{0,4}저장합니다/i);
 });
});
it('English invitation prose does not promise that every invite carries decryption keys',()=>{
 expect(translate('en','tiersPage.sections.postsVsChatBody')).not.toContain('the same link is what carries the keys');
});
