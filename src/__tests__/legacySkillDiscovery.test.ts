/** Static discovery is public in every environment. Legacy input never becomes
 * an arbitrary redirect target; matrix includes case, empty suffix, UTF-8,
 * hostile/query input and guest/stale-token access. Size/races/database roles
 * are N/A: this deterministic middleware only maps paths to fixed docs URLs. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {middleware} from '@/middleware';
afterEach(()=>vi.unstubAllEnvs());
describe.each(['production','staging','development',''])('public skill discovery in %s',environment=>{
 it.each([
  ['/skills','intro'],['/skills/','intro'],
  ['/skills/getting-started/cli-workflows/SKILL.md','intro'],
  ['/SKILLS/AUTH/TOPIC-PROOFS/skill.MD','intro'],
  ['/skills/api/topics/list-topics/SKILL.md','rest'],
  ['/SkIlLs/ApI/PROFILE/CREATE-API-KEY/SKILL.md','rest'],
  ['/skills/한글/🔐/SKILL.md','intro'],
  ['/skills/api/%27%3BDROP--/SKILL.md?next=https://evil.invalid&token=secret','rest'],
 ])('redirects %s directly to its authoritative docs subject',async(path,topic)=>{
  vi.stubEnv('APP_ENV',environment);
  for(const headers of [{},{authorization:'Bearer invalid.invalid.invalid'}] as Array<Record<string,string>>){
   const response=await middleware(new NextRequest('https://www.openstoa.xyz'+path,{headers}));
   expect(response.status).toBe(308);
   expect(response.headers.get('location')).toBe(`https://www.openstoa.xyz/docs?topic=${topic}#${topic}`);
   expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  }
 });
 it.each(['/skill.md','/SkIlL.Md','/SKILL.md'])('keeps %s publicly accessible with canonical casing',async(path)=>{
  vi.stubEnv('APP_ENV',environment);
  const response=await middleware(new NextRequest('https://www.openstoa.xyz'+path));
  expect(response.status).toBe(200);
  expect(response.headers.get('location')).toBeNull();
  if(path==='/SKILL.md')expect(response.headers.get('x-middleware-next')).toBe('1');
  else expect(response.headers.get('x-middleware-rewrite')).toBe('https://www.openstoa.xyz/SKILL.md');
 });
});
