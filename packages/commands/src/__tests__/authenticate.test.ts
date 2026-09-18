import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatClient } from '@masselabs/openstoa';
import { Commands } from '../commands';
import { FileSessionStore, MemorySessionStore, type SessionStore } from '../session';

const baseUrl = 'https://openstoa.test';
const originalSession = { baseUrl, token: 'prior-session-secret', userId: 'prior-user', nickname: 'prior' };
const expiresAt = () => Date.now() + 10 * 60_000;
const startResponse = () => ({ status: 'pending', loginId: 'login-123', browserUrl: `${baseUrl}/login#approvalToken=browser-approval-secret`, expiresAt: expiresAt() });
type AuthInput = { method?: 'app' | 'ai'; approved?: boolean; operationId?: string; cancel?: boolean; redirectUrl?: string };
type AuthResult = { status: string; operationId?: string; browserUrl?: string; [key: string]: unknown };
function build(loginStore: SessionStore = new MemorySessionStore(), origin = baseUrl, loginProver?: ConstructorParameters<typeof Commands>[0]['loginProver']) {
  const sessionStore = new MemorySessionStore(originalSession);
  const request = vi.fn().mockResolvedValue(startResponse());
  const validateToken = vi.fn().mockResolvedValue({ userId: 'new-user', nickname: '새 사용자 🦉', isAI: true });
  let token = originalSession.token;
  const chat = { rest: { request, getToken: () => token, setToken: vi.fn((value: string) => { token = value; }), getApiKey: () => 'osk_current_permissions', auth: { validateToken } }, useToken: vi.fn((value: string) => { token = value; }) };
  const commands = new Commands({ chat: chat as unknown as ChatClient, baseUrl: origin, session: originalSession, sessionStore, loginStore, loginProver } as ConstructorParameters<typeof Commands>[0]);
  const authenticate = (input: AuthInput = {}) => (commands as unknown as { authenticate(a: AuthInput): Promise<AuthResult> }).authenticate(input);
  return { commands, authenticate, request, validateToken, chat, sessionStore, loginStore };
}
async function pendingRecord(store: SessionStore) {
  return (await store.read() as unknown as { pendingLogin: { codeVerifier: string; operationId: string; baseUrl: string } } | null)?.pendingLogin;
}
const tempDirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('explicit-consent app authentication', () => {
  it.each([{}, { approved: false }, { method: 'app' as const }])('does not contact the server or change credentials before approval: %j', async input => {
    const h = build();
    expect(await h.authenticate(input)).toMatchObject({ status: 'consent_required' });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.chat.useToken).not.toHaveBeenCalled();
    expect(await h.sessionStore.read()).toEqual(originalSession);
    expect(await h.loginStore.read()).toBeNull();
  });
  it('sends only a SHA256 challenge and persists a strong verifier outside the browser URL', async () => {
    const h = build();
    const result = await h.authenticate({ method: 'app', approved: true });
    expect(result).toMatchObject({ status: 'pending', operationId: 'login-123' });
    const saved = await pendingRecord(h.loginStore);
    expect(saved?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const challenge = createHash('sha256').update(saved!.codeVerifier).digest('base64url');
    expect(h.request).toHaveBeenCalledExactlyOnceWith('/api/auth/cli-login', expect.objectContaining({ method: 'POST', body: expect.objectContaining({ codeChallenge: challenge }) }));
    expect(JSON.stringify(h.request.mock.calls[0][1].body)).not.toContain(saved!.codeVerifier);
    expect(saved).toMatchObject({ operationId: result.operationId, baseUrl });
    const browser = new URL(result.browserUrl!);
    expect(browser.origin).toBe(baseUrl);
    expect(browser.pathname).toBe('/login');
    expect(browser.search).not.toContain('secret');
    expect(browser.hash).toContain('browser-approval-secret');
    expect(JSON.stringify(result)).not.toContain(saved!.codeVerifier);
    expect(JSON.stringify(result)).not.toContain(originalSession.token);
    expect(h.chat.useToken).not.toHaveBeenCalled();
  });
  it('logout removes the live login session while retaining the independent permission key', async () => {
    const h = build();
    await h.commands.logout();
    expect(h.chat.rest.getToken()).toBeFalsy();
    expect(h.chat.rest.getApiKey()).toBe('osk_current_permissions');
    expect(await h.sessionStore.read()).toBeNull();
    await expect(h.commands.whoami()).rejects.toMatchObject({ status: 401 });
  });
  it('uses different verifiers for independent operations', async () => {
    const first = build(); const second = build();
    await first.authenticate({ approved: true }); await second.authenticate({ approved: true });
    expect((await pendingRecord(first.loginStore))!.codeVerifier).not.toBe((await pendingRecord(second.loginStore))!.codeVerifier);
  });
  it('persists a restartable pending operation with owner-only file permissions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openstoa-login-test-')); tempDirs.push(dir);
    const file = join(dir, 'login-operation.json');
    const h = build(new FileSessionStore(file));
    const first = await h.authenticate({ approved: true });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const verifier = JSON.parse(await readFile(file, 'utf8')).pendingLogin.codeVerifier;
    const restarted = build(new FileSessionStore(file));
    restarted.request.mockResolvedValue({ status: 'pending', expiresAt: expiresAt() });
    expect(await restarted.authenticate({ operationId: first.operationId })).toMatchObject({ status: 'pending', operationId: first.operationId });
    expect(restarted.request).toHaveBeenCalledExactlyOnceWith(`/api/auth/cli-login/${first.operationId}`, expect.objectContaining({ method: 'POST', body: { codeVerifier: verifier } }));
    expect(restarted.chat.useToken).not.toHaveBeenCalled();
  });
  it('adopts a completed token and returns only identity, including UTF-8 nickname', async () => {
    const h = build();
    const first = await h.authenticate({ approved: true });
    h.request.mockResolvedValue({ status: 'completed', token: 'new-session-secret', userId: 'new-user', nickname: '새 사용자 🦉', isAI: true });
    const result = await h.authenticate({ operationId: first.operationId });
    expect(result).toMatchObject({ status: 'authenticated', operationId: first.operationId, userId: 'new-user', nickname: '새 사용자 🦉', isAI: true });
    expect(JSON.stringify(result)).not.toContain('new-session-secret');
    expect(h.chat.useToken).toHaveBeenCalledExactlyOnceWith('new-session-secret');
    expect(await h.sessionStore.read()).toMatchObject({ baseUrl, token: 'new-session-secret', userId: 'new-user' });
    expect(await pendingRecord(h.loginStore)).toBeFalsy();
  });
  it('cancel clears the pending secret and prevents polling or adopting credentials', async () => {
    const h = build(); const first = await h.authenticate({ approved: true });
    h.request.mockClear();
    expect(await h.authenticate({ operationId: first.operationId, cancel: true })).toMatchObject({ status: 'cancelled' });
    expect(await pendingRecord(h.loginStore)).toBeFalsy();
    expect(h.chat.useToken).not.toHaveBeenCalled();
    const before = h.request.mock.calls.length;
    await h.authenticate({ operationId: first.operationId }).catch(() => undefined);
    expect(h.request.mock.calls.length).toBe(before);
    expect(await h.sessionStore.read()).toEqual(originalSession);
  });
  it('refuses resuming a pending operation against another server', async () => {
    const h = build(); const first = await h.authenticate({ approved: true });
    const other = build(h.loginStore, 'https://other-openstoa.test');
    const result = await other.authenticate({ operationId: first.operationId }).catch(error => ({ status: 'failed', error }));
    expect(result.status).toBe('failed');
    expect(other.request).not.toHaveBeenCalled();
    expect(other.chat.useToken).not.toHaveBeenCalled();
  });
  it('does not poll after the local operation expires', async () => {
    vi.useFakeTimers();
    const h = build(); const first = await h.authenticate({ approved: true });
    h.request.mockClear(); vi.setSystemTime(Date.now() + 16 * 60_000);
    expect(await h.authenticate({ operationId: first.operationId })).toMatchObject({ status: 'expired' });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.chat.useToken).not.toHaveBeenCalled();
  });
  it.each([403, 410])('a server refusal (%s) preserves the existing session', async status => {
    const h = build(); const first = await h.authenticate({ approved: true });
    h.request.mockRejectedValue(Object.assign(new Error('Login refused'), { status }));
    const result = await h.authenticate({ operationId: first.operationId }).catch(error => ({ status: 'failed', message: error.message }));
    expect(['failed', 'expired']).toContain(result.status);
    expect(JSON.stringify(result)).not.toContain(originalSession.token);
    expect(h.chat.useToken).not.toHaveBeenCalled();
    expect(await h.sessionStore.read()).toEqual(originalSession);
  });
  it.each(['', ' ', '../escape', '<script>', '한글🦉', 'x'.repeat(4097)])('unknown operation cannot fall through to a new login or HTTP request (%#)', async operationId => {
    const h = build();
    await h.authenticate({ operationId }).catch(() => undefined);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.chat.useToken).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'completed', userId: 'new-user', nickname: 'no token' },
    { status: 'completed', token: '' },
    { status: 'completed', token: '   ' },
    { status: 'completed', token: null },
  ])('malformed completion never adopts a credential (%#)', async payload => {
    const h = build(); const first = await h.authenticate({ approved: true });
    h.request.mockResolvedValue(payload);
    const result = await h.authenticate({ operationId: first.operationId }).catch(() => ({ status: 'failed' }));
    expect(result.status).not.toBe('authenticated');
    expect(h.chat.useToken).not.toHaveBeenCalled();
    expect(await h.sessionStore.read()).toEqual(originalSession);
  });
  it('an in-flight poll cannot adopt a token after cancellation', async () => {
    const h = build(); const first = await h.authenticate({ approved: true });
    let complete!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    h.request.mockImplementation((_path, options) => { if (options.body.cancel) return Promise.resolve({ status: 'cancelled' }); entered(); return new Promise(resolve => { complete = resolve; }); });
    const polling = h.authenticate({ operationId: first.operationId });
    await started;
    await h.authenticate({ operationId: first.operationId, cancel: true });
    complete({ status: 'completed', token: 'late-session-secret', userId: 'late-user', nickname: 'late' });
    const result = await polling.catch(() => ({ status: 'failed' }));
    expect(result.status).not.toBe('authenticated');
    expect(h.chat.useToken).not.toHaveBeenCalled();
    expect(await h.sessionStore.read()).toEqual(originalSession);
  });
  it('cancelling an old request cannot erase a newer login begun during the cancellation HTTP call', async () => {
    const h = build(); const first = await h.authenticate({ approved: true });
    let finishCancel!: (value: unknown) => void;
    let entered!: () => void;
    const cancelling = new Promise<void>(resolve => { entered = resolve; });
    h.request.mockImplementation((route, options) => {
      if (options.body.cancel) { entered(); return new Promise(resolve => { finishCancel = resolve; }); }
      if (route === '/api/auth/cli-login') return Promise.resolve({ ...startResponse(), loginId: 'second-login' });
      return Promise.resolve({ status: 'pending' });
    });
    const firstCancel = h.authenticate({ operationId: first.operationId, cancel: true });
    await cancelling;
    const second = await h.authenticate({ approved: true });
    finishCancel({ status: 'cancelled' }); await firstCancel;
    expect((await pendingRecord(h.loginStore))?.operationId).toBe(second.operationId);
    expect(await h.authenticate({ operationId: second.operationId })).toMatchObject({ status: 'pending', operationId: second.operationId });
  });
  it('a prior operation cannot overwrite a credential explicitly changed since it began', async () => {
    const h = build(); const first = await h.authenticate({ approved: true });
    await h.commands.login({ token: 'replacement-session-secret' });
    h.request.mockClear(); h.chat.useToken.mockClear();
    h.request.mockResolvedValue({ status: 'completed', token: 'stale-operation-token', userId: 'stale-user', nickname: 'stale' });
    const result = await h.authenticate({ operationId: first.operationId }).catch(() => ({ status: 'failed' }));
    expect(result.status).not.toBe('authenticated');
    expect(h.request).not.toHaveBeenCalled();
    expect(h.chat.useToken).not.toHaveBeenCalled();
    expect((await h.sessionStore.read())?.token).toBe('replacement-session-secret');
  });

});


