/**
 * Consent-gated adapter for the installed @zkproofport-ai/mcp prove.js protocol.
 * Device prompts come from stderr even with --silent; stdout is one JSON proof.
 * Nothing is persisted. Raw output, JWTs, private keys, and upstream error text
 * never leave this module. The server remains the cryptographic verifier.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export type AiTopicProofType = 'google_login' | 'kyc' | 'country' | 'google_workspace' | 'microsoft_365' | 'workspace';
export interface AiTopicProofInput {
  proofType: AiTopicProofType;
  scope: string;
  countries?: readonly string[];
  provider?: 'google' | 'microsoft';
  consent: true;
}
export interface AiTopicProofResult { proof: string; publicInputs: string; loginResult?: Record<string,unknown>; }
export interface AiTopicProofStatus {
  status: 'starting' | 'awaiting_authorization' | 'proving' | 'completed' | 'failed' | 'cancelled';
  verificationUrl?: string;
  userCode?: string;
  error?: string;
  code?: string;
}
export interface AiTopicProofHandle {
  status(): AiTopicProofStatus;
  wait(): Promise<AiTopicProofResult>;
  cancel(): void;
}
export class AiTopicProofError extends Error {
  constructor(public readonly code: string, message: string, public readonly requiredInputs?: string[]) {
    super(message);
    this.name = 'AiTopicProofError';
  }
}
interface DataStream { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown; }
export interface AiProverProcess {
  stdout: DataStream | null;
  stderr: DataStream | null;
  pid?: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}
export interface AiTopicProofDeps {
  env?: NodeJS.ProcessEnv;
  spawn?: (args: string[], env: NodeJS.ProcessEnv) => AiProverProcess;
  terminate?: (child: AiProverProcess) => void;
  timeoutMs?: number;
  deviceTimeoutMs?: number;
}
const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_STDERR_LINE = 4096;
const INPUT_COUNTS: Record<AiTopicProofType, number> = {
  google_login:148, kyc: 128, country: 150, google_workspace: 148, microsoft_365: 148, workspace: 148,
};
const CHILD_ENV_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'APPDATA',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'ATTESTATION_KEY', 'PROOFPORT_URL',
] as const;

function requestArgs(input: AiTopicProofInput, env: NodeJS.ProcessEnv): {args: string[]; provider?: 'google' | 'microsoft'} {
  if (!input || input.consent !== true) throw new AiTopicProofError('consent_required', 'Explicit consent is required before contacting an external prover; external charges may apply.');
  if (!Object.hasOwn(INPUT_COUNTS, input.proofType)) throw new AiTopicProofError('invalid_request', 'Unsupported topic proof type.');
  if (typeof input.scope !== 'string' || input.scope.length > 512 || !(input.proofType==='google_login' ? input.scope==='zkproofport-community' : /^zkproofport-community:topic:[A-Za-z0-9:_-]+$/.test(input.scope))) {
    throw new AiTopicProofError('invalid_request', 'Get an account-bound topic scope from an authenticated OpenStoa challenge first.');
  }
  let args: string[];
  let provider: 'google' | 'microsoft' | undefined;
  if(input.proofType==='google_login'){
    if(input.provider && input.provider!=='google')throw new AiTopicProofError('invalid_request','Google login requires the Google provider.');
    args=['--login-google'];provider='google';
  } else if (input.proofType === 'kyc' || input.proofType === 'country') {
    if (!env.ATTESTATION_KEY?.trim()) {
      throw new AiTopicProofError('missing_inputs', 'Configure ATTESTATION_KEY in the local CLI/MCP process environment for a Coinbase-attested wallet. Never send the key as a command or tool argument. Alternatively use the mobile-app proof flow.', ['ATTESTATION_KEY']);
    }
    args = ['coinbase_kyc'];
    if (input.proofType === 'country') {
      if (!Array.isArray(input.countries) || input.countries.length < 1 || input.countries.length > 10
        || input.countries.some(value => typeof value !== 'string' || !/^[A-Za-z]{2}$/.test(value))) {
        throw new AiTopicProofError('invalid_request', 'Country proof requires 1–10 two-letter country codes from the topic requirement.');
      }
      args = ['coinbase_country', '--countries', [...new Set(input.countries.map(value => value.toUpperCase()))].join(','), '--included', 'true'];
    }
  } else {
    const providers: Partial<Record<AiTopicProofType, 'google' | 'microsoft'>> = {
      google_workspace: 'google', microsoft_365: 'microsoft',
    };
    provider = providers[input.proofType] ?? input.provider;
    if ((provider !== 'google' && provider !== 'microsoft') || (input.provider && input.provider !== provider)) {
      throw new AiTopicProofError('invalid_request', 'Choose Google or Microsoft for a generic workspace proof; provider-specific topics require their named provider.');
    }
    args = [provider === 'google' ? '--login-google-workspace' : '--login-microsoft-365'];
  }
  return {args: [...args, '--scope', input.scope, '--silent'], provider};
}

/** Resolve, never import, prove.js: importing it would run its CLI in our process. */
export function resolveAiTopicProverPath(): string {
  try {
    const base = import.meta.url || (typeof __filename === 'string' ? pathToFileURL(__filename).href : pathToFileURL(process.argv[1] || `${process.cwd()}/index.js`).href);
    return createRequire(base).resolve('@zkproofport-ai/mcp/dist/prove.js');
  } catch {
    throw new AiTopicProofError('missing_dependency', 'The AI proof dependency @zkproofport-ai/mcp is unavailable. Reinstall the OpenStoa CLI/MCP package or choose the mobile-app proof flow.');
  }
}
export function spawnAiTopicProver(args: string[], env: NodeJS.ProcessEnv): AiProverProcess {
  return nodeSpawn(process.execPath, [resolveAiTopicProverPath(), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], env, shell: false,
    // prove.js launches an MCP subprocess; cancelling only its parent would
    // leave that prover client alive. Keep this operation in its own group.
    detached: process.platform !== 'win32',
  });
}
function terminateProver(child: AiProverProcess): void {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else if (child.pid) {
      const killer = nodeSpawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {stdio:'ignore', shell:false});
      killer.on('error', () => { child.kill('SIGKILL'); });
    } else child.kill('SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* Already exited. */ } }
}

