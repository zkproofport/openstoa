/**
 * Factory auth tests. A saved proof-login session authenticates; a selected API
 * key independently limits permissions. Neither credential may be sent to an
 * origin different from the saved session or exposed in failure messages.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOpenStoaChannel } from '../factory';

let tmpHome: string;
let savedKey: string | undefined;
let savedBase: string | undefined;
const BASE = 'https://openstoa.example';
const TOKEN = 'proof-session-private-value';
const KEY = 'osk_permission-private-value';
async function saveSession(overrides: Record<string, unknown> = {}) {
  await fs.writeFile(path.join(tmpHome, 'session.json'), JSON.stringify({ baseUrl: BASE, token: TOKEN, userId: 'owner', ...overrides }), { mode: 0o600 });
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-factory-'));
  savedKey = process.env.OPENSTOA_API_KEY;
  savedBase = process.env.OPENSTOA_BASE_URL;
  delete process.env.OPENSTOA_BASE_URL;
  delete process.env.OPENSTOA_API_KEY; // isolate from the dev environment
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (savedBase === undefined) delete process.env.OPENSTOA_BASE_URL;
  else process.env.OPENSTOA_BASE_URL = savedBase;
  if (savedKey === undefined) delete process.env.OPENSTOA_API_KEY;
  else process.env.OPENSTOA_API_KEY = savedKey;
  if (tmpHome) await fs.rm(tmpHome, { recursive: true, force: true });
});

describe('createOpenStoaChannel — auth', () => {
  it('throws a clear error when no base URL is configured', async () => {
    const savedBase = process.env.OPENSTOA_BASE_URL;
    delete process.env.OPENSTOA_BASE_URL;
    try {
      await expect(createOpenStoaChannel({ vaultRoot: tmpHome, apiKey: 'osk_x' })).rejects.toThrow(/base URL/);
    } finally {
      if (savedBase !== undefined) process.env.OPENSTOA_BASE_URL = savedBase;
    }
  });

  it('throws a clear error when no API key is present anywhere (env/config/credentials)', async () => {
    await saveSession({baseUrl: 'http://localhost:3200'});
    await expect(createOpenStoaChannel({ baseUrl: 'http://localhost:3200', vaultRoot: tmpHome })).rejects.toThrow(
      /scoped API key/,
    );
  });

  it('rejects a blank API key the same way', async () => {
    await saveSession({baseUrl: 'http://localhost:3200'});
    await expect(
      createOpenStoaChannel({ baseUrl: 'http://localhost:3200', vaultRoot: tmpHome, apiKey: '   ' }),
    ).rejects.toThrow(/scoped API key/);
  });

  it('rejects an unsupported keystore backend', async () => {
    await expect(
      createOpenStoaChannel({ baseUrl: 'http://localhost:3200', vaultRoot: tmpHome, apiKey: 'osk_x', backend: 'keychain' }),
    ).rejects.toThrow(/backend/);
  });

  it('uses the saved proof session and selected permission key as separate HTTP credentials', async () => {
    await saveSession();
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({dms: []}), {status: 200}));
    vi.stubGlobal('fetch', fetchSpy);
    const channel = await createOpenStoaChannel({baseUrl: BASE, vaultRoot: tmpHome, apiKey: KEY});
    expect(channel.subscriptions()).toEqual([]);
    expect(await channel.listDms()).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, request] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(BASE + '/api/dm');
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer ' + TOKEN);
    expect(new Headers(request.headers).get('X-OpenStoa-API-Key')).toBe(KEY);
    expect(String(url)).not.toContain(TOKEN);
    expect(String(url)).not.toContain(KEY);
    expect(JSON.parse(await fs.readFile(path.join(tmpHome, 'session.json'), 'utf8')).token).toBe(TOKEN);
  });

  it('uses the saved session origin when neither config nor environment supplies one', async () => {
    await saveSession();
    const fetchSpy = vi.fn().mockResolvedValue(new Response(JSON.stringify({dms: []}), {status: 200}));
    vi.stubGlobal('fetch', fetchSpy);
    const channel = await createOpenStoaChannel({vaultRoot: tmpHome, apiKey: KEY});
    expect(await channel.listDms()).toEqual([]);
    expect(String(fetchSpy.mock.calls[0][0])).toBe(BASE + '/api/dm');
  });

  it('rejects a permission key alone without creating a login or issuing HTTP requests', async () => {
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    await expect(createOpenStoaChannel({baseUrl: BASE, vaultRoot: tmpHome, apiKey: KEY})).rejects.toThrow(/login|session/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(fs.access(path.join(tmpHome, 'session.json'))).rejects.toThrow();
  });

  it.each([undefined, '', '   '])('rejects an absent or blank saved session token (%#)', async token => {
    await saveSession({token});
    await expect(createOpenStoaChannel({baseUrl: BASE, vaultRoot: tmpHome, apiKey: KEY})).rejects.toThrow(/login|session/i);
  });

  it.each(['config', 'environment'])('blocks session forwarding to another origin selected by %s without exposing credentials', async source => {
    await saveSession();
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy);
    if (source === 'environment') process.env.OPENSTOA_BASE_URL = 'https://other.example';
    let caught: unknown;
    try {
      await createOpenStoaChannel({vaultRoot: tmpHome, apiKey: KEY, ...(source === 'config' ? {baseUrl: 'https://other.example'} : {})});
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    const message = String(caught);
    expect(message).toMatch(/origin|base URL|session.*match|login/i);
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(KEY);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
