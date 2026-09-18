/**
 * Permission-key selection priority chain (design §7 follow-up): config.apiKey >
 * OPENSTOA_API_KEY env > <home>/credentials file. Exercises resolveApiKey and
 * readCredentials against a real temp directory (no network involved) —
 * commands.test.ts covers the Commands.apiKey* dispatch layer.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveApiKey, createCommands } from '../commands';
import { readCredentials } from '../credentials';

const homes: string[] = [];
async function tmpHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'openstoa-apikey-test-'));
  homes.push(home); return home;
}
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true }))); });

describe('readCredentials (boundary / hostile / empty)', () => {
  it('returns null when the file does not exist', async () => {
    const home = await tmpHome();
    expect(await readCredentials(home)).toBeNull();
  });
  it('reads a valid credentials file', async () => {
    const home = await tmpHome();
    await fs.writeFile(path.join(home, 'credentials'), JSON.stringify({ apiKey: 'osk_from_file' }));
    expect((await readCredentials(home))?.apiKey).toBe('osk_from_file');
  });
  it('returns null (not a throw) for malformed JSON', async () => {
    const home = await tmpHome();
    await fs.writeFile(path.join(home, 'credentials'), '{not json');
    expect(await readCredentials(home)).toBeNull();
  });
  it('returns { apiKey: undefined } for valid JSON missing the apiKey field', async () => {
    const home = await tmpHome();
    await fs.writeFile(path.join(home, 'credentials'), JSON.stringify({ other: 'x' }));
    expect((await readCredentials(home))?.apiKey).toBeUndefined();
  });
  it('returns null for a JSON array/non-object body', async () => {
    const home = await tmpHome();
    await fs.writeFile(path.join(home, 'credentials'), JSON.stringify([1, 2, 3]));
    expect(await readCredentials(home)).toBeNull();
  });
});

describe('resolveApiKey — priority chain (contract)', () => {
  const ORIGINAL_ENV = process.env.OPENSTOA_API_KEY;
  beforeEach(() => {
    delete process.env.OPENSTOA_API_KEY;
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.OPENSTOA_API_KEY;
    else process.env.OPENSTOA_API_KEY = ORIGINAL_ENV;
  });

  it('returns undefined when no permission key is configured without selecting an identity', async () => {
    const home = await tmpHome();
    expect(await resolveApiKey({}, home)).toBeUndefined();
  });

  it('uses the credentials file when nothing else is set', async () => {
    const home = await tmpHome();
    await fs.writeFile(path.join(home, 'credentials'), JSON.stringify({ apiKey: 'osk_from_file' }));
    expect(await resolveApiKey({}, home)).toBe('osk_from_file');
  });

  it('OPENSTOA_API_KEY env wins over the credentials file', async () => {
    const home = await tmpHome();
    await fs.writeFile(path.join(home, 'credentials'), JSON.stringify({ apiKey: 'osk_from_file' }));
    process.env.OPENSTOA_API_KEY = 'osk_from_env';
    expect(await resolveApiKey({}, home)).toBe('osk_from_env');
  });

  it('config.apiKey wins over both env and the credentials file', async () => {
    const home = await tmpHome();
    await fs.writeFile(path.join(home, 'credentials'), JSON.stringify({ apiKey: 'osk_from_file' }));
    process.env.OPENSTOA_API_KEY = 'osk_from_env';
    expect(await resolveApiKey({ apiKey: 'osk_from_config' }, home)).toBe('osk_from_config');
  });
});


describe('createCommands keeps login identity separate from permission key', () => {
  function recordRequests() {
    const headers: Headers[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ userId: 'owner-1', nickname: 'owner', authenticated: true }), { status: 200 });
    }));
    return headers;
  }
  it('configuring a permission key does not discard the saved login session', async () => {
    const home = await tmpHome();
    await fs.writeFile(path.join(home, 'session.json'), JSON.stringify({ baseUrl: 'https://openstoa.test', token: 'saved-login-session', userId: 'owner-1', nickname: 'owner' }), { mode: 0o600 });
    const headers = recordRequests();
    const commands = await createCommands({ baseUrl: 'https://openstoa.test', vaultRoot: home, apiKey: 'osk_limited_permissions' });
    await commands.whoami();
    expect(headers[0].get('authorization')).toBe('Bearer saved-login-session');
    expect(headers[0].get('x-openstoa-api-key')).toBe('osk_limited_permissions');
  });
  it('a fresh vault with a permission key still has no authenticated session', async () => {
    const home = await tmpHome(); const headers = recordRequests();
    const commands = await createCommands({ baseUrl: 'https://openstoa.test', vaultRoot: home, apiKey: 'osk_not_a_login' });
    await expect(commands.whoami()).rejects.toMatchObject({ status: 401 });
    expect(headers).toHaveLength(0);
    await expect(fs.access(path.join(home, 'session.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
