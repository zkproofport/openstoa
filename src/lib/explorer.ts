// Resolves a block explorer URL for a given transaction hash on the
// chain OpenStoa records on (Base). Environment-driven: the chain
// changes between local/staging (Base Sepolia) and production
// (Base Mainnet) and the explorer host follows.

const DEFAULT_EXPLORER = 'https://sepolia.basescan.org';

export function getExplorerBaseUrl(): string {
  // Allow an explicit override (e.g. when pointing local dev at a
  // private testnet); otherwise infer from the RPC URL we're already
  // configured against.
  const override = process.env.BASE_EXPLORER_URL;
  if (override) return override.replace(/\/$/, '');
  const rpc = process.env.BASE_SEPOLIA_RPC_URL ?? process.env.BASE_RPC_URL ?? '';
  if (rpc.includes('sepolia')) return 'https://sepolia.basescan.org';
  if (rpc.includes('base-mainnet') || rpc.includes('mainnet.base.org')) return 'https://basescan.org';
  return DEFAULT_EXPLORER;
}

export function txExplorerUrl(txHash: string | null | undefined): string | null {
  if (!txHash) return null;
  return `${getExplorerBaseUrl()}/tx/${txHash}`;
}
