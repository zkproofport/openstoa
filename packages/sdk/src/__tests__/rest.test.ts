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

  it('dm.start POSTs { userId } to /api/dm and returns { topicId }', async () => {
    const { fn, calls } = mockFetch(() => ({ status: 201, json: { topicId: 'dm-1' } }));
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    const r = await c.dm.start('bob');
    expect(calls[0].method).toBe('POST');
    expect(new URL(calls[0].url).pathname).toBe('/api/dm');
    expect(calls[0].body).toEqual({ userId: 'bob' });
    expect(r).toEqual({ topicId: 'dm-1' });
  });

  it('dm.list unwraps { dms } and carries only routing metadata (SI-1)', async () => {
    const { fn } = mockFetch(() => ({ json: { dms: [{ topicId: 't1', peer: { userId: 'bob', nickname: 'bob', profileImage: null }, lastActivityAt: null }] } }));
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    const dms = await c.dm.list();
    expect(dms).toHaveLength(1);
    expect(dms[0].peer.nickname).toBe('bob');
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

  // ── API keys (design §7 follow-up: scoped Bearer credential, no interactive login) ──
  it('constructing with apiKey (no token) sends it as the Bearer on every request', async () => {
    const { fn, calls } = mockFetch(() => ({ json: { topics: [] } }));
    const c = new OpenStoaClient({ baseUrl: 'http://h', apiKey: 'osk_scopedkey123', fetch: fn });
    expect(c.getToken()).toBe('osk_scopedkey123');
    await c.topics.list();
    expect(calls[0].headers['authorization']).toBe('Bearer osk_scopedkey123');
  });
  it('an explicit token takes precedence over apiKey when both are given', async () => {
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'JWT_TOKEN', apiKey: 'osk_scopedkey123' });
    expect(c.getToken()).toBe('JWT_TOKEN');
  });
  it('apiKeys.create posts the input and returns { rawKey, key } — never re-sends the raw key elsewhere', async () => {
    const { fn, calls } = mockFetch(() => ({
      status: 201,
      json: { rawKey: 'osk_brandnew', key: { id: 'k1', name: 'laptop', prefix: 'osk_brandn', isAI: true, cmd: ['/openstoa/chat/read'], historyGrant: 'none' } },
    }));
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    const r = await c.apiKeys.create({ name: 'laptop', cmd: ['/openstoa/chat/read'], historyGrant: 'none' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ name: 'laptop', cmd: ['/openstoa/chat/read'], historyGrant: 'none' });
    expect(r.rawKey).toBe('osk_brandnew');
    expect(r.key.id).toBe('k1');
  });
  it('apiKeys.list unwraps { apiKeys } into an array', async () => {
    const { fn } = mockFetch(() => ({ json: { apiKeys: [{ id: 'k1' }, { id: 'k2' }] } }));
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    const list = await c.apiKeys.list();
    expect(list.map((k) => k.id)).toEqual(['k1', 'k2']);
  });
  it('apiKeys.revoke issues a DELETE to the key-scoped path', async () => {
    const { fn, calls } = mockFetch(() => ({ json: { revoked: true, id: 'k1' } }));
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    const r = await c.apiKeys.revoke('k1');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('/api/profile/api-keys/k1');
    expect(r.revoked).toBe(true);
  });
  it('apiKeys.create surfaces a 400 as OpenStoaApiError (e.g. unknown cmd)', async () => {
    const { fn } = mockFetch(() => ({ status: 400, json: { error: 'unknown cmd: /root/x' } }));
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    await expect(c.apiKeys.create({ name: 'k', cmd: ['/root/x'], historyGrant: 'none' })).rejects.toMatchObject({ status: 400 });
  });

  // ── uploads (multipart image → CDN) ────────────────────────────────────────
  // Own mock: the shared mockFetch JSON.parses the body, but upload sends FormData.
  function uploadMockFetch(status: number, json: unknown) {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
    const fn = (async (input: string | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body: init?.body });
      const text = JSON.stringify(json);
      return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => json } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fn, calls };
  }

  it('uploads.image POSTs multipart form-data (file + purpose), sets Bearer, and never a manual Content-Type', async () => {
    const { fn, calls } = uploadMockFetch(200, { publicUrl: 'https://cdn.example.com/posts/x/photo.jpg' });
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    const r = await c.uploads.image({ data: new Uint8Array([1, 2, 3]), filename: 'photo.jpg', contentType: 'image/jpeg', purpose: 'post' });
    expect(r.publicUrl).toBe('https://cdn.example.com/posts/x/photo.jpg');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://h/api/upload');
    expect(calls[0].headers['authorization']).toBe('Bearer T');
    // fetch derives the multipart boundary itself — we must not pin Content-Type.
    expect(calls[0].headers['content-type']).toBeUndefined();
    expect(calls[0].body).toBeInstanceOf(FormData);
    const form = calls[0].body as FormData;
    expect(form.get('purpose')).toBe('post');
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('uploads.image surfaces a non-2xx as OpenStoaApiError (e.g. 413 too large)', async () => {
    const { fn } = uploadMockFetch(413, { error: 'File size must not exceed 10MB' });
    const c = new OpenStoaClient({ baseUrl: 'http://h', token: 'T', fetch: fn });
    await expect(c.uploads.image({ data: new Uint8Array([1]), filename: 'x.png', contentType: 'image/png' })).rejects.toMatchObject({ status: 413, name: 'OpenStoaApiError' });
  });
});
