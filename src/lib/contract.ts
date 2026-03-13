import { ethers } from 'ethers';
import { logger } from '@/lib/logger';

const LIB = 'lib/contract';

const ABI = [
  'function record(bytes32 postIdHash, bytes32 contentHash, bytes32 authorNullifier, bytes32 recorderNullifier)',
  'function getRecordCount(bytes32 postIdHash) view returns (uint256)',
  'function getRecords(bytes32 postIdHash) view returns (tuple(bytes32 contentHash, bytes32 authorNullifier, bytes32 recorderNullifier, uint256 timestamp)[])',
  'function hasRecorded(bytes32) view returns (bool)',
  'function totalRecords() view returns (uint256)',
  'event ContentRecorded(bytes32 indexed postIdHash, bytes32 contentHash, bytes32 authorNullifier, bytes32 recorderNullifier, uint256 timestamp)',
];

let _provider: ethers.JsonRpcProvider | null = null;

function getProvider(): ethers.JsonRpcProvider {
  if (_provider) return _provider;

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
  if (!rpcUrl) throw new Error('BASE_SEPOLIA_RPC_URL environment variable is required');

  _provider = new ethers.JsonRpcProvider(rpcUrl);
  return _provider;
}

function getContract(signer?: ethers.Wallet): ethers.Contract {
  const address = process.env.RECORD_BOARD_ADDRESS;
  if (!address) throw new Error('RECORD_BOARD_ADDRESS environment variable is required');

  const runner = signer ?? getProvider();
  return new ethers.Contract(address, ABI, runner);
}

export async function recordOnChain(
  postIdHash: string,
  contentHash: string,
  authorNullifier: string,
  recorderNullifier: string,
): Promise<{ txHash: string; blockNumber: number }> {
  const privateKey = process.env.RECORD_SERVICE_PRIVATE_KEY;
  if (!privateKey) throw new Error('RECORD_SERVICE_PRIVATE_KEY environment variable is required');

  const wallet = new ethers.Wallet(privateKey, getProvider());
  const contract = getContract(wallet);

  logger.info(LIB, 'Submitting record TX', { postIdHash, contentHash });

  let tx: ethers.TransactionResponse;
  try {
    tx = await contract.record(postIdHash, contentHash, authorNullifier, recorderNullifier);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(LIB, 'Failed to send record TX', { error: message });
    throw new Error(`record TX failed: ${message}`);
  }

  logger.info(LIB, 'Record TX sent, awaiting confirmation', { txHash: tx.hash });

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await tx.wait(1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(LIB, 'Record TX confirmation failed', { txHash: tx.hash, error: message });
    throw new Error(`record TX confirmation failed: ${message}`);
  }

  if (!receipt) {
    throw new Error(`record TX receipt is null for txHash: ${tx.hash}`);
  }

  logger.info(LIB, 'Record TX confirmed', { txHash: tx.hash, blockNumber: receipt.blockNumber });

  return { txHash: tx.hash, blockNumber: receipt.blockNumber };
}

export async function getOnChainRecordCount(postIdHash: string): Promise<bigint> {
  const contract = getContract();
  const count: bigint = await contract.getRecordCount(postIdHash);
  return count;
}
