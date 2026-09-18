/** Documentation contracts exercise the public handler and cross-surface facts,
 * not exact prose. No external prover, network, key or wallet operation runs.
 * Matrix: environment boundary/empty/hostile identifiers, bilingual UTF-8,
 * guest discovery and result integrity covered. Size/races/database permissions
 * are N/A: this route serves static, public text without user input or writes.
 */
import {readFileSync, existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {GET} from '@/app/llms.txt/route';
import en from '@/lib/i18n/locales/en.json';
import ko from '@/lib/i18n/locales/ko.json';
import docsEn from '@/lib/i18n/locales/docs.en.json';
import docsKo from '@/lib/i18n/locales/docs.ko.json';
import {DOCS_TOPICS} from '@/lib/docs/navigation';
import {getDictionary,lookupKey} from '@/lib/i18n';
import {FAQ_DOCS} from '@/lib/docs/faq';

const read = (file: string) => readFileSync(path.resolve(file), 'utf8');
const readmes = ['README.md', 'packages/README.md', ...['sdk','commands','cli','mcp','channel'].map(name=>`packages/${name}/README.md`)];
function expectDocsLinks(text: string) {
  const links=[...text.matchAll(/\]\(([^)]+)\)/g)].map(([,href])=>new URL(href,'https://www.openstoa.xyz')).filter(url=>url.pathname==='/docs');
  expect(links.length).toBeGreaterThan(0);
  for(const url of links){
    expect(['https://www.openstoa.xyz','https://openstoa.xyz']).toContain(url.origin);
    const fragment=url.hash.slice(1);
    if(fragment)expect(DOCS_TOPICS.some(topic=>topic.id===fragment),`unknown docs fragment ${fragment}`).toBe(true);
    if(url.searchParams.has('topic')){
      expect(DOCS_TOPICS.some(topic=>topic.id===url.searchParams.get('topic'))).toBe(true);
      if(fragment)expect(url.searchParams.get('topic')).toBe(fragment);
    }
  }
  expect(text).not.toContain('/docs/agent-reference.md');
}
async function productionText() {
  vi.stubEnv('APP_ENV','production');
  const response=await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/plain;.*charset=utf-8/i);
  return response.text();
}
afterEach(()=>vi.unstubAllEnvs());

