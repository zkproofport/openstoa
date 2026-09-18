'use client';

import {useEffect, useRef, useState} from 'react';
import {keccak256, toUtf8Bytes} from 'ethers';
import {apiFetch} from '@/lib/apiFetch';
import {parseHumanProofFragment, HUMAN_PROOF_CIRCUITS, type HumanProofRequest} from '@/lib/humanProofFragment';
import {useTranslation} from '@/lib/i18n/I18nProvider';
import LocaleSwitcher from '@/components/LocaleSwitcher';
import ThemeToggle from '@/components/ThemeToggle';
import Spinner from '@/components/Spinner';

type State = 'loading' | 'active' | 'invalid' | 'completed' | 'cancelled' | 'expired' | 'failed' | 'stopped';

export default function HumanProofPage({relayOrigin}: {relayOrigin: string}) {
  const {t} = useTranslation();
  const [request,setRequest] = useState<HumanProofRequest|null>(null);
  const [state,setState] = useState<State>('loading');
  const [qr,setQr] = useState<string|null>(null);
  const stopRef = useRef<()=>void>(()=>{});
  useEffect(()=> {
    const parsed = parseHumanProofFragment(window.location.hash, relayOrigin);
    if (!parsed) { setState('invalid'); return; }
    setRequest(parsed);
    setState('active');
    let stopped=false;
    let next:ReturnType<typeof setTimeout>|undefined;
    let deadline:ReturnType<typeof setTimeout>|undefined;
    const controller=new AbortController();
    const stop=()=>{stopped=true; clearTimeout(next); clearTimeout(deadline); controller.abort();};
    stopRef.current=stop;
    const finish=(value:State)=>{if(!stopped){stop();setState(value);}};
    deadline=setTimeout(()=>finish('expired'),6*60*1000);
    void import('qrcode').then(QRCode=>QRCode.toDataURL(parsed.deepLink,{
      width:280,margin:2,color:{dark:'#000000',light:'#ffffff'},
    })).then(url=>{if(!stopped)setQr(url);}).catch(()=>finish('failed'));
    const poll=async()=>{
      try {
        // This page has no API key/session dependency and never calls login-mode polling.
        const response=await apiFetch(`/api/auth/poll/${encodeURIComponent(parsed.requestId)}?mode=proof`,{
          credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal,
        });
        if(stopped)return;
        if(response.status===404 || response.status===410){finish('expired');return;}
        if(response.ok){
          const data=await response.json();
          if(stopped)return;
          if(data.status==='completed'){
            const expected=keccak256(toUtf8Bytes(parsed.scope));
            finish(data.circuit===parsed.circuitType && typeof data.scopeHash==='string' && data.scopeHash.toLowerCase()===expected.toLowerCase() ? 'completed':'failed');
            return;
          }
          if(data.status==='cancelled'||data.status==='expired'||data.status==='failed'){finish(data.status);return;}
          if(data.status!=='pending'&&data.status!=='processing'){finish('failed');return;}
        } else if(response.status<500){finish('failed');return;}
      } catch { /* Transport failures retry until the bounded request lifetime ends. */ }
      if(!stopped)next=setTimeout(poll,2000);
    };
    void poll();
    return stop;
  },[relayOrigin]);

  return <main style={{minHeight:'100dvh',background:'var(--background)',color:'var(--foreground)',padding:'var(--space-5)'}}>
    <header style={{maxWidth:640,margin:'0 auto',display:'flex',alignItems:'center',justifyContent:'space-between',gap:'var(--space-3)'}}>
      <a href="/" style={{fontWeight:700,color:'var(--foreground)',textDecoration:'none'}}>OpenStoa</a>
      <div style={{display:'flex',gap:'var(--space-2)',alignItems:'center'}}><LocaleSwitcher/><ThemeToggle/></div>
    </header>
    <section style={{maxWidth:520,margin:'var(--space-7) auto',padding:'var(--space-5)',border:'1px solid var(--border)',borderRadius:'var(--radius-modal)',background:'var(--color-bg-primary)',textAlign:'center'}}>
      <p style={{fontSize:'var(--text-label)',color:'var(--muted)',margin:0}}>{t('humanProof.eyebrow')}</p>
      <h1 style={{fontSize:'var(--text-heading-lg)',lineHeight:1.2,margin:'var(--space-3) 0'}}>{t('humanProof.title')}</h1>
      {request && <p style={{fontWeight:600}}>{t(HUMAN_PROOF_CIRCUITS[request.circuitType])}</p>}
      <div role="status" aria-live="polite">
        {state==='loading' ? <Spinner/> : state==='active' ? <>
          <p style={{color:'var(--muted)',lineHeight:1.6}}>{t('humanProof.instructions')}</p>
          {qr ? <img src={qr} alt={t('proofGate.qrAlt')} width={280} height={280} style={{display:'block',maxWidth:'100%',height:'auto',margin:'var(--space-4) auto',borderRadius:'var(--radius-control)'}}/> : <Spinner/>}
          <a href={request!.deepLink} style={{display:'block',background:'var(--accent)',color:'var(--color-text-inverted)',padding:'var(--space-3) var(--space-4)',borderRadius:'var(--radius-control)',fontWeight:600,textDecoration:'none'}}>{t('proofGate.openInApp')}</a>
          <p style={{fontSize:'var(--text-body-sm)',color:'var(--muted)',lineHeight:1.6}}>{t('humanProof.scopePurpose')}</p>
          <p style={{fontSize:'var(--text-body-sm)'}}>{t('proofGate.waitingForProof')}</p>
          <button type="button" onClick={()=>{stopRef.current();setState('stopped');}} style={{background:'none',border:'none',color:'var(--muted)',cursor:'pointer',padding:'var(--space-3)',textDecoration:'underline'}}>{t('humanProof.stop')}</button>
        </> : <p style={{lineHeight:1.7,padding:'var(--space-4) 0'}}>{t(`humanProof.${state}`)}</p>}
      </div>
      <p style={{fontSize:'var(--text-label)',color:'var(--muted)',lineHeight:1.6,borderTop:'1px solid var(--border)',paddingTop:'var(--space-4)'}}>{t('humanProof.privacy')}</p>
    </section>
  </main>;
}
