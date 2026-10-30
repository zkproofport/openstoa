import { describe, it, expect } from 'vitest';
import { extractNullifier, extractScope, computeScopeHash, extractCountryCondition } from '@/lib/proof';
import { COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT, COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT, COINBASE_COUNTRY_PUBLIC_INPUT_COUNT, COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT } from '@zkproofport-app/core';
import { countryIssuerInputs } from './fixtures/trusted-proof';
import { ethers } from 'ethers';

// Generate mock publicInputs: one field element per byte
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
  // Each circuit's v2 layout, from core.
  const LAYOUTS = {
    coinbase_attestation: { count: COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT, layout: COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT },
    coinbase_country_attestation: { count: COINBASE_COUNTRY_PUBLIC_INPUT_COUNT, layout: COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT },
  } as const;
  const { count, layout } = LAYOUTS[circuit];
  const inputs: string[] = new Array(count).fill('0x' + '00'.padStart(64, '0'));
  const nullifierStart = layout.NULLIFIER_START;
  const scopeStart = layout.SCOPE_START;

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
    const inputs = generateMockPublicInputs(193);
    expect(() => extractNullifier(inputs, 'unknown_circuit')).toThrow(
      "Unknown circuit 'unknown_circuit' for nullifier extraction. Known: coinbase_attestation, coinbase_country_attestation, oidc_domain_attestation.",
    );
  });

  it.each(['mdl_kr_ownership', 'mdl_kr_age', 'mdl_kr_region'])('refuses the removed %s by name, for scope and nullifier', (circuit) => {
    const inputs = generateMockPublicInputs(193);
    const known = 'Known: coinbase_attestation, coinbase_country_attestation, oidc_domain_attestation.';
    expect(() => extractNullifier(inputs, circuit)).toThrow(`Unknown circuit '${circuit}' for nullifier extraction. ${known}`);
    expect(() => extractScope(inputs, circuit)).toThrow(`Unknown circuit '${circuit}' for scope extraction. ${known}`);
  });

  it('should not throw for all supported circuits', () => {
    const supportedCircuits = ['coinbase_attestation', 'coinbase_country_attestation', 'oidc_domain_attestation'];
    for (const circuit of supportedCircuits) {
      const inputs = generateMockPublicInputs(150);
      expect(() => extractNullifier(inputs, circuit)).not.toThrow('Unsupported circuit');
    }
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
    const inputs = generateMockPublicInputs(193);
    expect(() => extractScope(inputs, 'unknown_circuit')).toThrow(
      "Unknown circuit 'unknown_circuit' for scope extraction. Known: coinbase_attestation, coinbase_country_attestation, oidc_domain_attestation.",
    );
  });

  it('should not throw for all supported circuits', () => {
    const supportedCircuits = ['coinbase_attestation', 'coinbase_country_attestation', 'oidc_domain_attestation'];
    for (const circuit of supportedCircuits) {
      const inputs = generateMockPublicInputs(150);
      expect(() => extractScope(inputs, circuit)).not.toThrow('Unsupported circuit');
    }
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

// Coinbase Country v2: country_list 128-147, length 148, is_included 149,
// read through core's readCountryCondition.
describe('extractCountryCondition', () => {
  it('reads a single country', () => {
    expect(extractCountryCondition(countryIssuerInputs({ countries: ['KR'] }), 'coinbase_country_attestation'))
      .toEqual({ countryList: ['KR'], isIncluded: true });
  });

  it('reads several countries in proof order', () => {
    expect(extractCountryCondition(countryIssuerInputs({ countries: ['US', 'JP', 'KR'] }), 'coinbase_country_attestation'))
      .toEqual({ countryList: ['US', 'JP', 'KR'], isIncluded: true });
  });

  it('reads an exclusion flag', () => {
    expect(extractCountryCondition(countryIssuerInputs({ countries: ['KR'], isIncluded: 0 }), 'coinbase_country_attestation'))
      .toEqual({ countryList: ['KR'], isIncluded: false });
  });

  it.each([
    ['length 0', { countries: [], length: 0 }, /country_list_length/],
    ['length 11', { countries: Array(10).fill('KR'), length: 11 }, /country_list_length/],
    ['is_included 2', { countries: ['KR'], isIncluded: 2 }, /is_included/],
    ['lower-case code', { countries: ['kr'] }, /upper-case country code/],
    ['bytes past the length', { countries: ['KR', 'US'], length: 1 }, /past country_list_length/],
  ])('refuses %s', (_label, options, message) => {
    expect(() => extractCountryCondition(countryIssuerInputs(options), 'coinbase_country_attestation')).toThrow(message);
  });

  it('refuses another circuit', () => {
    expect(() => extractCountryCondition(countryIssuerInputs(), 'coinbase_attestation')).toThrow(
      'Unsupported circuit for country list extraction',
    );
  });

  it('refuses a v1 (150-input) vector by its count', () => {
    expect(() => extractCountryCondition(countryIssuerInputs().slice(0, 150), 'coinbase_country_attestation')).toThrow(
      /Expected 215 public inputs; got 150/,
    );
  });
});
