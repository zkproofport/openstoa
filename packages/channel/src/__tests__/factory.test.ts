/**
 * Factory auth tests. createOpenStoaChannel reuses the CLI/MCP scoped-API-key
 * resolution (resolveApiKey) + the file-vault home (resolveHome). A missing /
 * blank key must fail fast with a clear error, never start unauthenticated.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOpenStoaChannel } from '../factory';

let tmpHome: string;
let savedKey: string | undefined;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'channel-factory-'));
  savedKey = process.env.OPENSTOA_API_KEY;
  delete process.env.OPENSTOA_API_KEY; // isolate from the dev environment
});

afterEach(async () => {
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
    await expect(createOpenStoaChannel({ baseUrl: 'http://localhost:3200', vaultRoot: tmpHome })).rejects.toThrow(
      /scoped API key/,
    );
  });

  it('rejects a blank API key the same way', async () => {
    await expect(
      createOpenStoaChannel({ baseUrl: 'http://localhost:3200', vaultRoot: tmpHome, apiKey: '   ' }),
    ).rejects.toThrow(/scoped API key/);
  });

  it('rejects an unsupported keystore backend', async () => {
    await expect(
      createOpenStoaChannel({ baseUrl: 'http://localhost:3200', vaultRoot: tmpHome, apiKey: 'osk_x', backend: 'keychain' }),
    ).rejects.toThrow(/backend/);
  });

  it('constructs a channel when a scoped key is provided', async () => {
    const channel = await createOpenStoaChannel({ baseUrl: 'http://localhost:3200', vaultRoot: tmpHome, apiKey: 'osk_test' });
    expect(channel.subscriptions()).toEqual([]);
  });
});
