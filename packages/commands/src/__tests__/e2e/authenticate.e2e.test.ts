/** Real local HTTP login boundary. No mocked crypto, forged valid proof, or seeded
 * verification cache. Successful mobile/prover completion needs a real user. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const base = process.env.E2E_BASE_URL;
const pending: Array<{ loginId: string; codeVerifier: string }> = [];
async function post(route: string, input: unknown) {
  const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const text = await response.text();
  let body: Record<string, any>;
  try { body = JSON.parse(text); } catch { body = { nonJson: true }; }
  return { response, body };
}
async function start() {
  const codeVerifier = randomBytes(32).toString('base64url');
  const created = await post('/api/auth/cli-login', { codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url') });
  expect(created.response.status).toBe(202);
  pending.push({ loginId: created.body.loginId, codeVerifier });
  return { ...created, codeVerifier };
}
describe.skipIf(!base).sequential('local HTTP app-login binding and refusal', () => {
  beforeAll(() => {
    const origin = new URL(base!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.port !== '3200') throw new Error('Login E2E accepts only the disposable local stack at port 3200.');
  });
  afterAll(async () => {
    for (const item of pending) await post(`/api/auth/cli-login/${item.loginId}`, { codeVerifier: item.codeVerifier, cancel: true });
  });
  it('starts pending with a fragment-only browser capability and exposes no session', async () => {
    const created = await start();
    const browser = new URL(created.body.browserUrl);
    expect(browser.origin).toBe(new URL(base!).origin);
    expect(browser.pathname).toBe('/login');
    expect(browser.searchParams.get('loginId')).toBe(created.body.loginId);
    expect(new URLSearchParams(browser.hash.slice(1)).get('approvalToken')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(browser.searchParams.has('token')).toBe(false);
    expect(browser.searchParams.has('approvalToken')).toBe(false);
    expect(JSON.stringify(created.body)).not.toContain(created.codeVerifier);
    expect(created.response.headers.get('cache-control')).toContain('no-store');
    expect(created.response.headers.get('set-cookie')).toBeNull();
    const poll = await post(`/api/auth/cli-login/${created.body.loginId}`, { codeVerifier: created.codeVerifier });
    expect(poll.response.status).toBe(202); expect(poll.body.status).toBe('pending');
    expect(poll.body).not.toHaveProperty('token'); expect(poll.body).not.toHaveProperty('deepLink');
  });
  it('explicit browser approval creates a real app relay handoff while the CLI stays pending', async () => {
    const created = await start(); const browser = new URL(created.body.browserUrl);
    const approvalToken = new URLSearchParams(browser.hash.slice(1)).get('approvalToken');
    const route = `/api/auth/cli-login/${created.body.loginId}`;
    const approved = await post(route, { approvalToken });
    expect(approved.response.status).toBe(202);
    expect(approved.body.status).toBe('pending');
    expect(approved.body.deepLink).toMatch(/^zkproofport:\/\/proof-request\?/);
    expect(approved.body).not.toHaveProperty('token');
    expect(approved.response.headers.get('set-cookie')).toBeNull();
    const cli = await post(route, { codeVerifier: created.codeVerifier });
    expect(cli.response.status).toBe(202); expect(cli.body.status).toBe('pending');
    expect(cli.body).not.toHaveProperty('deepLink'); expect(cli.body).not.toHaveProperty('token');
  });
  it('rejects a wrong verifier and ignores a forged completion with the correct verifier', async () => {
    const created = await start(); const route = `/api/auth/cli-login/${created.body.loginId}`;
    const refused = await post(route, { codeVerifier: randomBytes(32).toString('base64url'), status: 'completed', token: 'forged-session', userId: 'forged-user' });
    expect(refused.response.status).toBe(403); expect(refused.body).not.toHaveProperty('token');
    const forged = await post(route, { codeVerifier: created.codeVerifier, status: 'completed', token: 'forged-session', proof: '0x00', publicInputs: [] });
    expect(forged.response.status).toBe(202); expect(forged.body.status).toBe('pending');
    expect(forged.body).not.toHaveProperty('token'); expect(forged.response.headers.get('set-cookie')).toBeNull();
  });
  it('requires exactly one authentic capability and rejects a wrong browser approval', async () => {
    const created = await start(); const route = `/api/auth/cli-login/${created.body.loginId}`;
    for (const input of [{}, { approvalToken: 'wrong' }, { codeVerifier: created.codeVerifier, approvalToken: 'wrong' }]) {
      const denied = await post(route, input); expect(denied.response.status).toBe(403); expect(denied.body).not.toHaveProperty('token');
    }
  });
  it('cancels without proof and keeps subsequent polls terminal', async () => {
    const created = await start(); const route = `/api/auth/cli-login/${created.body.loginId}`;
    const cancelled = await post(route, { codeVerifier: created.codeVerifier, cancel: true });
    expect(cancelled.response.status).toBe(200); expect(cancelled.body.status).toBe('cancelled');
    const poll = await post(route, { codeVerifier: created.codeVerifier });
    expect(poll.body.status).toBe('cancelled'); expect(poll.body).not.toHaveProperty('token');
  });
  it('returns expired for an unknown well-formed operation', async () => {
    expect((await post(`/api/auth/cli-login/${randomUUID()}`, { codeVerifier: randomBytes(32).toString('base64url') })).response.status).toBe(410);
  });
  it.each(['https://attacker.test/my', '//attacker.test/my', '/my?token=secret', '/my#access_token=secret', '/my%0aevil', '/\\attacker.test', '/my?key=secret'])('rejects unsafe redirect %j', async redirect_url => {
    const result = await post('/api/auth/cli-login', { codeChallenge: createHash('sha256').update(randomBytes(32)).digest('base64url'), redirect_url });
    expect(result.response.status).toBe(400); expect(result.body).not.toHaveProperty('browserUrl');
  });
  it.each([undefined, null, '', ' ', 'a'.repeat(42), 'a'.repeat(44), '<script>', '한글🦉'])('rejects missing or malformed SHA256 challenge (%#)', async codeChallenge => {
    const result = await post('/api/auth/cli-login', { codeChallenge });
    expect(result.response.status).toBe(400); expect(result.body).not.toHaveProperty('browserUrl');
  });
});
