import {NextRequest} from 'next/server';

/** Supply real HTTP metadata to legacy body-reader fixtures, without replacing authorization. */
export function withHttpRequest<T extends (request: NextRequest, ...args: any[]) => any>(handler:T, method:string):T {
 return ((fixture:NextRequest,...args:any[])=>{
  const url=fixture?.url??fixture?.nextUrl?.toString()??'http://localhost:3200/';
  const request=new NextRequest(url,{method,headers:fixture?.headers instanceof Headers?fixture.headers:undefined});
  // Some tests intentionally throw from json()/arrayBuffer(), or supply cyclic
  // objects impossible to serialize. Preserve those deliberate body readers.
  const enriched=new Proxy(request,{get(target,property){
   if(property==='method')return method;
   if(property==='headers')return target.headers;
   if(fixture&&Object.prototype.hasOwnProperty.call(fixture,property)){
    const value=Reflect.get(fixture,property);return typeof value==='function'?value.bind(fixture):value;
   }
   const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }});
  return handler(enriched,...args);
 }) as T;
}
