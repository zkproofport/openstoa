// @vitest-environment jsdom
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import LoginGuide from '@/components/docs/LoginGuide';
import LegacyGuide from '@/components/docs/LegacyGuide';
import {I18nProvider} from '@/lib/i18n/I18nProvider';
import {translate} from '@/lib/i18n';
import {PROOF_GUIDES} from '@/lib/proof-guides';

it.each(['en','ko'] as const)('documents login identity plus a selected permission key (%s)',locale=>{
 const host=document.createElement('div');
 host.innerHTML=renderToStaticMarkup(<I18nProvider initialLocale={locale}><LoginGuide/><LegacyGuide section="rest"/></I18nProvider>);
 const content=host.textContent??'';
 expect(content).toContain('openstoa login');expect(content).toContain('OPENSTOA_API_KEY');
 expect(content).toContain('X-OpenStoa-API-Key');
 expect(content).not.toMatch(/Authorization: Bearer \$OPENSTOA_API_KEY/);
 expect(content).not.toMatch(/no additional login|no login step|별도 로그인 없이|API 키로 인증합니다/);
 expect(translate(locale,'docs.loginCredentialChoice')).not.toMatch(/Remove that configuration|API 키 설정을 해제/);
});
it('browser approval does not promise that login bypasses selected-key permissions',()=>{
 expect(translate('en','cliLogin.consent')).not.toMatch(/full account session|API key instead/i);
});
it.each(['en','ko'] as const)('proof instructions do not describe the permission key as an alternative identity (%s)',locale=>{
 const text=['commonAccess','commonScope','workflowMcp'].map(key=>translate(locale,`proofs.${key}`)).join('\n');
 expect(text).not.toMatch(/Sign in with a proof or|Authenticate with openstoa_authenticate or a scoped API key|로그인 세션이나 API 키|openstoa_authenticate 또는 API 키/);
});
it.each(Object.entries(PROOF_GUIDES))('proof guide %s uses separate identity and permission headers',(type,guide)=>{
 const commands=guide.steps.agent.map(step=>step.code??'').join('\n');
 expect(commands,type).toContain('Authorization: Bearer');
 expect(commands,type).toContain('X-OpenStoa-API-Key');
 expect(commands,type).not.toContain('Authorization: Bearer $OPENSTOA_API_KEY');
});
it.each([
 'packages/cli/README.md','packages/mcp/README.md','packages/commands/README.md','packages/sdk/README.md',
 'public/SKILL.md','src/generated/openapi-spec.json',
])('customer documentation does not teach key-only authentication: %s',file=>{
 const text=readFileSync(file,'utf8');
 expect(text).not.toMatch(/Authorization: Bearer (?:osk_|<key>)/);
 expect(text).not.toMatch(/no login step|no auth tool call|in place of an interactive login|no challenge, no proof, no token/i);
 expect(text).not.toMatch(/Bare\/Google login is disabled|Interactive Google device-flow login is \*\*disabled in this repository\*\*/);
});
it('published topic creation requires both identity and permission headers for Bearer agents',()=>{
 const document=JSON.parse(readFileSync('src/generated/openapi-spec.json','utf8'));
 const key=Object.entries(document.components.securitySchemes).find(([,value])=>(value as {name?:string}).name==='X-OpenStoa-API-Key')?.[0];
 expect(key).toBeDefined();
 const security=document.paths['/api/topics'].post.security;
 expect(security).toContainEqual({bearerAuth:[],[key!]:[]});
 expect(security).not.toContainEqual({bearerAuth:[]});
 expect(security).not.toContainEqual({[key!]:[]});
});
it.each(['en','ko'] as const)('the authoritative REST guide demonstrates separate identity and permission headers (%s)',locale=>{
 const host=document.createElement('div');
 host.innerHTML=renderToStaticMarkup(<I18nProvider initialLocale={locale}><LegacyGuide section="rest"/></I18nProvider>);
 const examples=[...host.querySelectorAll('pre')].map(node=>node.textContent??'');
 expect(examples.some(text=>text.includes('Authorization: Bearer $OPENSTOA_SESSION_TOKEN')&&text.includes('X-OpenStoa-API-Key: $OPENSTOA_API_KEY')&&text.includes('-H "$AUTH" -H "$API_KEY_HEADER"'))).toBe(true);
});
it('published owner key management requires owner session identity without a selected key',()=>{
 const document=JSON.parse(readFileSync('src/generated/openapi-spec.json','utf8'));
 const security=document.paths['/api/profile/api-keys'].post.security;
 expect(security).toContainEqual({bearerAuth:[]});
 expect(security).toContainEqual({cookieAuth:[]});
 expect(security).not.toContainEqual({});
 for(const requirement of security)expect(Object.keys(requirement)).not.toContain('permissionKey');
});