// Hooks exist only while this adapter owns a live child. Preserve the host's
// existing signal policy; otherwise restore the normal terminating signal.
const activeProvers = new Set<() => void>();
function onProcessExit(): void { for (const cancel of [...activeProvers]) cancel(); }
function onProcessSignal(signal: 'SIGINT' | 'SIGTERM'): void {
  const own = signal === 'SIGINT' ? onSigint : onSigterm;
  const hostHandlesSignal = process.listeners(signal).some(listener => listener !== own);
  onProcessExit();
  if (!hostHandlesSignal) process.kill(process.pid, signal);
}
function onSigint(): void { onProcessSignal('SIGINT'); }
function onSigterm(): void { onProcessSignal('SIGTERM'); }
function registerProcessCleanup(cancel: () => void): () => void {
  if (activeProvers.size === 0) {
    process.on('exit', onProcessExit);
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }
  activeProvers.add(cancel);
  return () => {
    activeProvers.delete(cancel);
    if (activeProvers.size === 0) {
      process.removeListener('exit', onProcessExit);
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    }
  };
}

function validDeviceUrl(raw: string, provider: 'google' | 'microsoft'): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
    const allowed: Record<'google' | 'microsoft', readonly string[]> = {
      google: ['google.com/device', 'www.google.com/device'],
      microsoft: ['microsoft.com/devicelogin', 'www.microsoft.com/devicelogin', 'login.microsoftonline.com/common/oauth2/deviceauth'],
    };
    return allowed[provider].includes(url.hostname + url.pathname.replace(/\/$/, '')) ? url.toString() : null;
  } catch { return null; }
}
function outputResult(stdout: string, type: AiTopicProofType): AiTopicProofResult {
  try {
    const result = JSON.parse(stdout) as Record<string,unknown> & {proof?: unknown; publicInputs?: unknown};
    const count = INPUT_COUNTS[type];
    if (typeof result.proof !== 'string' || result.proof.length > 131074 || !/^0x(?:[0-9a-fA-F]{2})+$/.test(result.proof)) throw new Error();
    let publicInputs: string;
    if (Array.isArray(result.publicInputs) && result.publicInputs.length === count
      && result.publicInputs.every(value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value))) {
      publicInputs = '0x' + result.publicInputs.map(value => (value as string).slice(2)).join('');
    } else if (typeof result.publicInputs === 'string' && new RegExp(`^0x[0-9a-fA-F]{${count * 64}}$`).test(result.publicInputs)) {
      publicInputs = result.publicInputs;
    } else throw new Error();
    return {proof: result.proof, publicInputs,...(type==='google_login'?{loginResult:{proof:result.proof,publicInputs,proofType:'google_login',verification:result.verification ?? {},paymentTxHash:result.paymentTxHash,attestation:result.attestation}}:{})};
  } catch { throw new AiTopicProofError('invalid_output', 'The external prover returned incomplete or malformed proof output. No topic action was resumed.'); }
}

