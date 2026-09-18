import { expect, it, vi } from 'vitest';
import { OpenStoaApiError } from '@masselabs/openstoa';
import type { Commands } from '@masselabs/openstoa-commands';
import { buildProgram } from '../cli';
const consent = { status: 'consent_required', methods: ['app', 'ai'], message: 'Choose app or AI and approve login.' };
const pending = { status: 'pending', operationId: 'login-123', method: 'app', browserUrl: 'https://openstoa.test/login#approvalToken=browser-secret', expiresAt: '2099-01-01T00:00:00Z', pollAfterMs: 1500 };
const authenticated = { status: 'authenticated', operationId: 'login-123', userId: 'u1', nickname: '테스트🦉', isAI: true };
function harness(tty = false) {
  const commands = { authenticate: vi.fn().mockResolvedValue(consent), login: vi.fn(), whoami: vi.fn() };
  const factory = vi.fn(async () => commands as unknown as Commands);
  const out: string[] = [];
  const terminal = { isTTY: () => tty, ask: vi.fn().mockResolvedValueOnce('yes').mockResolvedValueOnce('app'), write: vi.fn(), sleep: vi.fn().mockResolvedValue(undefined), openBrowser: vi.fn().mockResolvedValue(undefined) };
  const program = buildProgram(factory, text => out.push(text), terminal);
  const guard = (command: typeof program) => { command.exitOverride().configureOutput({ writeErr: () => {} }); command.commands.forEach(guard); }; guard(program);
  return { commands, out, terminal, factory, run: (args: string[]) => program.parseAsync(['node', 'openstoa', ...args]) };
}
it.each([false, true])('bare login returns structured consent guidance without prompting (JSON, tty=%s)', async tty => {
  const h = harness(tty); await h.run(['--json', 'login']);
  expect(JSON.parse(h.out.join(''))).toEqual(consent);
  expect(h.commands.authenticate).toHaveBeenCalledOnce();
  expect(h.commands.authenticate.mock.calls[0][0]?.approved).not.toBe(true);
  expect(h.terminal.ask).not.toHaveBeenCalled(); expect(h.terminal.openBrowser).not.toHaveBeenCalled();
  expect(h.commands.login).not.toHaveBeenCalled();
});
it('non-TTY login asks for consent through a structured result without opening a browser', async () => {
  const h = harness(); await h.run(['login']);
  expect(JSON.parse(h.out.join(''))).toEqual(consent);
  expect(h.terminal.ask).not.toHaveBeenCalled(); expect(h.terminal.openBrowser).not.toHaveBeenCalled();
});
it('explicit app approval returns restartable pending guidance', async () => {
  const h = harness(); h.commands.authenticate.mockResolvedValue(pending);
  await h.run(['--json', 'login', '--method', 'app', '--approved']);
  expect(h.commands.authenticate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ method: 'app', approved: true }));
  expect(JSON.parse(h.out.join(''))).toEqual(pending);
  expect(h.terminal.ask).not.toHaveBeenCalled(); expect(h.terminal.openBrowser).not.toHaveBeenCalled();
});
it('TTY consent performs app handoff and polls the same Commands instance until authenticated', async () => {
  const h = harness(true);
  h.commands.authenticate.mockResolvedValueOnce(consent).mockResolvedValueOnce(pending).mockResolvedValueOnce(authenticated);
  await h.run(['login']);
  expect(h.commands.authenticate.mock.calls.some(([input]) => input?.approved === true && input.method === 'app')).toBe(true);
  expect(h.commands.authenticate).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: 'login-123' }));
  expect(h.factory).toHaveBeenCalledOnce();
  expect(h.terminal.openBrowser).toHaveBeenCalledExactlyOnceWith(pending.browserUrl);
  expect(h.out.join('')).toContain('테스트🦉');
});
it('declining terminal consent never starts login or opens a browser', async () => {
  const h = harness(true); h.terminal.ask.mockReset().mockResolvedValue('no');
  await h.run(['login']);
  expect(h.commands.authenticate.mock.calls.some(([input]) => input?.approved === true)).toBe(false);
  expect(h.terminal.openBrowser).not.toHaveBeenCalled(); expect(h.terminal.sleep).not.toHaveBeenCalled();
});
it('operation-id resumes saved login without re-approving or starting another request', async () => {
  const h = harness(); h.commands.authenticate.mockResolvedValue(authenticated);
  await h.run(['--json', 'login', '--operation-id', 'login-123']);
  expect(h.commands.authenticate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: 'login-123' }));
  expect(h.commands.authenticate.mock.calls[0][0]?.approved).not.toBe(true);
  expect(JSON.parse(h.out.join(''))).toEqual(authenticated);
  expect(h.terminal.ask).not.toHaveBeenCalled();
});
it('cancellation forwards the saved ID and never starts a new authentication', async () => {
  const h = harness(); h.commands.authenticate.mockResolvedValue({ status: 'cancelled', operationId: 'login-123' });
  await h.run(['--json', 'login', '--operation-id', 'login-123', '--cancel']);
  expect(h.commands.authenticate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: 'login-123', cancel: true }));
  expect(h.terminal.openBrowser).not.toHaveBeenCalled();
});
it('AI approval without --wait is rejected before a child can start', async () => {
  const h = harness();
  await expect(h.run(['login', '--method', 'ai', '--approved'])).rejects.toThrow('--wait');
  expect(h.commands.authenticate).not.toHaveBeenCalled();
});
it('JSON --wait emits only the final identity on stdout and never opens a browser even on TTY', async () => {
  const h = harness(true); h.commands.authenticate.mockResolvedValueOnce(pending).mockResolvedValueOnce(authenticated);
  await h.run(['--json', 'login', '--method', 'app', '--approved', '--wait']);
  expect(h.out).toHaveLength(1); expect(JSON.parse(h.out[0])).toEqual(authenticated);
  expect(h.terminal.openBrowser).not.toHaveBeenCalled(); expect(h.terminal.ask).not.toHaveBeenCalled();
  expect(h.factory).toHaveBeenCalledOnce();
});

