import { ethers } from 'ethers';
import { createSDK } from './relay';

export const COMMUNITY_SCOPE = 'zkproofport-community';

export async function verifyProofOnChain(
  proof: string,
  publicInputs: string[],
  verifierAddress: string,
  rpcUrl: string,
  circuit: string = 'coinbase_attestation',
): Promise<{ valid: boolean; error?: string }> {
  const sdk = createSDK();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  return sdk.verifyOnChain(circuit as any, proof, publicInputs, provider);
}

function reconstructBytes32(fields: string[]): string {
  if (fields.length !== 32) {
    throw new Error(`Expected 32 field elements, got ${fields.length}`);
  }
  const bytes = fields.map((field) => {
    const bn = BigInt(field);
    return Number(bn & 0xffn);
  });
  return '0x' + bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function extractNullifier(publicInputs: string[], circuit: string): string {
  switch (circuit) {
    case 'coinbase_attestation': {
      const fields = publicInputs.slice(96, 128);
      return reconstructBytes32(fields);
    }
    case 'coinbase_country_attestation': {
      const fields = publicInputs.slice(118, 150);
      return reconstructBytes32(fields);
    }
    default:
      throw new Error(`Unsupported circuit for nullifier extraction: ${circuit}`);
  }
}

export function extractScope(publicInputs: string[], circuit: string): string {
  switch (circuit) {
    case 'coinbase_attestation': {
      const fields = publicInputs.slice(64, 96);
      return reconstructBytes32(fields);
    }
    case 'coinbase_country_attestation': {
      const fields = publicInputs.slice(86, 118);
      return reconstructBytes32(fields);
    }
    default:
      throw new Error(`Unsupported circuit for scope extraction: ${circuit}`);
  }
}

export function computeScopeHash(scopeString: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(scopeString));
}

export function extractIsIncluded(publicInputs: string[], circuit: string): boolean {
  switch (circuit) {
    case 'coinbase_country_attestation': {
      // publicInputs layout:
      //   fields 64-83: country_list (20 bytes)
      //   field 84:     country_list_length
      //   field 85:     is_included (1 = country IS in list, 0 = NOT in list)
      const isIncludedField = publicInputs[85];
      if (isIncludedField === undefined) {
        throw new Error('publicInputs too short: missing is_included field at index 85');
      }
      return BigInt(isIncludedField) === 1n;
    }
    default:
      throw new Error(`Unsupported circuit for is_included extraction: ${circuit}`);
  }
}
