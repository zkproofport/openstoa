import { describe, expect, it, vi } from 'vitest';
import type { Commands } from '@masselabs/openstoa-commands';
import { buildProgram } from '../cli';
import { OPERATION_CONTRACTS } from '../../../sdk/src/__tests__/operationContracts';
describe('CLI public operation parity', () => {
  it.each(OPERATION_CONTRACTS)('$id parses real flags and preserves JSON output', async row => {
    const response = { rows: ['한글'], count: 0, enabled: false };
    const executeOperation = vi.fn().mockResolvedValue(response);
    const output: string[] = [];
    const program = buildProgram(async () => ({ executeOperation } as unknown as Commands), text => output.push(text));
    program.exitOverride();
    await program.parseAsync(['node', 'openstoa', '--json', ...row.cli]);
    expect(executeOperation).toHaveBeenCalledExactlyOnceWith(row.id, row.input);
    expect(JSON.parse(output.join(''))).toEqual(response);
  });
  it.each([
    ['notifications', 'set', '--enabled', 'no'], ['feed', '--limit', '2x'],
    ['topics', 'invite', 't1', '--expires-in-hours', '1.5'],
  ])('rejects malformed flag input before dispatch: %s', async (...args) => {
    const factory = vi.fn();
    const program = buildProgram(factory).exitOverride();
    await expect(program.parseAsync(['node', 'openstoa', ...args])).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('explicit history command parity', () => {
  it.each([['chat', 'history', 'chatHistory'], ['dm', 'history', 'chatHistory'], ['chat', 'share-keys', 'chatShareKeys']])('%s %s invokes SDK-backed command', async (group, leaf, method) => {
    const handler = vi.fn().mockResolvedValue(method === 'chatShareKeys' ? { shared: 2 } : [{ messageId: 'm1', plaintext: 'hello' }]);
    const output: string[] = [];
    const program = buildProgram(async () => ({ [method]: handler } as unknown as Commands), text => output.push(text));
    await program.parseAsync(['node', 'openstoa', '--json', group, leaf, 't1']);
    expect(handler).toHaveBeenCalledExactlyOnceWith('t1');
    expect(JSON.parse(output.join(''))).toEqual(await handler.mock.results[0].value);
  });
});

it('post update can remove an unvoted poll and clear tags using the actual API payload', async () => {
  const postUpdate = vi.fn().mockResolvedValue({ id: 'p1' });
  const program = buildProgram(async () => ({ postUpdate } as unknown as Commands), () => {});
  await program.parseAsync(['node', 'openstoa', '--json', 'post', 'update', 'p1', '--poll', 'null', '--tags', '']);
  expect(postUpdate).toHaveBeenCalledWith('p1', expect.objectContaining({ poll: null, tags: [] }));
});