describe('documentation surfaces',()=>{
  it.each(['development','staging','', ' ', 'PRODUCTION', '<script>production</script>', undefined])('keeps llms unavailable for non-production environment %s',async env=>{
    vi.stubEnv('APP_ENV',env);
    const response=await GET();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('OPENSTOA_API_KEY');
  });
  it('serves llms as a concise Markdown discovery index pointing to actual docs subjects',async()=>{
    const text=await productionText();
    expect(text).toMatch(/^# OpenStoa\s*\n/);
    expect(text).toMatch(/^> \S/m);
    expect(text).toMatch(/^## \S/m);
    const list=text.split('\n').filter(line=>line.startsWith('- '));
    expect(list.length).toBeGreaterThan(0);
    for(const item of list)expect(item).toMatch(/^- \[[^\]]+\]\(https?:\/\/[^)]+\)/);
    expectDocsLinks(text);
    expect(text.split('\n').length).toBeLessThan(80);
    expect(text).not.toMatch(/```|openstoa proof continue|openstoa_proof_continue|proof_required|agent can mint more|Ask AI:|\$0\.10 USDC/);
  });
  it.each(readmes)('%s directs customers to docs rather than duplicating the full CLI manual',file=>{
    const text=read(file);
    expectDocsLinks(text);
    expect(text).not.toMatch(/^## Complete registered command inventory/m);
  });
  it('keeps bilingual FAQ policy and guided-proof answers in the rendered FAQ inventory',()=>{
    expect(Object.keys(en.metadata.faq).sort()).toEqual(Object.keys(ko.metadata.faq).sort());
    const layout=read('src/app/layout.tsx');
    for(const [locale,dictionary] of [['en',en],['ko',ko]] as const){
      const resolved=getDictionary(locale);
      const faq=resolved.metadata.faq as Record<string,{question:string;answer:string}>;
      for(const entry of Object.values(dictionary.metadata.faq))expect(entry).not.toHaveProperty('answer');
      for(const [key,entry] of Object.entries(faq)){
        expect(entry.question.trim().length).toBeGreaterThan(0);
        expect(entry.answer.trim().length).toBeGreaterThan(0);
        expect(entry.answer).not.toMatch(/\{\{[^}]+\}\}/);
        const guide=FAQ_DOCS[key as keyof typeof FAQ_DOCS];
        expect(guide).toBeDefined();
        for(const source of guide.keys){
          const paragraph=lookupKey(resolved,source);
          expect(paragraph,source).toEqual(expect.any(String));
          expect(entry.answer).toContain(paragraph);
        }
        expect(layout).toContain(`metadata.faq.${key}.question`);
        expect(layout).toContain(`metadata.faq.${key}.answer`);
      }
      expect(faq.q2.answer).toMatch(/API.?key|API.?키/i);
      expect(faq.q2.answer).toMatch(locale==='en'?/cannot.*(?:issue|manage)/:/발급.*(?:없|불가)/);
      expect(faq.q6.answer).toMatch(locale==='en'?/public.*server.*(?:keys|history)/i:/공개.*서버.*키/);
      expect(faq.q7,`${locale} proof FAQ`).toBeDefined();
      for(const token of ['operationId','QR'])expect(faq.q7.answer).toContain(token);
      expect(faq.q7.answer).toMatch(/\bai\b/i);
      expect(faq.q7.answer).toMatch(/\bapp\b|앱/i);
      expect(faq.q7.answer).toMatch(locale==='en'?/consent|approv/i:/동의|승인/);
      for(const key of ['workflowIntro','workflowConsent','workflowApp','workflowAi','workflowWait','workflowSeparate'])expect(faq.q7.answer).toContain(resolved.proofs[key]);
    }
  });
  it('keeps the docs-page proof controls and translated ownership/privacy guidance aligned',()=>{
    for(const [locale,dictionary] of [['en',docsEn],['ko',docsKo]] as const){
      for(const control of ['Continue','Status','Resume','Cancel']){
        const text=Reflect.get(dictionary,`cliProof${control}`);
        expect(text,`${locale} cliProof${control}`).toEqual(expect.any(String));
        expect(text.trim().length).toBeGreaterThan(10);
      }
      expect(dictionary.cliProofContinue).toContain('--wait');
      expect(dictionary.cliProofContinue).toMatch(locale==='en'?/approv|consent/i:/승인|동의/);
      expect(dictionary.cliOwnerBody).toMatch(locale==='en'?/cannot.*(?:create|manage|revoke)/:/발급.*(?:없|불가)|관리.*(?:없|불가)/);
      expect(dictionary.cliHistoryBody).toMatch(locale==='en'?/public.*server/i:/공개.*서버/);
      expect(dictionary.cliPublishBody).not.toMatch(/gated topic needs both --proof and --public-inputs|토픽.*--proof.*--public-inputs.*필수/i);
    }
  });
  it('keeps the public AGENTS index concise while retaining the full local agent context',()=>{
    const index=read('public/AGENTS.md');
    const localContext=read('AGENTS.md');
    expect(index.split('\n').length).toBeLessThan(120);
    expect(index).toMatch(/\/docs(?:[#/)]|$)/m);
    expectDocsLinks(index);
    expect(index).not.toMatch(/AGENTS\.md wins|## CLI command reference|## Topic Proof Requirements/i);
    expect(localContext).not.toBe(index);
    for(const heading of ['## CLI and MCP workflows','## CLI command reference','## Topic Proof Requirements','## Authentication Details','## Privacy & Verification Cache'])expect(localContext).toContain(heading);
    expect(localContext).toContain('openstoa proof continue <operationId>');
    expect(localContext).toContain('OPENSTOA_API_KEY');
  });
  it('preserves the static public agent index in the Docker context',()=>{
    const rules=read('.dockerignore').split('\n').map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
    // The blanket rule intentionally drops other Markdown. The static runtime
    // input needs an explicit exception after it, regardless of root AGENTS.md.
    expect(rules).toContain('*.md');
    for(const input of ['public/AGENTS.md','public/SKILL.md']){
      expect(rules.lastIndexOf(`!${input}`),`${input} must reach the Docker build`).toBeGreaterThan(rules.lastIndexOf('*.md'));
    }
  });
  it.each(['generate-skill.ts','generate-openapi.ts'])('%s writes only OpenAPI, never static discovery or local context',entry=>{
    const generator=read(`scripts/${entry}`);
    expect(generator.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'')).not.toMatch(/['\"][^'\"\n]*AGENTS\.md['\"]/);
    const probe=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',`
      import fs from 'node:fs';
      import path from 'node:path';
      import {syncBuiltinESMExports} from 'node:module';
      const root=process.cwd();
      const mutations=[];
      const record=(kind,target,source)=>{
        if(typeof target!=='string')return;
        const relative=path.relative(root,path.resolve(target));
        if(!relative.startsWith('..'))mutations.push({kind,target:relative,...(source?{source:path.relative(root,path.resolve(source))}:{})});
      };
      fs.writeFileSync=(target)=>record('write',target);
      fs.copyFileSync=(source,target)=>record('copy',target,source);
      fs.mkdirSync=(target)=>record('mkdir',target);
      fs.rmSync=(target)=>record('remove',target);
      syncBuiltinESMExports();
      await import('./scripts/${entry}');
      console.log('GENERATOR_MUTATIONS='+JSON.stringify(mutations));
    `],{cwd:process.cwd(),encoding:'utf8',timeout:15000});
    expect(probe.status,probe.stderr).toBe(0);
    const line=probe.stdout.split('\n').find(value=>value.startsWith('GENERATOR_MUTATIONS='));
    expect(line).toBeDefined();
    const mutations=JSON.parse(line!.slice('GENERATOR_MUTATIONS='.length)) as Array<{kind:string;target:string;source?:string}>;
    expect(mutations.filter(mutation=>mutation.kind==='write')).toEqual([{kind:'write',target:'src/generated/openapi-spec.json'}]);
    for(const mutation of mutations){
      expect(mutation.target).not.toMatch(/(?:^|\/)AGENTS\.md$/);
      expect(mutation.source??'').not.toMatch(/(?:^|\/)AGENTS\.md$/);
      expect(mutation.target).not.toContain('agent-reference.md');
      expect(mutation.target).toMatch(/^src\/generated(?:\/|$)/);
    }
  });
  it('keeps static SKILL discovery concise and links every docs subject directly',()=>{
    const text=read('public/SKILL.md');
    expect(text).toMatch(/^---\n[\s\S]*?\nname:|^---\nname:/);
    expect(text).toMatch(/^description: .+/m);
    expect(text.split('\n').length).toBeLessThan(120);
    expectDocsLinks(text);
    const urls=[...text.matchAll(/\]\(([^)]+)\)/g)].map(([,href])=>new URL(href,'https://www.openstoa.xyz'));
    for(const topic of DOCS_TOPICS)expect(urls.some(url=>url.pathname==='/docs'&&(url.searchParams.get('topic')===topic.id||url.hash===`#${topic.id}`)),topic.id).toBe(true);
    expect(text).not.toMatch(/(?:^|[/(])skills\/|```|Authorization: Bearer/);
    expect(existsSync('public/skills')).toBe(false);
    expect(read('src/generated/openapi-spec.json')).not.toContain('x-related-skills');
  });
  it('prebuild generates only the OpenAPI artifact while preserving the legacy command alias',()=>{
    const scripts=JSON.parse(read('package.json')).scripts;
    expect(scripts['generate:openapi']).toContain('scripts/generate-openapi.ts');
    expect(scripts.prebuild).toMatch(/generate:openapi|generate-openapi\.ts/);
    expect(scripts['generate:skill']).toMatch(/generate:openapi|generate-skill\.ts/);
  });
});
