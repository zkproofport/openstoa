import { describe, expect, it, vi } from 'vitest';
import { ChatClient } from '../chatClient';
import { OpenStoaClient } from '../rest/openStoaClient';

describe('chat membership and narrow API keys', () => {
  function setup(member: boolean, joinStatus = 201, error = '') {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/join')) return new Response(JSON.stringify({ error }), { status: joinStatus });
      return new Response(JSON.stringify({ topic: { id: 't1', isMember: member } }));
    });
    const client = new ChatClient({ baseUrl: 'https://example.test', apiKey: 'osk_read_only', fetch });
    const sync = vi.fn().mockResolvedValue(undefined);
    const internals = client as unknown as { session(id: string): Promise<{ mls: { sync: typeof sync } }> };
    vi.spyOn(internals, 'session').mockResolvedValue({ mls: { sync } });
    return { client, fetch, sync };
  }
  it('does not require topic/join for existing-member chat reads', async () => {
    const { client, fetch, sync } = setup(true, 403, 'AI capability required');
    await client.joinTopic('t1');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toBe('https://example.test/api/topics/t1');
    expect(sync).toHaveBeenCalledExactlyOnceWith('t1');
  });
  it.each([400, 403, 409, 500])('stops before crypto sync on unrelated membership failure %i', async status => {
    const { client, sync } = setup(false, status, 'Refused');
    await expect(client.joinTopic('t1')).rejects.toThrow();
    expect(sync).not.toHaveBeenCalled();
  });
  it('handles only the exact concurrent already-member conflict idempotently', async () => {
    const { client, sync } = setup(false, 409, 'Already a member of this topic');
    await client.joinTopic('t1');
    expect(sync).toHaveBeenCalledOnce();
  });
  it('self-leave sends POST to /leave and retains the server idempotency result', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"success":true,"left":false}'));
    const client = new OpenStoaClient({ baseUrl: 'https://example.test', apiKey: 'osk_t', fetch });
    expect(await client.topics.leave('t1')).toEqual({ success: true, left: false });
    expect(fetch).toHaveBeenCalledWith('https://example.test/api/topics/t1/leave', expect.objectContaining({ method: 'POST' }));
  });
  it('AI verification sends the server-required result envelope, preserving proof metadata', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"token":"fresh","userId":"u1"}'));
    const client = new OpenStoaClient({ baseUrl: 'https://example.test', fetch });
    const input = { challengeId: 'c1', result: { proof: '0x01', publicInputs: '0x02', verification: { verified: true }, proofType: 'oidc', circuit: 'oidc_domain_attestation' } };
    await client.auth.verifyAi(input);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(input);
    expect(client.getToken()).toBe('fresh');
  });
});
