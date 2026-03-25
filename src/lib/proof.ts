import { ethers } from 'ethers';
import { createSDK } from './relay';
import {
  extractScopeFromPublicInputs,
  extractNullifierFromPublicInputs,
  extractDomainFromPublicInputs,
  COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT,
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


const SUPPORTED_CIRCUITS = ['coinbase_attestation', 'coinbase_country_attestation'];

export function extractNullifier(publicInputs: string[], circuit: string): string {
  if (!SUPPORTED_CIRCUITS.includes(circuit)) {
    throw new Error(`Unsupported circuit for nullifier extraction: ${circuit}`);
  }
  const nullifier = extractNullifierFromPublicInputs(publicInputs, circuit);
  if (!nullifier) throw new Error(`Failed to extract nullifier for circuit: ${circuit}`);
  return nullifier;
}

export function extractScope(publicInputs: string[], circuit: string): string {
  if (!SUPPORTED_CIRCUITS.includes(circuit)) {
    throw new Error(`Unsupported circuit for scope extraction: ${circuit}`);
  }
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

/**
 * Extract country list from coinbase_country_attestation public inputs.
 * country_list occupies indices 64-83 (20 bytes, up to 10 countries).
 * country_list_length at index 84 indicates how many are used.
 * Each country is 2 ASCII bytes (ISO 3166-1 alpha-2).
 */
export function extractCountryList(publicInputs: string[], circuit: string): string[] {
  if (circuit !== 'coinbase_country_attestation') {
    throw new Error(`Unsupported circuit for country_list extraction: ${circuit}`);
  }
  const lengthField = publicInputs[COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT.COUNTRY_LIST_LENGTH];
  if (lengthField === undefined) {
    throw new Error('publicInputs too short: missing country_list_length field');
  }
  const countryCount = Number(BigInt(lengthField));
  const countries: string[] = [];
  const start = COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT.COUNTRY_LIST_START;
  for (let i = 0; i < countryCount * 2; i += 2) {
    const byte1 = Number(BigInt(publicInputs[start + i]));
    const byte2 = Number(BigInt(publicInputs[start + i + 1]));
    countries.push(String.fromCharCode(byte1) + String.fromCharCode(byte2));
  }
  return countries;
}

/**
 * Extract domain from OIDC domain attestation public inputs.
 * Delegates to @zkproofport-app/sdk's extractDomainFromPublicInputs.
 * For AI agent path, use @zkproofport-ai/sdk's version instead.
 */
export function extractDomain(publicInputs: string[], circuit: string): string | null {
  return extractDomainFromPublicInputs(publicInputs, circuit);
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
  // oidc_domain_attestation: 148 fields (BoundedVec<u8,64> + scope + nullifier + provider)
  // coinbase_country_attestation: 150 fields
  // coinbase_attestation: 128 fields
  const len = publicInputs.length;
  if (len === 148) return 'oidc_domain_attestation';
  if (len > 128) return 'coinbase_country_attestation';
  return 'coinbase_attestation';
}
