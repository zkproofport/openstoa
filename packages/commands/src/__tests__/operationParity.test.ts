import { describe, expect, it, vi } from 'vitest';
import { ChatClient } from '@masselabs/openstoa';
import { Commands } from '../commands';
import { MemorySessionStore } from '../session';
import { OPERATION_CONTRACTS } from '../../../sdk/src/__tests__/operationContracts';
describe('command operation wire parity', () => {
  it.each(OPERATION_CONTRACTS)('$id reaches REST through the real shared SDK', async row => {
    const response = { ok: true, result: row.id };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
    const chat = new ChatClient({ baseUrl: 'https://example.test', token: 'verified-session', apiKey: 'osk_test', fetch });
    const commands = new Commands({ chat, baseUrl: 'https://example.test', session: null, sessionStore: new MemorySessionStore() });
    expect(await commands.executeOperation(row.id, row.input)).toEqual(response);
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url).pathname).toBe(row.path);
    expect(init.method).toBe(row.method);
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual(row.query ?? {});
    expect(init.headers.Authorization).toBe('Bearer verified-session');
    expect(init.headers['X-OpenStoa-API-Key']).toBe('osk_test');
    expect(init.body === undefined ? undefined : JSON.parse(init.body)).toEqual(row.body);
  });
  it.each(OPERATION_CONTRACTS)('$id requires CLI/MCP login before HTTP even when the browser REST endpoint permits guests', async row => {
    const fetch = vi.fn();
    const chat = new ChatClient({ baseUrl: 'https://example.test', fetch });
    const commands = new Commands({ chat, baseUrl: 'https://example.test', session: null, sessionStore: new MemorySessionStore() });
    await expect(commands.executeOperation(row.id, row.input)).rejects.toMatchObject({ status: 401, body: { status: 'authentication_required' } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('still rejects unknown operation identifiers explicitly before attempting authentication or HTTP', async () => {
    const fetch = vi.fn();
    const chat = new ChatClient({ baseUrl: 'https://example.test', fetch });
    const commands = new Commands({ chat, baseUrl: 'https://example.test', session: null, sessionStore: new MemorySessionStore() });
    await expect(commands.executeOperation('__proto__')).rejects.toThrow('Unknown REST operation');
    expect(fetch).not.toHaveBeenCalled();
  });
});
