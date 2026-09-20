'use client';
import {useEffect,useRef,useState} from 'react';
import {useTranslation} from '@/lib/i18n/I18nProvider';
import {apiFetch} from '@/lib/apiFetch';
import LocaleSwitcher from '@/components/LocaleSwitcher';
import ThemeToggle from '@/components/ThemeToggle';
import Spinner from '@/components/Spinner';

type Status='loading'|'consent'|'pending'|'completed'|'cancelled'|'expired'|'error'|'invalid';
export default function CliLoginPage(){
  const {t}=useTranslation();
  const [status,setStatus]=useState<Status>('loading');
  const [qr,setQr]=useState<string>();
  const [deepLink,setDeepLink]=useState<string>();
  const credentials=useRef<{loginId:string;approvalToken:string}|null>(null);
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const expiryTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const deadline=useRef(0);const active=useRef(false);const mounted=useRef(true);
  useEffect(()=>{
    mounted.current=true;
    const loginId=credentials.current?.loginId??new URLSearchParams(window.location.search).get('loginId');
    const approvalToken=credentials.current?.approvalToken??new URLSearchParams(window.location.hash.slice(1)).get('approvalToken');
    window.history.replaceState(null,'',window.location.pathname+window.location.search);
    if(!loginId||!approvalToken||!/^[A-Za-z0-9_-]{1,128}$/.test(loginId)||!/^[A-Za-z0-9_-]{20,128}$/.test(approvalToken)){setStatus('invalid');}
    else {credentials.current={loginId,approvalToken};setStatus('consent');}
    return ()=>{mounted.current=false;active.current=false;clearTimeout(timer.current);clearTimeout(expiryTimer.current);};
  },[]);
  const finish=(next:Status)=>{active.current=false;clearTimeout(timer.current);clearTimeout(expiryTimer.current);if(mounted.current)setStatus(next);};
  async function poll(){
    if(!active.current||!credentials.current)return;
    if(Date.now()>=deadline.current){finish('expired');return;}
    const {loginId,approvalToken}=credentials.current;
    try{
      const response=await apiFetch(`/api/auth/cli-login/${encodeURIComponent(loginId)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({approvalToken}),cache:'no-store',referrerPolicy:'no-referrer'});
      if(!active.current||!mounted.current)return;
      if(response.status===410){finish('expired');return;}
      if(!response.ok){finish('error');return;}
      const result=await response.json();
      if(!active.current||!mounted.current)return;
      if(result.status==='cancelled'){finish('cancelled');return;}
      if(result.status==='completed'){
        const value=result.redirectUrl;
        if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||/[\\\u0000-\u0020]/.test(value)||/%(?:0[ad]|5c|2f)/i.test(value)){finish('error');return;}
        const url=new URL(value,window.location.origin);
        if(url.origin!==window.location.origin||!/^\/(?:$|my(?:\/|$)|topics(?:\/|$)|docs(?:\/|$))/.test(url.pathname)||/token|secret|credential|code|key/i.test(url.search+url.hash)){finish('error');return;}
        finish('completed');window.location.assign(value);return;
      }
      if(result.status!=='pending'){finish('error');return;}
      if(result.deepLink){
        const link=new URL(result.deepLink);
        if(link.protocol!=='zkproofport:'||link.hostname!=='proof-request'){finish('error');return;}
        setDeepLink(result.deepLink);
        const image=await import('qrcode').then(module=>module.toDataURL(result.deepLink,{width:280,margin:2}));
        if(!active.current||!mounted.current)return;setQr(image);
      }
      timer.current=setTimeout(poll,2000);
    }catch{if(active.current&&mounted.current)finish('error');}
  }
  function approve(){if(active.current)return;active.current=true;deadline.current=Date.now()+600000;expiryTimer.current=setTimeout(()=>finish('expired'),600000);setStatus('pending');void poll();}
  async function decline(){
    active.current=false;clearTimeout(timer.current);clearTimeout(expiryTimer.current);
    const value=credentials.current;
    if(value){try{await apiFetch(`/api/auth/cli-login/${encodeURIComponent(value.loginId)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({approvalToken:value.approvalToken,cancel:true}),cache:'no-store',referrerPolicy:'no-referrer'});}catch{/* local cancellation still stops polling */}}
    finish('cancelled');
  }
  return <main style={{minHeight:'100dvh',background:'var(--color-bg-primary)',color:'var(--color-text-primary)',padding:'var(--space-5)'}}>
    <header style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'var(--space-3)',maxWidth:900,margin:'0 auto'}}>
      <a href="/" style={{fontWeight:700,textDecoration:'none',color:'inherit'}}>OpenStoa</a>
      <div style={{display:'flex',alignItems:'center',gap:'var(--space-2)'}}><LocaleSwitcher/><ThemeToggle/></div>
    </header>
    <section aria-labelledby="cli-login-title" style={{maxWidth:560,margin:'var(--space-7) auto',padding:'var(--space-5)',border:'1px solid var(--color-border-default)',borderRadius:'var(--radius-modal)',textAlign:'center'}}>
      <h1 id="cli-login-title" style={{fontSize:'var(--text-heading-lg)',fontWeight:700,lineHeight:1.3,margin:'0 0 var(--space-4)'}}>{t('cliLogin.title')}</h1>
      <p style={{lineHeight:1.7,color:'var(--color-text-secondary)',margin:'0 0 var(--space-4)'}}>{t('cliLogin.description')}</p>
      <p role="status" aria-live="polite" style={{lineHeight:1.7,margin:'var(--space-4) 0'}}>{t(`cliLogin.${status}`)}</p>
      {status==='consent'&&<div style={{display:'flex',justifyContent:'center',gap:'var(--space-3)',flexWrap:'wrap',marginTop:'var(--space-5)'}}>
        <button type="button" className="os-button os-button-primary" onClick={approve}>{t('cliLogin.approve')}</button>
        <button type="button" className="os-button" onClick={()=>void decline()}>{t('cliLogin.decline')}</button>
      </div>}
      {status==='pending'&&<>
        {qr?<img src={qr} alt={t('proofGate.qrAlt')} width={280} height={280} style={{display:'block',maxWidth:'100%',height:'auto',margin:'var(--space-4) auto'}}/>:<Spinner/>}
        {deepLink&&<p><a className="os-button os-button-primary" href={deepLink}>{t('proofGate.openInApp')}</a></p>}
        <button type="button" className="os-button" onClick={()=>void decline()}>{t('cliLogin.decline')}</button>
      </>}
    </section>
  </main>;
}