describe('AI authentication lifecycle (mocked prover and verifier)', () => {
  function ai() {
    const proof = { proof: '0x01', publicInputs: '0x02', loginResult: { proof: { proof: '0x01', publicInputs: ['0x02'] }, circuit: 'oidc_domain_attestation' } };
    const handle = { status: vi.fn().mockReturnValue({ status: 'awaiting_authorization', verificationUrl: 'https://google.com/device', userCode: 'ABCD-1234' }), wait: vi.fn().mockResolvedValue(proof), cancel: vi.fn() };
    const prover = vi.fn().mockReturnValue(handle);
    const h = build(new MemorySessionStore(), baseUrl, prover);
    h.request.mockResolvedValue({ challengeId: 'challenge-123', scope: 'zkproofport-community', expiresIn: 300 });
    return { ...h, handle, prover, proof };
  }
  it('does not request a challenge or start the prover without explicit consent', async () => {
    const h = ai();
    expect(await h.authenticate({ method: 'ai' })).toMatchObject({ status: 'consent_required' });
    expect(h.request).not.toHaveBeenCalled(); expect(h.prover).not.toHaveBeenCalled();
  });
  it('approved AI explicitly requests a login challenge even when already signed in and surfaces device instructions', async () => {
    const h = ai(); const first = await h.authenticate({ method: 'ai', approved: true });
    expect(h.request).toHaveBeenCalledExactlyOnceWith('/api/auth/challenge', { method: 'POST', body: { purpose: 'login' } });
    expect(h.prover).toHaveBeenCalledExactlyOnceWith({ proofType: 'google_login', scope: 'zkproofport-community', consent: true });
    expect(await h.authenticate({ operationId: first.operationId })).toMatchObject({ status: 'pending', verificationUrl: 'https://google.com/device', userCode: 'ABCD-1234' });
    expect(h.chat.useToken).not.toHaveBeenCalled();
  });
  it('exchanges the completed proof for the saved challenge and returns identity without token or proof', async () => {
    const h = ai(); const first = await h.authenticate({ method: 'ai', approved: true });
    h.handle.status.mockReturnValue({ status: 'completed' });
    h.request.mockResolvedValue({ token: 'ai-session-secret' });
    const result = await h.authenticate({ operationId: first.operationId });
    expect(h.request).toHaveBeenLastCalledWith('/api/auth/verify/ai', { method: 'POST', body: { challengeId: 'challenge-123', result: h.proof.loginResult } });
    expect(result).toMatchObject({ status: 'authenticated', userId: 'new-user' });
    expect(JSON.stringify(result)).not.toContain('ai-session-secret'); expect(result).not.toHaveProperty('proof');
    expect(h.chat.useToken).toHaveBeenCalledExactlyOnceWith('ai-session-secret');
  });
  it('cancels the exact child handle and does not exchange a proof', async () => {
    const h = ai(); const first = await h.authenticate({ method: 'ai', approved: true });
    h.request.mockClear();
    expect(await h.authenticate({ operationId: first.operationId, cancel: true })).toMatchObject({ status: 'cancelled' });
    expect(h.handle.cancel).toHaveBeenCalledOnce(); expect(h.request).not.toHaveBeenCalled(); expect(h.chat.useToken).not.toHaveBeenCalled();
  });
  it('expiry terminates the active prover and removes resumable secrets', async () => {
    vi.useFakeTimers(); const h = ai(); const first = await h.authenticate({ method: 'ai', approved: true });
    vi.setSystemTime(Date.now() + 301_000);
    expect(await h.authenticate({ operationId: first.operationId })).toMatchObject({ status: 'expired' });
    expect(h.handle.cancel).toHaveBeenCalledOnce(); expect(await pendingRecord(h.loginStore)).toBeFalsy();
  });
  it('an AI operation cannot silently restart its child across process instances', async () => {
    const h = ai(); const first = await h.authenticate({ method: 'ai', approved: true });
    const restartedProver = vi.fn(); const restarted = build(h.loginStore, baseUrl, restartedProver);
    expect(await restarted.authenticate({ operationId: first.operationId })).toMatchObject({ status: 'failed' });
    expect(restartedProver).not.toHaveBeenCalled(); expect(restarted.request).not.toHaveBeenCalled();
  });
  it('a failed proof verification cannot change credentials or automatically replay one-shot verification', async () => {
    const h = ai(); const first = await h.authenticate({ method: 'ai', approved: true });
    h.handle.status.mockReturnValue({ status: 'completed' });
    h.request.mockRejectedValue(new Error('Proof rejected'));
    await h.authenticate({ operationId: first.operationId }).catch(() => undefined);
    expect(h.chat.useToken).not.toHaveBeenCalled();
    h.request.mockClear();
    await h.authenticate({ operationId: first.operationId }).catch(() => undefined);
    expect(h.request).not.toHaveBeenCalled(); expect(await h.sessionStore.read()).toEqual(originalSession);
  });
});
