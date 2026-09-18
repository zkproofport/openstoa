import { describe, expect, it, vi } from 'vitest';
import { ChatClient } from '@masselabs/openstoa';
import { Commands } from '../commands';
import { MemorySessionStore } from '../session';
function fixture(status = 201) {
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (new URL(url).pathname === '/api/topics/topic-1/join' && init?.method === 'POST') return new Response(JSON.stringify({ success: true, message: 'Awaiting approval' }), { status });
    return new Response(JSON.stringify({ error: 'Permission key allows topic/join only' }), { status: 403 });
  });
  const chat = new ChatClient({ baseUrl: 'https://openstoa.test', token: 'verified-login', apiKey: 'osk_join_only', fetch: fetch as typeof globalThis.fetch });
  const mlsJoin = vi.spyOn(chat, 'joinTopic');
  const commands = new Commands({ chat, baseUrl: 'https://openstoa.test', session: null, sessionStore: new MemorySessionStore() });
  return { commands, fetch, mlsJoin };
}
describe('topic membership join with a narrowly scoped permission key', () => {
  it.each([200, 201])('status %s completes membership without fetching topic details or starting MLS', async status => {
    const h = fixture(status);
    expect(await h.commands.topicJoin('topic-1')).toEqual({ topicId: 'topic-1', joined: true });
    expect(h.mlsJoin).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalledOnce();
    const [url, init] = h.fetch.mock.calls[0];
    expect(new URL(url).pathname).toBe('/api/topics/topic-1/join');
    expect(init?.method).toBe('POST'); expect(JSON.parse(init!.body as string)).toEqual({});
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer verified-login');
    expect(new Headers(init?.headers).get('x-openstoa-api-key')).toBe('osk_join_only');
  });
  it('proof-bearing membership still does not silently request chat permissions after successful mutation', async () => {
    const h = fixture();
    expect(await h.commands.topicJoin('topic-1', { proof: '0x01', publicInputs: '0x02' })).toEqual({ topicId: 'topic-1', joined: true });
    expect(h.mlsJoin).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(h.fetch.mock.calls[0][1]!.body as string)).toEqual({ proof: '0x01', publicInputs: '0x02' });
  });
  it('202 reports pending approval without claiming membership or initializing chat', async () => {
    const h = fixture(202);
    expect(await h.commands.topicJoin('topic-1')).toMatchObject({ topicId: 'topic-1', joined: false, pending: true });
    expect(h.mlsJoin).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalledOnce();
  });
  it('a membership refusal remains a refusal and never falls through to MLS', async () => {
    const h = fixture(403);
    await expect(h.commands.topicJoin('topic-1')).rejects.toMatchObject({ status: 403 });
    expect(h.mlsJoin).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.fetch.mock.calls[0][1]?.method).toBe('POST');
  });
});
