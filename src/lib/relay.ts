import { ethers } from 'ethers';
import { ProofportSDK } from '@zkproofport-app/sdk';
import type { RelayProofResult } from '@zkproofport-app/sdk';

function createSDK(): ProofportSDK {
  const relayUrl = process.env.RELAY_URL;

  let sdk: ProofportSDK;
  if (relayUrl) {
    // Local Docker or custom relay
    sdk = new ProofportSDK({ relayUrl });
  } else {
    // Production relay (used by both staging and production)
    sdk = ProofportSDK.create();
  }

  // Ephemeral random wallet per request — only used for relay nonce replay prevention
  sdk.setSigner(ethers.Wallet.createRandom());
  return sdk;
}

export async function createRelayProofRequest(
  scope: string,
  options?: { dappName?: string; dappIcon?: string; message?: string },
): Promise<{ requestId: string; deepLink: string }> {
  const sdk = createSDK();
  const relay = await sdk.createRelayRequest('coinbase_attestation', { scope }, {
    dappName: options?.dappName ?? 'ZK Community',
    dappIcon: options?.dappIcon ?? 'https://stg-community.zkproofport.app/icon.svg',
    message: options?.message ?? 'Verify your Coinbase KYC to access ZK Community',
  } as Record<string, string>);
  return { requestId: relay.requestId, deepLink: relay.deepLink };
}

export async function pollProofResult(
  requestId: string,
): Promise<RelayProofResult> {
  const sdk = createSDK();
  return sdk.pollResult(requestId);
}

export { createSDK };
