import { describe, it, expect, beforeAll } from 'vitest';
import { JsonRpcProvider, Wallet, keccak256, toUtf8Bytes } from 'ethers';

beforeAll(() => {
  process.env.RECORD_BOARD_ADDRESS = '0x92EEe24b737272F81FAE0DFD3c2F6FDd05F099f0';
  process.env.RECORD_SERVICE_PRIVATE_KEY =
    '0x5c8eb0e0dcdcdabdc87f1fae3e992132e8a06b83188dfba625ca95036876bb0a';
  process.env.BASE_SEPOLIA_RPC_URL =
    'https://base-sepolia.g.alchemy.com/v2/_5AqsTbLxEFBr5tjslXzt';
});

/**
 * These tests send REAL transactions on Base Sepolia, so they stop working the
 * moment the signer runs out of gas — which is exactly what happened: the
 * balance fell below one transaction's cost mid-session and every run after
 * that failed with an ethers INSUFFICIENT_FUNDS dump that reads like the
 * on-chain recorder is broken.
 *
 * So check the balance first and SKIP with the real reason instead. The gate is
 * a live balance read, not a hardcoded flag, so the moment the wallet is topped
 * up these run again with no code change — nobody has to remember to re-enable
 * them.
 *
 * NOTE the signer key is hardcoded above and this repository is public, so that
 * address is world-readable and anyone can spend from it. Fund it with what a
 * test run costs and no more.
 */
let skipReason: string | null = null;

// One transaction has cost ~1.9e12 wei at recent Base Sepolia gas prices; keep
// a few runs' worth of headroom so the suite does not die mid-session again.
const MIN_BALANCE_WEI = 20_000_000_000_000n;

const seed = Date.now().toString();

const postIdHash = keccak256(toUtf8Bytes('e2e-test-post-' + seed));
const contentHash = keccak256(toUtf8Bytes('e2e-test-content-' + seed));
const authorNullifier = keccak256(toUtf8Bytes('e2e-test-author-' + seed));
const recorderNullifier = keccak256(toUtf8Bytes('e2e-test-recorder-' + seed));

describe.sequential('record-onchain', { timeout: 60000 }, () => {
  beforeAll(async () => {
    try {
      const provider = new JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
      const address = new Wallet(process.env.RECORD_SERVICE_PRIVATE_KEY!).address;
      const balance = await provider.getBalance(address);
      if (balance < MIN_BALANCE_WEI) {
        skipReason =
          `record-service wallet ${address} is out of gas on Base Sepolia ` +
          `(balance ${balance} wei, need at least ${MIN_BALANCE_WEI}). ` +
          'These tests broadcast real transactions; top the address up and they run again ' +
          'with no code change. The signer key is committed in this public repo, so keep the ' +
          'balance small.';
      }
    } catch (err) {
      // An unreachable RPC is NOT the same as an unfunded wallet — say which.
      skipReason = `Base Sepolia RPC unreachable, so funding could not be checked: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  });

  it('recordOnChain submits a real TX and gets confirmed', async (ctx) => {
    if (skipReason) ctx.skip(skipReason);
    const { recordOnChain } = await import('@/lib/contract');

    const result = await recordOnChain(postIdHash, contentHash, authorNullifier, recorderNullifier);

    expect(result.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(result.txHash.length).toBe(66);
    expect(result.blockNumber).toBeGreaterThan(0);
  });

  it('getOnChainRecordCount returns count >= 1 after recording', async (ctx) => {
    if (skipReason) ctx.skip(skipReason);
    const { getOnChainRecordCount } = await import('@/lib/contract');

    // Base Sepolia's multi-backend RPC has eventual-consistency lag after the
    // recording tx (Alchemy fan-out can return a stale read past tx.wait(1)).
    // Under full-suite load the default 2×200ms retry window is too short, so
    // widen it here (~5s) to absorb the lag. (C)-flake stabilization; see
    // .claude/agents/tester.md. Unrelated to MLS chat work.
    const count = await getOnChainRecordCount(postIdHash, { retries: 10, delayMs: 500 });

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
