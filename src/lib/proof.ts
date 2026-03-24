import { ethers } from 'ethers';
import { createSDK } from './relay';
import {
  extractScopeFromPublicInputs,
  extractNullifierFromPublicInputs,
  COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT,
  OIDC_DOMAIN_ATTESTATION_PUBLIC_INPUT_LAYOUT,
} from '@zkproofport-app/sdk';
import type { RelayProofResult } from '@zkproofport-app/sdk';

export const COMMUNITY_SCOPE = 'zkproofport-community';

export function normalizePublicInputs(input: string | string[]): string[] {
  if (Array.isArray(input)) return input;
  // Single hex string: strip 0x prefix, split into 64-char (32-byte) chunks, re-add 0x
  const hex = input.startsWith('0x') ? input.slice(2) : input;
  const chunks: string[] = [];
  for (let i = 0; i < hex.length; i += 64) {
    chunks.push('0x' + hex.slice(i, i + 64).padStart(64, '0'));
  }
  return chunks;
}

export async function verifyProofFromRelay(
  result: RelayProofResult,
): Promise<{ valid: boolean; error?: string }> {
  const sdk = createSDK();
  return sdk.verifyResponseOnChain(result as any);
}


export function extractNullifier(publicInputs: string[], circuit: string): string {
  const nullifier = extractNullifierFromPublicInputs(publicInputs, circuit);
  if (!nullifier) throw new Error(`Failed to extract nullifier for circuit: ${circuit}`);
  return nullifier;
}

export function extractScope(publicInputs: string[], circuit: string): string {
  const scope = extractScopeFromPublicInputs(publicInputs, circuit);
  if (!scope) throw new Error(`Failed to extract scope for circuit: ${circuit}`);
  return scope;
}

export function computeScopeHash(scopeString: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(scopeString));
}

export function extractIsIncluded(publicInputs: string[], circuit: string): boolean {
  if (circuit !== 'coinbase_country_attestation') {
    throw new Error(`Unsupported circuit for is_included extraction: ${circuit}`);
  }
  const isIncludedField = publicInputs[COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT.IS_INCLUDED];
  if (isIncludedField === undefined) {
    throw new Error('publicInputs too short: missing is_included field');
  }
  return BigInt(isIncludedField) === 1n;
}

export function extractDomain(publicInputs: string[], circuit: string): string | null {
  if (circuit !== 'oidc_domain_attestation') return null;
  // Noir BoundedVec<u8, 64> serializes as [storage[0..64], len] — storage FIRST, len LAST.
  // SDK layout DOMAIN_LEN (18) is actually storage[0], real len is at DOMAIN_END + 1 (83)
  // BUT SCOPE_START is also 83, so len overlaps. Use DOMAIN_END (82) as the len field.
  // Correct: storage starts at index 18, len at index 82, so storage is [18..81] (64 bytes)
  const storageStart = OIDC_DOMAIN_ATTESTATION_PUBLIC_INPUT_LAYOUT.DOMAIN_LEN; // 18 = first byte of storage
  const lenIdx = OIDC_DOMAIN_ATTESTATION_PUBLIC_INPUT_LAYOUT.DOMAIN_END; // 82 = BoundedVec len field
  if (publicInputs.length <= lenIdx) return null;
  const domainLen = Number(BigInt(publicInputs[lenIdx]));
  if (domainLen <= 0 || domainLen > 64) return null;
  const domainFields = publicInputs.slice(storageStart, storageStart + domainLen);
  const bytes = domainFields.map(f => Number(BigInt(f) & 0xFFn));
  return String.fromCharCode(...bytes);
}

// Known verifier addresses → circuit mapping (Base Mainnet)
const VERIFIER_CIRCUIT_MAP: Record<string, string> = {
  '0xf7ded73e7a7fc8fb030c35c5a88d40abe6865382': 'coinbase_attestation',
  '0x9677ba46ad226ce8b3c4517d9c0143e4d458beae': 'oidc_domain_attestation',
};

export function detectCircuit(publicInputs: string[], verifierAddress?: string): string {
  // 1. Use verifier address if available (most reliable)
  if (verifierAddress) {
    const circuit = VERIFIER_CIRCUIT_MAP[verifierAddress.toLowerCase()];
    if (circuit) return circuit;
  }
  // 2. Fallback to public input count
  const len = publicInputs.length;
  if (len >= 420) return 'oidc_domain_attestation';
  if (len > 128) return 'coinbase_country_attestation';
  return 'coinbase_attestation';
}
