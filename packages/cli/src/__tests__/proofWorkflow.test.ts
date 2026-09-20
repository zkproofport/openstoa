import { expect, it, vi } from 'vitest';
import type { Commands } from '@masselabs/openstoa-commands';
import { buildProgram } from '../cli';

const required = { status: 'proof_required', operationId: 'op1', requirement: { type: 'kyc', circuitType: 'coinbase_attestation' }, methods: ['app', 'ai'], expiresAt: '2099-01-01T00:00:00Z', message: 'KYC proof required', pollAfterMs: 1500 };
function harness(tty = false) {
  const commands = {
    topicJoin: vi.fn().mockResolvedValue(required),
    topicCreate: vi.fn().mockResolvedValue(required),
    executeOperation: vi.fn().mockResolvedValue(required),
    proofContinue: vi.fn().mockResolvedValue({ ...required, status: 'pending', method: 'app', browserUrl: 'https://openstoa.test/proof/op1' }),
    proofStatus: vi.fn().mockResolvedValue({ ...required, status: 'proof_ready' }),
    proofResume: vi.fn().mockResolvedValue({ ...required, status: 'completed', result: { topicId: 't1', joined: true } }),
    proofCancel: vi.fn().mockResolvedValue({ ...required, status: 'cancelled' }),
  };
  const out: string[] = [];
  const terminal = { isTTY: () => tty, ask: vi.fn().mockResolvedValueOnce('yes').mockResolvedValueOnce('app'), write: vi.fn(), sleep: vi.fn().mockResolvedValue(undefined), openBrowser: vi.fn().mockResolvedValue(undefined) };
  const program = buildProgram(async () => commands as unknown as Commands, text => out.push(text), terminal);
  const guardExit = (command: typeof program) => { command.exitOverride().configureOutput({ writeErr: () => {} }); command.commands.forEach(guardExit); };
  guardExit(program);
  return { commands, out, terminal, run: (args: string[]) => program.parseAsync(['node', 'openstoa', ...args]) };
}

