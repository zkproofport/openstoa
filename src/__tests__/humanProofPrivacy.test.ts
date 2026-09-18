import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {NextRequest} from 'next/server';
import {expect,it} from 'vitest';
import {middleware} from '@/middleware';
it('serves the proof handoff without a browser session',async()=>{
  const response=await middleware(new NextRequest('https://openstoa.test/proof'));
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('x-middleware-next')).toBe('1');
});
it.each(['/proof','/topics'])('does not send fragment metadata through analytics on %s',pathname=>{
  const source=readFileSync('src/app/layout.tsx','utf8');
  const script=source.match(/\{`(window\.dataLayer[\s\S]*?)`\}/)![1].replace('${GA_ID}','test-id');
  const dataLayer:unknown[][]=[];
  const window={dataLayer,location:{pathname,origin:'https://openstoa.test',href:`https://openstoa.test${pathname}#private-scope`}};
  runInNewContext(script,{window,dataLayer,Date});
  const configs=dataLayer.filter(args=>args[0]==='config');
  if(pathname==='/proof') expect(configs).toHaveLength(0);
  else expect(Array.from(configs[0])).toEqual(['config','test-id',{page_location:'https://openstoa.test/topics'}]);
});

it('passes runtime public relay configuration to the browser instead of the Docker hostname', async()=>{
  const {default:ProofPage}=await import('@/app/proof/page');
  const originalPublic=process.env.NEXT_PUBLIC_RELAY_URL;
  const originalInternal=process.env.RELAY_URL;
  try{
    process.env.NEXT_PUBLIC_RELAY_URL='http://192.168.0.5:4001';
    process.env.RELAY_URL='http://relay:4001';
    expect(ProofPage().props.relayOrigin).toBe('http://192.168.0.5:4001');
    delete process.env.NEXT_PUBLIC_RELAY_URL;
    process.env.RELAY_URL='https://custom-relay.example';
    expect(ProofPage().props.relayOrigin).toBe('https://custom-relay.example');
    delete process.env.RELAY_URL;
    expect(ProofPage().props.relayOrigin).toBe('https://relay.zkproofport.app');
  }finally{
    if(originalPublic===undefined)delete process.env.NEXT_PUBLIC_RELAY_URL;else process.env.NEXT_PUBLIC_RELAY_URL=originalPublic;
    if(originalInternal===undefined)delete process.env.RELAY_URL;else process.env.RELAY_URL=originalInternal;
  }
});

it('explicitly resolves proof relay configuration at request time', async()=>{
  const page=await import('@/app/proof/page');
  expect(page).toHaveProperty('dynamic','force-dynamic');
});
