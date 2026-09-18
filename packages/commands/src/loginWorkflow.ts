import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {OpenStoaClient} from '@masselabs/openstoa';
import {startAiTopicProof,type AiTopicProofHandle} from './aiTopicProof';
import type {SessionStore,PendingLogin} from './session';
export interface AuthenticateInput {method?:'app'|'ai';approved?:boolean;operationId?:string;cancel?:boolean;redirectUrl?:string;}
export interface AuthenticateResult {
  status:'consent_required'|'pending'|'authenticated'|'cancelled'|'expired'|'failed';
  operationId?:string;message:string;browserUrl?:string;verificationUrl?:string;userCode?:string;
  expiresAt?:number;pollAfterMs:number;userId?:string;nickname?:string;isAI?:boolean;
}
interface Deps {rest:OpenStoaClient;baseUrl:string;store:SessionStore;prover?:typeof startAiTopicProof;adopt:(token:string,guard:()=>Promise<void>)=>Promise<{userId:string;nickname:string;isAI?:boolean}>;}
export class LoginWorkflow {
  private handles=new Map<string,AiTopicProofHandle>();
  constructor(private deps:Deps){}
  async run(input:AuthenticateInput={}):Promise<AuthenticateResult>{
    const {rest,store,baseUrl}=this.deps;
    if(input.method!==undefined&&!['app','ai'].includes(input.method))throw new Error('Unknown login method');
    if(input.operationId!==undefined&&!/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId))throw new Error('Invalid login operationId');
    let pending=(await store.read())?.pendingLogin;
    const fingerprint=()=>createHash('sha256').update(rest.getToken()??'').digest('hex');
    const guard=async()=>{
      const latest=(await store.read())?.pendingLogin;
      if(!pending||latest?.operationId!==pending.operationId||pending.expiresAt<=Date.now())throw new Error('Login was cancelled or expired');
      if(pending.credentialFingerprint!==fingerprint())throw new Error('Credentials changed after this login started; the current session was kept.');
    };
    if(input.operationId!==undefined){
      if(!pending||pending.operationId!==input.operationId)throw new Error('Unknown login operation; use the same local vault.');
      if(pending.baseUrl!==baseUrl)throw new Error('Login belongs to another server');
      if(pending.expiresAt<=Date.now()){this.handles.get(pending.operationId)?.cancel();this.handles.delete(pending.operationId);await store.clear();return {status:'expired',operationId:pending.operationId,message:'Start a new login when ready.',pollAfterMs:2000};}
      if(input.cancel){
        await store.clear();
        if(pending.method==='app')await rest.request(`/api/auth/cli-login/${pending.operationId}`,{method:'POST',body:{codeVerifier:pending.codeVerifier,cancel:true}});
        this.handles.get(pending.operationId)?.cancel();this.handles.delete(pending.operationId);
        return {status:'cancelled',operationId:pending.operationId,message:'Login cancelled. Existing credentials were kept.',pollAfterMs:2000};
      }
      await guard();
      if(pending.method==='app'){
        const response=await rest.request<{status:string;token?:string}>(`/api/auth/cli-login/${pending.operationId}`,{method:'POST',body:{codeVerifier:pending.codeVerifier}});
        if(response.status==='completed'){
          if(typeof response.token!=='string'||!response.token.trim())throw new Error('Login completed without a session token');
          const identity=await this.deps.adopt(response.token,guard);await store.clear();
          return {status:'authenticated',operationId:pending.operationId,...identity,message:'Logged in. Session saved locally.',pollAfterMs:2000};
        }
        if(response.status==='cancelled'){await store.clear();return {status:'cancelled',operationId:pending.operationId,message:'Login cancelled.',pollAfterMs:2000};}
        if(response.status!=='pending')throw new Error('Unexpected login status');
      }else{
        const handle=this.handles.get(pending.operationId);
        if(!handle){await store.clear();return {status:'failed',operationId:pending.operationId,message:'The AI login process ended. Start a new approved login; use app mode to continue across CLI runs.',pollAfterMs:2000};}
        const state=handle.status();
        if(state.status==='failed'||state.status==='cancelled'){
          await store.clear();this.handles.delete(pending.operationId);
          return {status:state.status,operationId:pending.operationId,message:state.error??'Login cancelled.',pollAfterMs:2000};
        }
        if(state.status==='completed'){
          const proof=await handle.wait();
          // A challenge exchange is one-shot; do not automatically replay after an ambiguous failure.
          this.handles.delete(pending.operationId);
          const result=await rest.request<{token?:string}>('/api/auth/verify/ai',{method:'POST',body:{challengeId:pending.challengeId,result:proof.loginResult}});
          if(!result.token)throw new Error('Login verification returned no session');
          const identity=await this.deps.adopt(result.token,guard);await store.clear();
          return {status:'authenticated',operationId:pending.operationId,...identity,message:'Logged in. Session saved locally.',pollAfterMs:2000};
        }
        return {...this.view(pending),verificationUrl:state.verificationUrl,userCode:state.userCode};
      }
      return this.view(pending);
    }
    if(input.cancel)throw new Error('operationId is required to cancel login');
    if(input.approved!==true)return {status:'consent_required',message:'Approve signing this CLI/MCP into your account. Choose app (mobile QR) or ai (Google device authorization; external charges may apply). After login, select an owner-issued permission key for business operations.',pollAfterMs:2000};
    if(pending && pending.expiresAt>Date.now())throw new Error(`A login is already pending. Resume or cancel operation ${pending.operationId}.`);
    const method=input.method??'app';
    if(method==='app'){
      const codeVerifier=randomBytes(32).toString('base64url');
      const result=await rest.request<{loginId:string;browserUrl:string;expiresAt:number|string}>('/api/auth/cli-login',{method:'POST',body:{codeChallenge:createHash('sha256').update(codeVerifier).digest('base64url'),...(input.redirectUrl?{redirect_url:input.redirectUrl}:{})}});
      const expiresAt=typeof result.expiresAt==='number'?result.expiresAt:Date.parse(result.expiresAt);
      const url=new URL(result.browserUrl);
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(result.loginId)||url.origin!==new URL(baseUrl).origin||url.pathname!=='/login'||!Number.isFinite(expiresAt)||expiresAt<=Date.now())throw new Error('Invalid login handoff from server');
      pending={operationId:result.loginId,method,baseUrl,codeVerifier,browserUrl:result.browserUrl,expiresAt};
    }else{
      if(input.redirectUrl)throw new Error('redirectUrl is supported by app login only');
      const challenge=await rest.request<{challengeId:string;scope:string;expiresIn:number}>('/api/auth/challenge',{method:'POST',body:{purpose:'login'}});
      if(!challenge.challengeId||challenge.scope!=='zkproofport-community')throw new Error('Invalid login challenge');
      const handle=(this.deps.prover??startAiTopicProof)({proofType:'google_login',scope:challenge.scope,consent:true});
      pending={operationId:randomUUID(),method,baseUrl,expiresAt:Date.now()+Math.min(challenge.expiresIn||300,600)*1000,challengeId:challenge.challengeId};
      this.handles.set(pending.operationId,handle);
    }
    pending.credentialFingerprint=fingerprint();
    await store.write({baseUrl,pendingLogin:pending});return this.view(pending);
  }
  private view(pending:PendingLogin):AuthenticateResult{return {status:'pending',operationId:pending.operationId,browserUrl:pending.browserUrl,expiresAt:pending.expiresAt,pollAfterMs:2000,message:'Complete the proof approval, then resume this same login operation.'};}
}
