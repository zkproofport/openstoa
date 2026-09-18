import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Commands } from '@masselabs/openstoa-commands';
import { registerTools, type ToolResult } from '../tools';
const required = { status: 'proof_required', operationId: 'op1', requirement: { type: 'kyc', circuitType: 'coinbase_attestation' }, methods: ['app', 'ai'], expiresAt: '2099-01-01T00:00:00Z', message: 'KYC proof required', pollAfterMs: 1500 };
function harness() {
  const commands = { topicJoin: vi.fn().mockResolvedValue(required), topicCreate: vi.fn().mockResolvedValue(required), executeOperation: vi.fn().mockResolvedValue(required), proofContinue: vi.fn().mockResolvedValue({ ...required, status: 'pending' }), proofStatus: vi.fn().mockResolvedValue({ ...required, status: 'proof_ready' }), proofResume: vi.fn().mockResolvedValue({ ...required, status: 'completed', result: { joined: true } }), proofCancel: vi.fn().mockResolvedValue({ ...required, status: 'cancelled' }) };
  const registry = new Map<string, { schema: Record<string, z.ZodTypeAny>; run: (a: Record<string, unknown>) => Promise<ToolResult> }>();
  registerTools({ tool(name, _description, schema, run) { registry.set(name, { schema, run }); } }, commands as unknown as Commands);
  return { commands, registry, async call(name: string, input: Record<string, unknown> = {}) {
    const tool = registry.get(name)!;
    const response = await tool.run(z.object(tool.schema).strict().parse(input));
    expect(response.isError).toBeUndefined();
    return JSON.parse(response.content[0].text);
  } };
}
it.each([['openstoa_topic_join', { topicId: 't1' }], ['openstoa_topic_join_invite', { inviteCode: 'code' }], ['openstoa_topic_create', { title: 'T', proofType: 'kyc' }]] as const)('%s returns proof_required without implicit consent', async (name, args) => {
  const h = harness();
  expect(await h.call(name, args)).toEqual(required);
  expect(h.commands.proofContinue).not.toHaveBeenCalled();
});
it('exposes explicit consent, status, resume and cancel with no private-key argument', async () => {
  const h = harness();
  expect(h.registry.size).toBe(89);
  const schema = z.object(h.registry.get('openstoa_proof_continue')!.schema).strict();
  expect(schema.safeParse({ operationId: 'op1', method: 'ai' }).success).toBe(false);
  expect(schema.safeParse({ operationId: 'op1', method: 'ai', approved: false }).success).toBe(false);
  expect(schema.safeParse({ operationId: 'op1', method: 'ai', approved: true, privateKey: 'not-accepted' }).success).toBe(false);
  expect((await h.call('openstoa_proof_continue', { operationId: 'op1', method: 'ai', approved: true, provider: 'google' })).status).toBe('pending');
  expect(h.commands.proofContinue).toHaveBeenCalledExactlyOnceWith({ operationId: 'op1', method: 'ai', approved: true, provider: 'google' });
  expect((await h.call('openstoa_proof_status', { operationId: 'op1' })).status).toBe('proof_ready');
  expect(h.commands.proofResume).not.toHaveBeenCalled();
  expect((await h.call('openstoa_proof_resume', { operationId: 'op1' })).status).toBe('completed');
  expect(h.commands.proofResume).toHaveBeenCalledExactlyOnceWith('op1');
  expect((await h.call('openstoa_proof_cancel', { operationId: 'op1' })).status).toBe('cancelled');
  expect(h.commands.proofCancel).toHaveBeenCalledExactlyOnceWith('op1');
});
