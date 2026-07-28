/**
 * OpenStoaClient unit tests against a mock fetch. Verifies method/path/query/body
 * shaping, Bearer injection, response unwrapping, 404→null, epoch-CAS 409 on
 * commit, and SI-1 (chat send transmits ONLY sealed ciphertext — never plaintext).
 */
import { describe, it, expect } from 'vitest';
import { OpenStoaClient, OpenStoaApiError } from '../rest/openStoaClient';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(handler: (rec: Recorded) => { status?: number; json?: unknown; text?: string }) {
  const calls: Recorded[] = [];
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const rec: Recorded = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(rec);
    const r = handler(rec);
    const status = r.status ?? 200;
    const text = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : '');
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => (text ? JSON.parse(text) : undefined),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('OpenStoaClient', () => {
  it('devLogin posts nickname, unwraps token, and stores it for later Bearer', async () => {
    const { fn, calls } = mockFetch((rec) => {
      if (rec.url.endsWith('/api/auth/dev-login')) return { json: { userId: '0xabc', nickname: 'n', token: 'TKN' } };
      return { json: { topics: [] } };
    });
    const c = new OpenStoaClient({ baseUrl: 'http://h', fetch: fn });
    const auth = await c.auth.devLogin('n');
    expect(auth.token).toBe('TKN');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ nickname: 'n' });
    // Subsequent calls carry the Bearer.
    await c.topics.list();
    expect(calls[1].headers['authorization']).toBe('Bearer TKN');
  });

  it('builds query params and unwraps list responses', async () => {
    const { fn, calls } = mockFetch(() => ({ json: { messages: [], total: 0 } }));
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    await c.chat.history('T1', { limit: 10, since: '2020-01-01T00:00:00Z' });
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/api/topics/T1/chat');
    expect(u.searchParams.get('limit')).toBe('10');
    expect(u.searchParams.get('since')).toBe('2020-01-01T00:00:00Z');
  });

  it('SI-1: chat.send transmits only sealed ciphertext + epoch (never plaintext)', async () => {
    const { fn, calls } = mockFetch(() => ({
      status: 201,
      json: { message: { id: 'm1', sealed: { ciphertext: 'AAAA', epoch: 1, takVersion: null } } },
    }));
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    const row = await c.chat.send('T1', { ciphertext: 'AAAA', epoch: 1 });
    expect(row.id).toBe('m1');
    const body = calls[0].body as Record<string, unknown>;
    expect(body).toEqual({ ciphertext: 'AAAA', epoch: 1, takVersion: null });
    // No plaintext-carrying field is ever present.
    expect('message' in body).toBe(false);
    expect('text' in body).toBe(false);
    expect('plaintext' in body).toBe(false);
  });

  it('group-info GET maps 404 → null, and 200 → the groupInfo string', async () => {
    const { fn } = mockFetch((rec) =>
      rec.url.includes('/notfound/') ? { status: 404 } : { json: { groupInfo: 'GI-B64' } },
    );
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    expect(await c.mls.getGroupInfo('notfound')).toBeNull();
    expect(await c.mls.getGroupInfo('exists')).toBe('GI-B64');
  });

  it('commit POST returns {ok:false} on a 409 epoch-CAS conflict', async () => {
    const { fn } = mockFetch((rec) =>
      (rec.body as { commit?: string }).commit === 'stale' ? { status: 409 } : { json: { epoch: 5 } },
    );
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    expect(await c.mls.postCommit('T1', 'stale', 'gi')).toEqual({ ok: false });
    expect(await c.mls.postCommit('T1', 'fresh', 'gi')).toEqual({ ok: true, epoch: 5 });
  });

  it('throws OpenStoaApiError carrying status + parsed body on non-2xx', async () => {
    const { fn } = mockFetch(() => ({ status: 403, json: { error: 'forbidden' } }));
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    await expect(c.topics.get('T1')).rejects.toMatchObject({
      name: 'OpenStoaApiError',
      status: 403,
      body: { error: 'forbidden' },
    });
    await expect(c.topics.get('T1')).rejects.toBeInstanceOf(OpenStoaApiError);
  });

  it('nickname uses PUT and adopts the returned token', async () => {
    const { fn, calls } = mockFetch(() => ({ json: { nickname: 'newnick', token: 'TKN2' } }));
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    await c.profile.setNickname('newnick');
    expect(calls[0].method).toBe('PUT');
    expect(c.getToken()).toBe('TKN2');
  });

  it('archive GET walks the keyset cursor to completion', async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ({ messageId: `m${i}`, takVersion: 0, ciphertext: 'c', createdAt: `2020-01-01T00:00:${String(i).padStart(2, '0')}Z` }));
    const page2 = [{ messageId: 'last', takVersion: 0, ciphertext: 'c', createdAt: '2020-02-01T00:00:00Z' }];
    let call = 0;
    const { fn } = mockFetch(() => ({ json: { archive: call++ === 0 ? page1 : page2 } }));
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    const all = await c.tak.getArchive('T1');
    expect(all.length).toBe(501);
    expect(all[500].messageId).toBe('last');
  });

  it('requires a baseUrl', () => {
    expect(() => new OpenStoaClient({ baseUrl: '' })).toThrow(/baseUrl/);
  });
});
