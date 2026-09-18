import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {NextRequest} from 'next/server';
import {expect,it} from 'vitest';
import {middleware} from '@/middleware';
it('allows the login approval page without an existing browser session',async()=>{
 const response=await middleware(new NextRequest('http://localhost:3200/login?loginId=public-id'));
 expect(response.headers.get('location')).toBeNull();expect(response.headers.get('x-middleware-next')).toBe('1');
});
it('does not initialize analytics for the approval-secret fragment page',()=>{
 const source=readFileSync('src/app/layout.tsx','utf8');
 const script=source.match(/\{`(window\.dataLayer[\s\S]*?)`\}/)![1].replace('${GA_ID}','test-id');
 const dataLayer:unknown[][]=[];
 const window={dataLayer,location:{pathname:'/login',origin:'https://openstoa.test',href:'https://openstoa.test/login?loginId=id#approvalToken=do-not-transmit'}};
 runInNewContext(script,{window,dataLayer,Date});
 expect(dataLayer.filter(args=>args[0]==='config')).toHaveLength(0);
 expect(JSON.stringify(dataLayer)).not.toContain('do-not-transmit');
});