it.each([false, true])('a 401 returns structured authentication guidance without implicit consent (JSON, tty=%s)', async tty => {
  const h = harness(tty);
  h.commands.whoami.mockRejectedValue(new OpenStoaApiError(401, 'GET', '/api/auth/session', { error: 'Authentication required' }));
  await h.run(['--json', 'whoami']);
  expect(JSON.parse(h.out.join(''))).toMatchObject({ status: 'authentication_required' });
  expect(h.commands.authenticate).not.toHaveBeenCalled(); expect(h.terminal.ask).not.toHaveBeenCalled(); expect(h.terminal.openBrowser).not.toHaveBeenCalled();
});
it.each(['API_KEY_REQUIRED', 'API_KEY_SCOPE_DENIED', 'API_KEY_OWNER_MISMATCH'])('403 %s is not converted into a new login', async code => {
  const h = harness();
  h.commands.whoami.mockRejectedValue(new OpenStoaApiError(403, 'GET', '/api/profile', { error: 'Permission key refused', code }));
  await expect(h.run(['--json', 'whoami'])).rejects.toThrow('403');
  expect(h.commands.authenticate).not.toHaveBeenCalled();
});

it('Ctrl-C during an in-flight login poll cancels immediately before the response can finish', async () => {
  const h = harness();
  let entered!: () => void;
  let release!: (value: unknown) => void;
  const polling = new Promise<void>(resolve => { entered = resolve; });
  h.commands.authenticate.mockImplementation(async input => {
    if (input?.cancel) return { status: 'cancelled', operationId: 'login-123' };
    if (input?.approved) return pending;
    entered(); return new Promise(resolve => { release = resolve; });
  });
  const run = h.run(['--json', 'login', '--method', 'app', '--approved', '--wait']);
  await polling;
  process.emit('SIGINT');
  await Promise.resolve(); await Promise.resolve();
  const cancelledWhilePolling = h.commands.authenticate.mock.calls.some(([input]) => input?.operationId === 'login-123' && input?.cancel === true);
  release({ status: 'cancelled', operationId: 'login-123' });
  await run;
  expect(cancelledWhilePolling).toBe(true);
  expect(JSON.parse(h.out.join('')).status).toBe('cancelled');
});
