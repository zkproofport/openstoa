/**
 * API-key auth priority chain (design §7 follow-up): config.apiKey >
 * OPENSTOA_API_KEY env > <home>/credentials file. Exercises resolveApiKey and
 * readCredentials against a real temp directory (no network involved) —
 * commands.test.ts covers the Commands.apiKey* dispatch layer.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveApiKey } from '../commands';
import { readCredentials } from '../credentials';

async function tmpHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'openstoa-apikey-test-'));
}

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

  it('returns undefined when nothing is configured (falls back to saved session token upstream)', async () => {
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
