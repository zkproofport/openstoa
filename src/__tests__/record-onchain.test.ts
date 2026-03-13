import { describe, it, expect, beforeAll } from 'vitest';
import { keccak256, toUtf8Bytes } from 'ethers';

beforeAll(() => {
  process.env.RECORD_BOARD_ADDRESS = '0x92EEe24b737272F81FAE0DFD3c2F6FDd05F099f0';
  process.env.RECORD_SERVICE_PRIVATE_KEY =
    '0x5c8eb0e0dcdcdabdc87f1fae3e992132e8a06b83188dfba625ca95036876bb0a';
  process.env.BASE_SEPOLIA_RPC_URL =
    'https://base-sepolia.g.alchemy.com/v2/_5AqsTbLxEFBr5tjslXzt';
});

const seed = Date.now().toString();

const postIdHash = keccak256(toUtf8Bytes('e2e-test-post-' + seed));
const contentHash = keccak256(toUtf8Bytes('e2e-test-content-' + seed));
const authorNullifier = keccak256(toUtf8Bytes('e2e-test-author-' + seed));
const recorderNullifier = keccak256(toUtf8Bytes('e2e-test-recorder-' + seed));

describe.sequential('record-onchain', { timeout: 60000 }, () => {
  it('recordOnChain submits a real TX and gets confirmed', async () => {
    const { recordOnChain } = await import('@/lib/contract');

    const result = await recordOnChain(postIdHash, contentHash, authorNullifier, recorderNullifier);

    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.txHash.length).toBe(66);
    expect(result.blockNumber).toBeGreaterThan(0);
  });

  it('getOnChainRecordCount returns count >= 1 after recording', async () => {
    const { getOnChainRecordCount } = await import('@/lib/contract');

    const count = await getOnChainRecordCount(postIdHash);

    expect(count).toBeGreaterThanOrEqual(1n);
  });

  it('duplicate recording reverts (same postIdHash + recorderNullifier)', async () => {
    const { recordOnChain } = await import('@/lib/contract');

    // Same postIdHash + recorderNullifier → contract checks hasRecorded[keccak256(abi.encode(postIdHash, recorderNullifier))]
    await expect(
      recordOnChain(postIdHash, contentHash, authorNullifier, recorderNullifier),
    ).rejects.toThrow();
  });

  it('getOnChainRecordCount returns 0 for non-existent post', async () => {
    const { getOnChainRecordCount } = await import('@/lib/contract');

    const unknownPostIdHash = keccak256(toUtf8Bytes('nonexistent-post-' + seed));
    const count = await getOnChainRecordCount(unknownPostIdHash);

    expect(count).toBe(0n);
  });
});
