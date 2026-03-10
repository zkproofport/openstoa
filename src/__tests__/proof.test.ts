import { describe, it, expect } from 'vitest';
import { extractNullifier, extractScope, computeScopeHash } from '@/lib/proof';
import { ethers } from 'ethers';

// Generate mock publicInputs: 128 hex strings for coinbase_attestation
function generateMockPublicInputs(length: number): string[] {
  const inputs: string[] = [];
  for (let i = 0; i < length; i++) {
    // Each field element is a single byte value (0-255) as a hex string
    inputs.push('0x' + (i % 256).toString(16).padStart(64, '0'));
  }
  return inputs;
}

// Generate publicInputs with specific bytes at nullifier/scope positions
function generateMockWithKnownValues(
  circuit: 'coinbase_attestation' | 'coinbase_country_attestation',
  nullifierBytes: number[],
  scopeBytes: number[],
): string[] {
  const length = circuit === 'coinbase_attestation' ? 128 : 150;
  const inputs: string[] = new Array(length).fill(
    '0x' + '00'.padStart(64, '0'),
  );

  let nullifierStart: number;
  let scopeStart: number;

  if (circuit === 'coinbase_attestation') {
    nullifierStart = 96;
    scopeStart = 64;
  } else {
    nullifierStart = 118;
    scopeStart = 86;
  }

  for (let i = 0; i < 32; i++) {
    inputs[nullifierStart + i] =
      '0x' + nullifierBytes[i].toString(16).padStart(64, '0');
    inputs[scopeStart + i] =
      '0x' + scopeBytes[i].toString(16).padStart(64, '0');
  }

  return inputs;
}

describe('extractNullifier', () => {
  it('should extract nullifier from coinbase_attestation publicInputs', () => {
    const nullifierBytes = Array.from({ length: 32 }, (_, i) => (i + 1) % 256);
    const scopeBytes = Array.from({ length: 32 }, () => 0);
    const inputs = generateMockWithKnownValues(
      'coinbase_attestation',
      nullifierBytes,
      scopeBytes,
    );

    const nullifier = extractNullifier(inputs, 'coinbase_attestation');

    // Should be a 0x-prefixed hex string of 32 bytes
    expect(nullifier).toMatch(/^0x[0-9a-f]{64}$/);

    // Verify reconstructed bytes match
    const expectedHex =
      '0x' +
      nullifierBytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(nullifier).toBe(expectedHex);
  });

  it('should extract nullifier from coinbase_country_attestation publicInputs', () => {
    const nullifierBytes = Array.from({ length: 32 }, (_, i) => (i + 10) % 256);
    const scopeBytes = Array.from({ length: 32 }, () => 0);
    const inputs = generateMockWithKnownValues(
      'coinbase_country_attestation',
      nullifierBytes,
      scopeBytes,
    );

    const nullifier = extractNullifier(inputs, 'coinbase_country_attestation');

    expect(nullifier).toMatch(/^0x[0-9a-f]{64}$/);

    const expectedHex =
      '0x' +
      nullifierBytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(nullifier).toBe(expectedHex);
  });

  it('should throw for unsupported circuit', () => {
    const inputs = generateMockPublicInputs(128);
    expect(() => extractNullifier(inputs, 'unknown_circuit')).toThrow(
      'Unsupported circuit for nullifier extraction',
    );
  });

  it('should produce deterministic results', () => {
    const nullifierBytes = Array.from({ length: 32 }, (_, i) => i);
    const scopeBytes = Array.from({ length: 32 }, () => 0);
    const inputs = generateMockWithKnownValues(
      'coinbase_attestation',
      nullifierBytes,
      scopeBytes,
    );

    const result1 = extractNullifier(inputs, 'coinbase_attestation');
    const result2 = extractNullifier(inputs, 'coinbase_attestation');
    expect(result1).toBe(result2);
  });
});

describe('extractScope', () => {
  it('should extract scope from coinbase_attestation publicInputs', () => {
    const nullifierBytes = Array.from({ length: 32 }, () => 0);
    const scopeBytes = Array.from({ length: 32 }, (_, i) => (i + 5) % 256);
    const inputs = generateMockWithKnownValues(
      'coinbase_attestation',
      nullifierBytes,
      scopeBytes,
    );

    const scope = extractScope(inputs, 'coinbase_attestation');

    expect(scope).toMatch(/^0x[0-9a-f]{64}$/);

    const expectedHex =
      '0x' + scopeBytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(scope).toBe(expectedHex);
  });

  it('should extract scope from coinbase_country_attestation publicInputs', () => {
    const nullifierBytes = Array.from({ length: 32 }, () => 0);
    const scopeBytes = Array.from({ length: 32 }, (_, i) => (i + 20) % 256);
    const inputs = generateMockWithKnownValues(
      'coinbase_country_attestation',
      nullifierBytes,
      scopeBytes,
    );

    const scope = extractScope(inputs, 'coinbase_country_attestation');

    expect(scope).toMatch(/^0x[0-9a-f]{64}$/);

    const expectedHex =
      '0x' + scopeBytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(scope).toBe(expectedHex);
  });

  it('should throw for unsupported circuit', () => {
    const inputs = generateMockPublicInputs(128);
    expect(() => extractScope(inputs, 'unknown_circuit')).toThrow(
      'Unsupported circuit for scope extraction',
    );
  });
});

describe('computeScopeHash', () => {
  it('should match ethers keccak256 of utf8 bytes', () => {
    const scopeString = 'zkproofport-community';
    const hash = computeScopeHash(scopeString);
    const expected = ethers.keccak256(ethers.toUtf8Bytes(scopeString));
    expect(hash).toBe(expected);
  });

  it('should produce different hashes for different inputs', () => {
    const hash1 = computeScopeHash('scope-a');
    const hash2 = computeScopeHash('scope-b');
    expect(hash1).not.toBe(hash2);
  });

  it('should produce deterministic results', () => {
    const hash1 = computeScopeHash('test-scope');
    const hash2 = computeScopeHash('test-scope');
    expect(hash1).toBe(hash2);
  });
});
