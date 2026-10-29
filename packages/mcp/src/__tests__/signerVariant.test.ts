/**
 * signerVariant on the three MCP tools that carry a topic proof. The schema a
 * client sees accepts exactly standard / android / android_factory and refuses
 * anything else with a message naming the value and the accepted ones; the
 * handler passes an accepted value to the shared command unchanged and leaves an
 * absent one absent.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Commands } from '@masselabs/openstoa-commands';
import { registerTools, type ToolHost, type ToolResult } from '../tools';

const VARIANTS = ['standard', 'android', 'android_factory'] as const;
const UNKNOWN: unknown[] = ['ios', '', 'ANDROID', ' android', 'аndroid', '__proto__', 42, null, {}, ['android'], true];
const tools = {
  openstoa_topic_create: { args: { title: 'T', categoryId: 'c1', proofType: 'kyc' }, method: 'topicCreate', input: (call: unknown[]) => call[0] },
  openstoa_topic_join: { args: { topicId: 't1' }, method: 'topicJoin', input: (call: unknown[]) => call[1] },
  openstoa_topic_join_invite: { args: { inviteCode: 'code' }, method: 'executeOperation', input: (call: unknown[]) => call[1] },
} as const;
type Name = keyof typeof tools;

function registered() {
  const schemas = new Map<string, Record<string, z.ZodTypeAny>>();
  const handlers = new Map<string, (a: Record<string, unknown>) => Promise<ToolResult>>();
  const host: ToolHost = { tool: (name, _description, schema, handler) => { schemas.set(name, schema as Record<string, z.ZodTypeAny>); handlers.set(name, handler); } };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const commands = new Proxy({}, { get: (_target, method: string) => async (...args: unknown[]) => { calls.push({ method, args }); return { ok: true }; } }) as unknown as Commands;
  registerTools(host, commands);
  return { schemas, handlers, calls };
}
const proof = { proof: '0xab', publicInputs: '0xcd' };

describe.each(Object.keys(tools) as Name[])('%s signerVariant', name => {
  const tool = tools[name];
  it('advertises the three values to the client', () => {
    const field = registered().schemas.get(name)!.signerVariant;
    expect(field).toBeDefined();
    for (const value of VARIANTS) expect(field.safeParse(value).success).toBe(true);
    expect(field.safeParse(undefined).success).toBe(true);
  });
  it.each(VARIANTS)('passes %s to the command unchanged', async signerVariant => {
    const { schemas, handlers, calls } = registered();
    const args = z.object(schemas.get(name)!).parse({ ...tool.args, ...proof, signerVariant });
    await handlers.get(name)!(args);
    expect(tool.input(calls.find(call => call.method === tool.method)!.args)).toMatchObject({ ...proof, signerVariant });
  });
  it('leaves an absent value absent', async () => {
    const { schemas, handlers, calls } = registered();
    await handlers.get(name)!(z.object(schemas.get(name)!).parse({ ...tool.args, ...proof }));
    expect((tool.input(calls.find(call => call.method === tool.method)!.args) as Record<string, unknown>).signerVariant).toBeUndefined();
  });
  it.each(UNKNOWN)('refuses %j naming it and the accepted values', value => {
    const result = z.object(registered().schemas.get(name)!).safeParse({ ...tool.args, ...proof, signerVariant: value });
    expect(result.success).toBe(false);
    const message = result.success ? '' : result.error.issues.map(issue => issue.message).join(' ');
    expect(message).toContain('Expected one of standard, android, android_factory.');
    expect(message).toContain(typeof value === 'string' ? JSON.stringify(value) : 'a value of type');
  });
});
