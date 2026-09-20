import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fmtValue } from './format';
import type { Commands, ProofWorkflowResult, TopicProofOptions } from '@masselabs/openstoa-commands';

/** Terminal capabilities are injectable; machine callers never use prompts. */
export interface ProofTerminal {
  isTTY(): boolean;
  ask(question: string): Promise<string>;
  write(text: string): void;
  sleep(ms: number): Promise<void>;
  openBrowser(url: string): Promise<void>;
}

const exec = promisify(execFile);
export const defaultProofTerminal: ProofTerminal = {
  isTTY: () => !!process.stdin.isTTY && !!process.stderr.isTTY,
  write: text => { process.stderr.write(text + '\n'); },
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  ask: question => new Promise(resolve => {
    const reader = createInterface({ input: process.stdin, output: process.stderr });
    let answered = false;
    const finish = (answer: string) => {
      if (answered) return;
      answered = true;
      reader.close();
      resolve(answer.trim());
    };
    reader.once('SIGINT', () => finish('cancel'));
    reader.once('close', () => finish('cancel'));
    reader.question(question, finish);
  }),
  async openBrowser(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Unsupported proof browser URL');
    const commands: Record<string, string> = { darwin: 'open', linux: 'xdg-open', win32: 'explorer.exe' };
    const command = commands[process.platform];
    if (!command) throw new Error(`No browser launcher for ${process.platform}`);
    await exec(command, [url.href], { timeout: 10_000 });
  },
};

export function formatProofWorkflow(state: ProofWorkflowResult): string {
  const lines = [`Proof operation ${state.operationId}: ${state.status}`, state.message];
  if (state.requiredInputs?.length) lines.push(`Required inputs: ${state.requiredInputs.join(', ')}`);
  if (state.browserUrl) lines.push(`App QR page: ${state.browserUrl}`);
  if (state.verificationUrl) lines.push(`Verification URL: ${state.verificationUrl}`);
  if (state.userCode) lines.push(`User code: ${state.userCode}`);
  if (state.deepLink && !state.browserUrl) lines.push(`Open in ZKProofport: ${state.deepLink}`);
  if (state.status === 'completed') lines.push(fmtValue(state.result));
  return lines.filter(Boolean).join('\n');
}

/** Poll the existing operation only; the core owns replay and authentication. */
export async function waitForProof(
  commands: Commands,
  initial: ProofWorkflowResult,
  terminal: ProofTerminal,
  options: { openBrowser?: boolean } = {},
): Promise<ProofWorkflowResult> {
  let state = initial;
  const shown = new Set<string>();
  const opened = new Set<string>();
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; };
  process.on('SIGINT', onInterrupt);
  try {
    while (state.status === 'pending' || state.status === 'proof_ready') {
      if (interrupted) return commands.proofCancel(state.operationId);
      const details = formatProofWorkflow(state);
      if (!shown.has(details)) { terminal.write(details); shown.add(details); }
      const browserUrl = state.browserUrl ?? state.verificationUrl;
      if (browserUrl && options.openBrowser !== false && terminal.isTTY() && !opened.has(browserUrl)) {
        opened.add(browserUrl);
        try { await terminal.openBrowser(browserUrl); }
        catch { terminal.write('Open the URL above in your browser to continue.'); }
      }
      if (interrupted) return commands.proofCancel(state.operationId);
      if (state.status === 'proof_ready') return commands.proofResume(state.operationId);
      await terminal.sleep(state.pollAfterMs);
      if (interrupted) return commands.proofCancel(state.operationId);
      state = await commands.proofStatus(state.operationId);
    }
    return state;
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}

/** Consent is gathered only at a human terminal, never inferred from a 402. */
export async function interactWithProof(
  commands: Commands,
  state: ProofWorkflowResult,
  terminal: ProofTerminal,
  options: TopicProofOptions = {},
): Promise<ProofWorkflowResult> {
  terminal.write(formatProofWorkflow(state));
  const consent = (await terminal.ask('Generate this proof and finish the original action? [y/N] ')).toLowerCase();
  if (consent !== 'y' && consent !== 'yes') return commands.proofCancel(state.operationId);
  const method = options.method ?? (await terminal.ask(`Proof method (${state.methods.join('/')}; cancel to stop): `)).toLowerCase();
  if ((method !== 'app' && method !== 'ai') || !state.methods.includes(method)) {
    return commands.proofCancel(state.operationId);
  }
  let provider = options.provider ?? state.provider;
  if (state.requirement.type === 'workspace' && !provider) {
    const answer = (await terminal.ask('Account provider (google/microsoft; cancel to stop): ')).toLowerCase();
    if (answer !== 'google' && answer !== 'microsoft') return commands.proofCancel(state.operationId);
    provider = answer;
  }
  const started = await commands.proofContinue({ operationId: state.operationId, method, approved: true, ...(provider ? { provider } : {}) });
  return waitForProof(commands, started, terminal);
}
