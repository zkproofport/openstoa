// @vitest-environment jsdom
/** Regression checks for claims contradicted by the existing API/MLS behavior.
 * These check documentation only, not live proof generation or network services. */
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
import {translate} from '@/lib/i18n';
import {I18nProvider} from '@/lib/i18n/I18nProvider';
import LegacyGuide from '@/components/docs/LegacyGuide';

it.each(['en','ko'] as const)('does not invent recipient acceptance for immediate DM creation (%s)',locale=>{
 expect(translate(locale,'tiersPage.join.accept')).not.toMatch(/accept|수락/i);
});
it.each(['en','ko'] as const)('acknowledges member key sharing beyond invitation-carried history (%s)',locale=>{
 const history=translate(locale,'tiersPage.history.window')+' '+translate(locale,'tiersPage.sections.historyBody');
 expect(history).toMatch(locale==='en'?/key.sharing|shar\w* (?:[^.]{0,45})?keys/i:/키.{0,30}공유|공유.{0,30}키/);
 expect(history).not.toMatch(/only reaches you if the person inviting|Only what the person who invited/i);
});
it('qualifies secret-room listing privacy for non-members',()=>{
 const copy=translate('en','tiersPage.sections.postsVsChatBody');
 expect(copy).not.toContain('hidden from every list');
 expect(copy).toMatch(/non.members|members.only|only members/i);
});
it.each(['en','ko'] as const)('scopes every documented post-image upload to its topic (%s)',locale=>{
 const host=document.createElement('div');
 host.innerHTML=renderToStaticMarkup(<I18nProvider initialLocale={locale}><LegacyGuide section="posts"/><LegacyGuide section="rest"/></I18nProvider>);
 const uploads=Array.from(host.querySelectorAll('pre')).flatMap(pre=>(pre.textContent??'').match(/curl[^\n]*\/api\/upload[\s\S]*?jq -r '\.publicUrl'/g)??[]);
 expect(uploads.length).toBeGreaterThanOrEqual(4);
 for(const command of uploads)expect(command).toMatch(/-F ["']topicId=/);
});
it.each(['en','ko'] as const)('does not claim a fixed seven-day session lifetime (%s)',locale=>{
 const host=document.createElement('div');
 host.innerHTML=renderToStaticMarkup(<I18nProvider initialLocale={locale}><LegacyGuide section="rest"/></I18nProvider>);
 const copy=host.textContent??'';
 expect(copy).not.toMatch(/Session tokens last 7 days|세션 토큰.{0,12}7일/);
 expect(copy).toMatch(locale==='en'?/30.day|30 days/:/30일/);
});
it.each(['en','ko'] as const)('constructs valid JSON in the REST proof submission example (%s)',locale=>{
 const host=document.createElement('div');
 host.innerHTML=renderToStaticMarkup(<I18nProvider initialLocale={locale}><LegacyGuide section="rest"/></I18nProvider>);
 const example=Array.from(host.querySelectorAll('pre')).map(pre=>pre.textContent??'').find(text=>text.includes('PROOF_RESULT=')&&text.includes('/join'));
 expect(example).toBeDefined();
 // Test shell/JSON composition only. The functions intercept both commands:
 // no prover starts, no HTTP happens, and these bytes never reach verification.
 const intercept=`npx(){ printf '%s\\n' '{"proof":"0xab","publicInputs":["0xcd"]}'; }
curl(){ while [ "$#" -gt 0 ]; do if [ "$1" = "-d" ] || [ "$1" = "--data" ] || [ "$1" = "--data-raw" ]; then printf '%s' "$2"; return; fi; shift; done; }
`;
 const result=execFileSync('/bin/bash',['-c',intercept+example],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']});
 expect(JSON.parse(result)).toEqual({proof:'0xab',publicInputs:['0xcd']});
});
