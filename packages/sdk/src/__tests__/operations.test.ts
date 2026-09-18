import { describe, expect, it, vi } from 'vitest';
import { OpenStoaClient, OpenStoaApiError } from '../rest/openStoaClient';
import { REST_OPERATIONS, prepareRestOperation } from '../rest/operations';
import { OPERATION_CONTRACTS } from './operationContracts';

describe('public REST operation contracts', () => {
  it('has one independently specified request fixture for every operation', () => {
    expect(OPERATION_CONTRACTS.map(row => row.id).sort()).toEqual(REST_OPERATIONS.map(row => row.id).sort());
    expect(new Set(REST_OPERATIONS.map(row => row.cli.join(' '))).size).toBe(REST_OPERATIONS.length);
    expect(new Set(REST_OPERATIONS.map(row => row.tool)).size).toBe(REST_OPERATIONS.length);
  });
  it.each(OPERATION_CONTRACTS)('$id sends exact route/method/query/body and preserves JSON result', async row => {
    const result = { data: ['사용자 글'], count: 0, enabled: false, next: null };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(result)));
    const client = new OpenStoaClient({ baseUrl: 'https://example.test', token: 'verified-session', apiKey: 'osk_test', fetch });
    expect(await client.operation(row.id, row.input)).toEqual(result);
    const [url, init] = fetch.mock.calls[0];
    expect(new URL(url).pathname).toBe(row.path);
    expect(Object.fromEntries(new URL(url).searchParams)).toEqual(row.query ?? {});
    expect(init.method).toBe(row.method);
    expect(init.headers.Authorization).toBe('Bearer verified-session');
    expect(init.headers['X-OpenStoa-API-Key']).toBe('osk_test');
    expect(init.body === undefined ? undefined : JSON.parse(init.body)).toEqual(row.body);
  });
  it.each([undefined, null, '', ' ', 0, 1, false, [], {}])('rejects missing/non-string path %# before HTTP', async value => {
    const fetch = vi.fn();
    const client = new OpenStoaClient({ baseUrl: 'https://example.test', fetch });
    await expect(client.operation('post_vote', { postId: value, value: 1 })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([0, -1, 101, 200, 1.1, NaN, Infinity, '1', null])('rejects invalid feed pagination %#', value => {
    expect(() => prepareRestOperation('feed', { limit: value })).toThrow();
  });
  it('bounds numbers and preserves false/zero/Unicode/wildcard text', () => {
    expect(prepareRestOperation('feed', { limit: 1, offset: 0, q: '%_\\ 한글 🔒\n\t' }).options.query).toEqual({ limit: 1, offset: 0, q: '%_\\ 한글 🔒\n\t' });
    expect(prepareRestOperation('feed', { limit: 100 }).options.query.limit).toBe(100);
    expect(prepareRestOperation('notifications_set', { enabled: false }).options.body).toEqual({ enabled: false });
  });
  it('encodes path input, refuses unknown operations/args/enums and oversized questions', () => {
    expect(prepareRestOperation('topic_invite_lookup', { inviteCode: '../a?b#c' }).path).toBe('/api/topics/join/..%2Fa%3Fb%23c');
    expect(() => prepareRestOperation('__proto__', {})).toThrow('Unknown REST operation');
    expect(() => prepareRestOperation('feed', { limti: 1 })).toThrow('unknown argument');
    expect(() => prepareRestOperation('profile_set_badge', { type: 'workspace', visible: true })).toThrow('one of');
    expect(() => prepareRestOperation('notifications_set', { enabled: 'false' })).toThrow('boolean');
    expect(prepareRestOperation('topic_requests', { topicId: 't1', status: 'all' }).options.query.status).toBe('all');
    expect(() => prepareRestOperation('topic_requests', { topicId: 't1', status: 'approved' })).toThrow('one of');
    expect(() => prepareRestOperation('ask', { question: 'a'.repeat(1001) })).toThrow('1000');
  });
  it('preserves server authorization refusals without reporting success', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Not a member' }), { status: 403 }));
    const client = new OpenStoaClient({ baseUrl: 'https://example.test', token: 'verified-session', apiKey: 'osk_test', fetch });
    await expect(client.operation('post_pin', { postId: 'p1' })).rejects.toBeInstanceOf(OpenStoaApiError);
  });
  it('keeps invite proofs optional for open topics and server-side cache reuse', () => {
    expect(prepareRestOperation('topic_join_invite', { inviteCode: 'invite' }).options.body).toEqual({});
  });
  it.each(['proof', 'publicInputs'])('rejects non-string invite %s before HTTP', async field => {
    const fetch = vi.fn();
    const client = new OpenStoaClient({ baseUrl: 'https://example.test', token: 'verified-session', apiKey: 'osk_test', fetch });
    await expect(client.operation('topic_join_invite', { inviteCode: 'invite', [field]: ['0xab'] })).rejects.toThrow(`${field} must be`);
    expect(fetch).not.toHaveBeenCalled();
  });
});