it.each([['topics', 'join', 't1'], ['topics', 'join-invite', 'code'], ['topics', 'create', '--title', 'T', '--category-id', 'c1', '--proof-type', 'kyc']])('explicit JSON %j returns structured consent guidance without starting proof', async (...args) => {
  const h = harness();
  await h.run(['--json',...args]);
  expect(JSON.parse(h.out.join(''))).toEqual(required);
  expect(h.terminal.ask).not.toHaveBeenCalled();
  expect(h.commands.proofContinue).not.toHaveBeenCalled();
});
it('--json never prompts even on a terminal', async () => {
  const h = harness(true);
  await h.run(['--json', 'topics', 'join', 't1']);
  expect(JSON.parse(h.out.join(''))).toEqual(required);
  expect(h.terminal.ask).not.toHaveBeenCalled();
});
it('terminal consent starts the selected proof and resumes the original operation once', async () => {
  const h = harness(true);
  await h.run(['topics', 'join', 't1']);
  expect(h.commands.proofContinue).toHaveBeenCalledExactlyOnceWith({ operationId: 'op1', method: 'app', approved: true });
  expect(h.terminal.openBrowser).toHaveBeenCalledWith('https://openstoa.test/proof/op1');
  expect(h.commands.proofResume).toHaveBeenCalledExactlyOnceWith('op1');
  expect(h.commands.topicJoin).toHaveBeenCalledOnce();
  expect(h.out.join('')).toContain('Joined t1');
});
it('declining consent cancels without starting or retrying the original operation', async () => {
  const h = harness(true);
  h.terminal.ask.mockReset().mockResolvedValue('no');
  await h.run(['topics', 'join', 't1']);
  expect(h.commands.proofCancel).toHaveBeenCalledExactlyOnceWith('op1');
  expect(h.commands.proofContinue).not.toHaveBeenCalled();
  expect(h.commands.proofResume).not.toHaveBeenCalled();
});
it('terminal pending authorization failure never resumes', async () => {
  const h = harness(true);
  h.commands.proofStatus.mockResolvedValue({ ...required, status: 'failed', message: 'Authentication changed' });
  await h.run(['topics', 'join', 't1']);
  expect(h.commands.proofResume).not.toHaveBeenCalled();
  expect(h.out.join('')).toContain('Authentication changed');
});
it('explicit AI continuation requires --wait before starting a child', async () => {
  const h = harness();
  await expect(h.run(['proof', 'continue', 'op1', '--approved', '--method', 'ai'])).rejects.toThrow('--wait');
  expect(h.commands.proofContinue).not.toHaveBeenCalled();
});
it('explicit AI --wait prints device guidance outside JSON stdout without prompting or opening a browser even on a terminal', async () => {
  const h = harness(true);
  h.commands.proofContinue.mockResolvedValue({ ...required, status: 'pending', method: 'ai', verificationUrl: 'https://google.com/device', userCode: 'ABCD' });
  await h.run(['--json', 'proof', 'continue', 'op1', '--approved', '--method', 'ai', '--provider', 'google', '--wait']);
  expect(h.commands.proofContinue).toHaveBeenCalledWith({ operationId: 'op1', approved: true, method: 'ai', provider: 'google' });
  expect(h.terminal.write.mock.calls.flat().join('\n')).toContain('ABCD');
  expect(h.out).toHaveLength(1);
  expect(JSON.parse(h.out[0]).status).toBe('completed');
  expect(h.commands.proofResume).toHaveBeenCalledOnce();
  expect(h.terminal.ask).not.toHaveBeenCalled();
  expect(h.terminal.openBrowser).not.toHaveBeenCalled();
});
it('explicit continuation refuses missing consent before calling the core', async () => {
  const h = harness();
  await expect(h.run(['proof', 'continue', 'op1', '--method', 'app'])).rejects.toThrow('--approved');
  expect(h.commands.proofContinue).not.toHaveBeenCalled();
});
it('asks generic workspace users which provider to prove', async () => {
  const h = harness(true);
  h.commands.topicJoin.mockResolvedValue({ ...required, requirement: { type: 'workspace', circuitType: 'oidc_domain_attestation' } });
  h.terminal.ask.mockReset().mockResolvedValueOnce('yes').mockResolvedValueOnce('ai').mockResolvedValueOnce('microsoft');
  await h.run(['topics', 'join', 't1']);
  expect(h.commands.proofContinue).toHaveBeenCalledWith({ operationId: 'op1', method: 'ai', approved: true, provider: 'microsoft' });
});
it('shows missing environment inputs without another prompt or automatic retry', async () => {
  const h = harness(true);
  h.commands.proofContinue.mockResolvedValue({ ...required, requiredInputs: ['ATTESTATION_KEY'], message: 'Configure the attestation key in the environment.' });
  await h.run(['topics', 'join', 't1']);
  expect(h.out.join('')).toContain('ATTESTATION_KEY');
  expect(h.terminal.ask).toHaveBeenCalledTimes(2);
  expect(h.commands.proofStatus).not.toHaveBeenCalled();
  expect(h.commands.proofResume).not.toHaveBeenCalled();
});
it.each(['cancelled', 'expired', 'failed'])('stops when a pending proof becomes %s', async status => {
  const h = harness(true);
  h.commands.proofStatus.mockResolvedValue({ ...required, status });
  await h.run(['topics', 'join', 't1']);
  expect(h.commands.proofStatus).toHaveBeenCalledOnce();
  expect(h.commands.proofResume).not.toHaveBeenCalled();
});
it('Ctrl-C during the wait cancels the saved operation without resuming it', async () => {
  const h = harness(true);
  h.terminal.sleep.mockImplementation(async () => { process.emit('SIGINT'); });
  await h.run(['topics', 'join', 't1']);
  expect(h.commands.proofCancel).toHaveBeenCalledExactlyOnceWith('op1');
  expect(h.commands.proofResume).not.toHaveBeenCalled();
});
it.each([['status', 'proofStatus'], ['resume', 'proofResume'], ['cancel', 'proofCancel']] as const)('proof %s forwards the operation ID without implicit consent', async (command, method) => {
  const h = harness();
  await h.run(['--json', 'proof', command, 'op1']);
  expect(h.commands[method]).toHaveBeenCalledExactlyOnceWith('op1');
  expect(h.commands.proofContinue).not.toHaveBeenCalled();
  expect(h.terminal.ask).not.toHaveBeenCalled();
});

it.each([['topics','join','t1'],['topics','join-invite','code'],['topics','create','--title','T','--category-id','c1','--proof-type','kyc']])('non-TTY proof requirement without --json uses readable guidance (%j)',async(...args)=>{
 const h=harness(false);await h.run(args);
 const text=h.out.join('');expect(text).toContain('KYC proof required');expect(text).toContain('op1');expect(text.trim()).not.toMatch(/^[{[]/);
 expect(h.terminal.ask).not.toHaveBeenCalled();expect(h.commands.proofContinue).not.toHaveBeenCalled();
});
it('explicit proof resume without --json formats its completed payload as human text',async()=>{
 const h=harness(false);await h.run(['proof','resume','op1']);
 const text=h.out.join('');expect(text).toContain('completed');expect(text).toContain('t1');
 expect(text).not.toContain('"topicId"');expect(text).not.toContain('"joined"');
 expect(h.commands.proofResume).toHaveBeenCalledExactlyOnceWith('op1');
});
