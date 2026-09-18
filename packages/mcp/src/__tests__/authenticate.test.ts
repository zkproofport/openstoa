import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenStoaApiError } from '@masselabs/openstoa';
import type { Commands } from '@masselabs/openstoa-commands';
import { registerTools, type ToolResult } from '../tools';
function harness() {
  const authenticate = vi.fn().mockResolvedValue({ status: 'consent_required', methods: ['app', 'ai'] });
  const whoami = vi.fn();
  const registry = new Map<string, { schema: Record<string, z.ZodTypeAny>; run: (a: Record<string, unknown>) => Promise<ToolResult> }>();
  registerTools({ tool(name, _description, schema, run) { registry.set(name, { schema, run }); } }, { authenticate, whoami } as unknown as Commands);
  const tool = () => { expect(registry.has('openstoa_authenticate')).toBe(true); return registry.get('openstoa_authenticate')!; };
  return { authenticate, whoami, registry, schema: () => z.object(tool().schema).strict(), async call(input: Record<string, unknown> = {}) {
    const result = await tool().run(z.object(tool().schema).strict().parse(input));
    expect(result.isError).toBeUndefined(); return JSON.parse(result.content[0].text);
  } };
}
it('registers authentication without removing any existing tool', () => { expect(harness().registry.size).toBe(89); });
it('an empty tool call requests consent without injecting approval', async () => {
  const h = harness(); expect(await h.call()).toMatchObject({ status: 'consent_required' });
  expect(h.authenticate).toHaveBeenCalledOnce(); expect(h.authenticate.mock.calls[0][0]?.approved).not.toBe(true);
});
it.each(['app', 'ai'])('forwards explicit %s consent and subsequent operation polling without implicit approval', async method => {
  const h = harness();
  h.authenticate.mockResolvedValueOnce({ status: 'pending', operationId: 'login-123', method }).mockResolvedValueOnce({ status: 'authenticated', operationId: 'login-123', userId: 'u1', nickname: '테스트🦉' });
  expect(await h.call({ method, approved: true })).toMatchObject({ status: 'pending', operationId: 'login-123' });
  expect(h.authenticate).toHaveBeenLastCalledWith(expect.objectContaining({ method, approved: true }));
  expect(await h.call({ operationId: 'login-123' })).toMatchObject({ status: 'authenticated', userId: 'u1' });
  expect(h.authenticate).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: 'login-123' }));
  expect(h.authenticate.mock.calls[1][0]?.approved).not.toBe(true);
});
it('forwards cancellation without approving another login', async () => {
  const h = harness(); h.authenticate.mockResolvedValue({ status: 'cancelled', operationId: 'login-123' });
  expect(await h.call({ operationId: 'login-123', cancel: true })).toMatchObject({ status: 'cancelled' });
  expect(h.authenticate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: 'login-123', cancel: true }));
});
it.each([{ method: 'unexpected' }, { approved: 'yes' }, { privateKey: 'secret' }, { codeVerifier: 'secret' }, { token: 'secret' }, { operationId: null }])('rejects malformed or secret-bearing tool arguments: %j', input => {
  const h = harness(); expect(h.schema().safeParse(input).success).toBe(false); expect(h.authenticate).not.toHaveBeenCalled();
});

it('an unauthenticated operation returns guidance without implicitly starting authentication', async () => {
  const h = harness();
  h.whoami.mockRejectedValue(new OpenStoaApiError(401, 'GET', '/api/auth/session', { error: 'Authentication required' }));
  const response = await h.registry.get('openstoa_whoami')!.run({});
  expect(response.isError).not.toBe(true);
  expect(JSON.parse(response.content[0].text)).toMatchObject({ status: 'authentication_required' });
  expect(h.authenticate).not.toHaveBeenCalled();
});
it.each(['API_KEY_REQUIRED', 'API_KEY_SCOPE_DENIED', 'API_KEY_OWNER_MISMATCH'])('403 %s remains an error and does not invite a login bypass', async code => {
  const h = harness();
  h.whoami.mockRejectedValue(new OpenStoaApiError(403, 'GET', '/api/profile', { error: 'Permission key refused', code }));
  const response = await h.registry.get('openstoa_whoami')!.run({});
  expect(response.isError).toBe(true); expect(h.authenticate).not.toHaveBeenCalled();
});
