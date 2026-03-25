import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const mockWait = vi.fn().mockResolvedValue({ blockNumber: 12345 });
const mockRecord = vi.fn().mockResolvedValue({ hash: '0xtxhash', wait: mockWait });
const mockGetRecordCount = vi.fn().mockResolvedValue(BigInt(3));
const mockContract = { record: mockRecord, getRecordCount: mockGetRecordCount };

vi.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: vi.fn().mockImplementation(() => ({})),
    Wallet: vi.fn().mockImplementation(() => ({})),
    Contract: vi.fn().mockImplementation(() => mockContract),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

beforeAll(() => {
  process.env.BASE_SEPOLIA_RPC_URL = 'https://sepolia.base.org';
  process.env.RECORD_BOARD_ADDRESS = '0x1234567890abcdef';
  process.env.RECORD_SERVICE_PRIVATE_KEY = '0xdeadbeef';
});

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default happy-path mocks after clearAllMocks
  mockWait.mockResolvedValue({ blockNumber: 12345 });
  mockRecord.mockResolvedValue({ hash: '0xtxhash', wait: mockWait });
  mockGetRecordCount.mockResolvedValue(BigInt(3));
});

describe('recordOnChain', () => {
  it('returns txHash and blockNumber on success', async () => {
    const { recordOnChain } = await import('@/lib/contract');

    const result = await recordOnChain('0xpost', '0xcontent', '0xauthor', '0xrecorder');

    expect(result.txHash).toBe('0xtxhash');
    expect(result.blockNumber).toBe(12345);
    expect(mockRecord).toHaveBeenCalledWith('0xpost', '0xcontent', '0xauthor', '0xrecorder');
  });

  it('throws when TX send fails', async () => {
    mockRecord.mockRejectedValueOnce(new Error('nonce too low'));
    const { recordOnChain } = await import('@/lib/contract');

    await expect(
      recordOnChain('0xpost', '0xcontent', '0xauthor', '0xrecorder'),
    ).rejects.toThrow('record TX failed: nonce too low');
  });

  it('throws when TX confirmation fails', async () => {
    mockWait.mockRejectedValueOnce(new Error('timeout'));
    mockRecord.mockResolvedValueOnce({ hash: '0xtxhash', wait: mockWait });
    const { recordOnChain } = await import('@/lib/contract');

    await expect(
      recordOnChain('0xpost', '0xcontent', '0xauthor', '0xrecorder'),
    ).rejects.toThrow('record TX confirmation failed: timeout');
  });

  it('throws when RECORD_SERVICE_PRIVATE_KEY is missing', async () => {
    const saved = process.env.RECORD_SERVICE_PRIVATE_KEY;
    delete process.env.RECORD_SERVICE_PRIVATE_KEY;

    // Re-import to bypass module-level cache — use isolated module reset
    vi.resetModules();
    const { recordOnChain } = await import('@/lib/contract');

    await expect(
      recordOnChain('0xpost', '0xcontent', '0xauthor', '0xrecorder'),
    ).rejects.toThrow('RECORD_SERVICE_PRIVATE_KEY environment variable is required');

    process.env.RECORD_SERVICE_PRIVATE_KEY = saved;
    vi.resetModules();
  });
});

describe('getOnChainRecordCount', () => {
  it('returns bigint count from contract', async () => {
    const { getOnChainRecordCount } = await import('@/lib/contract');

    const count = await getOnChainRecordCount('0xpost');

    expect(count).toBe(BigInt(3));
    expect(mockGetRecordCount).toHaveBeenCalledWith('0xpost');
  });
});
