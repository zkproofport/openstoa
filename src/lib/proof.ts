import { ethers } from 'ethers';
import { createSDK } from './relay';
import {
  extractScopeFromPublicInputs,
  extractNullifierFromPublicInputs,
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
