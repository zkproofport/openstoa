import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Commands } from '@masselabs/openstoa-commands';
import { registerTools, type ToolHost, type ToolResult } from '../tools';
import { OPERATION_CONTRACTS } from '../../../sdk/src/__tests__/operationContracts';
describe('MCP public operation parity', () => {
  it.each(OPERATION_CONTRACTS)('$id exposes matching schema and calls the shared core', async row => {
    const response = { rows: ['한글'], count: 0, enabled: false };
    const executeOperation = vi.fn().mockResolvedValue(response);
    const registry = new Map<string, { schema: Record<string, z.ZodTypeAny>; handler: (args: Record<string, unknown>) => Promise<ToolResult> }>();
    const host: ToolHost = { tool(name, _description, schema, handler) { expect(registry.has(name)).toBe(false); registry.set(name, { schema, handler }); } };
    registerTools(host, { executeOperation } as unknown as Commands);
    const tool = registry.get(`openstoa_${row.id}`)!;
    expect(tool).toBeDefined();
    const parsed = z.object(tool.schema).strict().parse(row.input);
    const result = await tool.handler(parsed);
    expect(executeOperation).toHaveBeenCalledExactlyOnceWith(row.id, row.input);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(response);
  });
  it('rejects incompatible badge names and string booleans', () => {
    const registry = new Map<string, Record<string, z.ZodTypeAny>>();
    registerTools({ tool(name, _description, schema) { registry.set(name, schema); } }, {} as Commands);
    const schema = z.object(registry.get('openstoa_profile_set_badge')!);
    expect(schema.safeParse({ type: 'oidc_login', visible: false }).success).toBe(true);
    expect(schema.safeParse({ type: 'workspace', visible: false }).success).toBe(false);
    expect(schema.safeParse({ type: 'oidc_login', visible: 'false' }).success).toBe(false);
  });
});

describe('explicit CLI alias and history tool parity', () => {
  it.each([
    ['openstoa_dm_send', 'dmSend', { topicId: 't1', text: '한글' }, ['t1', '한글']],
    ['openstoa_dm_read', 'dmRead', { topicId: 't1', before: 'm1' }, ['t1', { limit: undefined, since: undefined, before: 'm1' }]],
    ['openstoa_chat_history', 'chatHistory', { topicId: 't1' }, ['t1']],
    ['openstoa_dm_history', 'chatHistory', { topicId: 't1' }, ['t1']],
    ['openstoa_chat_share_keys', 'chatShareKeys', { topicId: 't1' }, ['t1']],
    ['openstoa_logout', 'logout', {}, []],
  ] as const)('%s calls %s', async (name, method, input, args) => {
    const handler = vi.fn().mockResolvedValue({ ok: true });
    const registry = new Map<string, (input: Record<string, unknown>) => Promise<ToolResult>>();
    registerTools({ tool(name, _description, _schema, handler) { registry.set(name, handler); } }, { [method]: handler } as unknown as Commands);
    const result = await registry.get(name)!({ ...input });
    expect(handler).toHaveBeenCalledExactlyOnceWith(...args);
    expect(result.isError).toBeUndefined();
  });
});

it('post update MCP schema permits explicit poll removal', () => {
  const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
  registerTools({ tool(name, _description, schema) { schemas.set(name, schema); } }, {} as Commands);
  expect(z.object(schemas.get('openstoa_post_update')!).parse({ postId: 'p1', poll: null })).toEqual({ postId: 'p1', poll: null });
});