export function startAiTopicProof(input: AiTopicProofInput, deps: AiTopicProofDeps = {}): AiTopicProofHandle {
  const sourceEnv = deps.env ?? process.env;
  const {args, provider} = requestArgs(input, sourceEnv);
  const env: NodeJS.ProcessEnv = {ZKPROOFPORT_SILENT:'1'};
  for (const key of CHILD_ENV_KEYS) if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  // OIDC uses an ephemeral signer. Do not hand it an unrelated Coinbase key.
  if (provider) delete env.ATTESTATION_KEY;
  const timeoutMs = deps.timeoutMs ?? 7 * 60 * 1000;
  const deviceTimeoutMs = deps.deviceTimeoutMs ?? 30 * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(deviceTimeoutMs) || deviceTimeoutMs <= 0) {
    throw new AiTopicProofError('invalid_request', 'Proof timeout must be a positive finite duration.');
  }
  let child: AiProverProcess;
  try { child = (deps.spawn ?? spawnAiTopicProver)(args, env); }
  catch (error) {
    if (error instanceof AiTopicProofError) throw error;
    throw new AiTopicProofError('process_failed', 'The external prover process could not start. Check the local Node and prover installation.');
  }
  let snapshot: AiTopicProofStatus = {status: provider ? 'starting' : 'proving'};
  let terminal = false;
  let stdout = '';
  let lineBuffer = '';
  let stderrBytes = 0;
  let stdoutBytes = 0;
  let verificationUrl: string | undefined;
  let userCode: string | undefined;
  let failureHint: AiTopicProofError | undefined;
  let resolve!: (proof: AiTopicProofResult) => void;
  let reject!: (error: AiTopicProofError) => void;
  const result = new Promise<AiTopicProofResult>((yes, no) => { resolve = yes; reject = no; });
  // MCP can poll status without awaiting yet. A rejected operation must not
  // become an unhandled promise rejection while awaiting the next tool call.
  void result.catch(() => {});
  let overallTimer: ReturnType<typeof setTimeout> | undefined;
  let deviceTimer: ReturnType<typeof setTimeout> | undefined;
  let unregisterCleanup: (() => void) | undefined;
  function cleanup(): void {
    unregisterCleanup?.();
    clearTimeout(overallTimer); clearTimeout(deviceTimer);
    stdout = ''; lineBuffer = ''; verificationUrl = undefined; userCode = undefined;
  }
  function fail(error: AiTopicProofError, stop = true): void {
    if (terminal) return;
    terminal = true;
    snapshot = error.code === 'cancelled' ? {status:'cancelled'} : {status:'failed',code:error.code,error:error.message};
    cleanup();
    if (stop) { try { (deps.terminate ?? terminateProver)(child); } catch { /* No upstream details. */ } }
    reject(error);
  }
  function processLine(line: string): void {
    if (line.includes('deleted_client') || line.includes('invalid_client')) failureHint = new AiTopicProofError('oauth_unavailable', 'The external prover OAuth client is unavailable. Choose the mobile-app proof flow or ask the prover operator to restore its OAuth client.');
    else if (line.includes('access_denied') || line.includes('authorization_declined') || line.includes('User denied the authorization request')) failureHint = new AiTopicProofError('authorization_denied', 'Identity-provider authorization was declined.');
    else if (/expired_token|Device code expired|Device code flow timed out/.test(line)) failureHint = new AiTopicProofError('authorization_expired', 'The identity-provider device authorization expired. Start a new proof operation when ready to authorize.');
    else if (/payment|required.*402|insufficient.*fund/i.test(line)) failureHint = new AiTopicProofError('payment_required', 'The external prover requires payment or additional funding. This installed prover adapter cannot authorize additional payment; use the mobile-app proof flow or configure a compatible prover.');
    else if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET/.test(line)) failureHint = new AiTopicProofError('prover_unavailable', 'The external prover or identity provider is unavailable. Choose the mobile-app proof flow or retry after the service is restored.');
    if (!provider) return;
    const open = /^\s*Open:\s*(\S+)\s*$/.exec(line);
    if (open) {
      const url = validDeviceUrl(open[1], provider);
      if (!url) return fail(new AiTopicProofError('invalid_device_prompt', 'The prover returned an unexpected identity-provider device URL.'));
      verificationUrl = url;
    }
    const code = /^\s*Code:\s*(\S+)\s*$/.exec(line);
    if (code) {
      if (!/^[A-Za-z0-9-]{4,32}$/.test(code[1])) return fail(new AiTopicProofError('invalid_device_prompt', 'The prover returned an invalid device code.'));
      userCode = code[1];
    }
    if (verificationUrl && userCode) {
      clearTimeout(deviceTimer);
      snapshot = {status:'awaiting_authorization', verificationUrl, userCode};
    }
    if (line.includes('Authorization successful!')) {
      clearTimeout(deviceTimer);
      verificationUrl = undefined; userCode = undefined;
      snapshot = {status:'proving'};
    }
  }
  child.stdout?.on('data', chunk => {
    if (terminal) return;
    const text = String(chunk);
    stdoutBytes += Buffer.byteLength(text);
    if (stdoutBytes > MAX_STDOUT_BYTES) return fail(new AiTopicProofError('output_limit', 'External prover output exceeded the allowed size limit.'));
    stdout += text;
  });
  child.stderr?.on('data', chunk => {
    if (terminal) return;
    const text = String(chunk);
    stderrBytes += Buffer.byteLength(text);
    if (stderrBytes > MAX_STDERR_BYTES) return fail(new AiTopicProofError('output_limit', 'External prover output exceeded the allowed size limit.'));
    lineBuffer += text;
    let newline: number;
    while (!terminal && (newline = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, newline).replace(/\r$/, '');
      lineBuffer = lineBuffer.slice(newline + 1);
      if (line.length > MAX_STDERR_LINE) return fail(new AiTopicProofError('output_limit', 'External prover output exceeded the allowed size limit.'));
      processLine(line);
    }
    if (lineBuffer.length > MAX_STDERR_LINE) fail(new AiTopicProofError('output_limit', 'External prover output exceeded the allowed size limit.'));
  });
  child.on('error', () => fail(new AiTopicProofError('process_failed', 'The external prover process failed to start or run.')));
  child.on('close', (code: number | null) => {
    if (terminal) return;
    if (lineBuffer) processLine(lineBuffer);
    if (terminal) return;
    if (code !== 0) return fail(failureHint ?? new AiTopicProofError('prover_failed', 'External proof generation failed. Check the prover configuration or choose the mobile-app proof flow.'), false);
    try {
      const proof = outputResult(stdout, input.proofType);
      terminal = true; snapshot = {status:'completed'}; cleanup(); resolve(proof);
    } catch (error) { fail(error as AiTopicProofError, false); }
  });
  overallTimer = setTimeout(() => fail(new AiTopicProofError('timeout', 'External proof generation timed out. Remote work already submitted cannot be recalled.')), timeoutMs);
  if (provider) deviceTimer = setTimeout(() => fail(new AiTopicProofError('device_timeout', 'Timed out waiting for the identity-provider device prompt. Choose the mobile-app proof flow or retry after checking the external service.')), deviceTimeoutMs);
  unregisterCleanup = registerProcessCleanup(() => fail(new AiTopicProofError('cancelled', 'External proof generation was cancelled because the host process is stopping.')));
  return {
    status: () => ({...snapshot}),
    wait: () => result,
    cancel: () => fail(new AiTopicProofError('cancelled', 'External proof generation was cancelled.')),
  };
}
