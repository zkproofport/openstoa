import { describe, it, expect } from 'vitest';
import { extractNullifier, extractScope, computeScopeHash, extractCountryCondition } from '@/lib/proof';
import { COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT, COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT, COINBASE_COUNTRY_PUBLIC_INPUT_COUNT, COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT, reduceOprfName } from '@zkproofport-app/core';
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

// A wallet credential's nullifier and scope are ONE field each (the OPRF
// nullifier and keccak256(utf8(scope)) mod p), at core's layout offsets.
function generateMockWithKnownValues(
  circuit: 'coinbase_attestation' | 'coinbase_country_attestation',
  nullifier: string,
  scope: string,
): string[] {
  const LAYOUTS = {
    coinbase_attestation: { count: COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT, layout: COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT },
    coinbase_country_attestation: { count: COINBASE_COUNTRY_PUBLIC_INPUT_COUNT, layout: COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT },
  } as const;
  const { count, layout } = LAYOUTS[circuit];
  const inputs: string[] = new Array(count).fill('0x' + '00'.padStart(64, '0'));
  inputs[layout.NULLIFIER] = nullifier;
  inputs[layout.SCOPE] = scope;
  return inputs;
}
const field = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
const ZERO = field(0n);

describe('extractNullifier', () => {
  it.each(['coinbase_attestation', 'coinbase_country_attestation'] as const)('reads the OPRF nullifier field of %s, as 0x + 64 hex', (circuit) => {
    const nullifier = field(0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefn);
    const inputs = generateMockWithKnownValues(circuit, nullifier, ZERO);
    expect(extractNullifier(inputs, circuit)).toBe(nullifier);
  });

  it.each(['coinbase_attestation', 'coinbase_country_attestation'] as const)('a %s nullifier at or above the field modulus is refused, not read', (circuit) => {
    const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    expect(() => extractNullifier(generateMockWithKnownValues(circuit, field(P), ZERO), circuit)).toThrow();
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
    const inputs = generateMockWithKnownValues('coinbase_attestation', field(42n), ZERO);

    const result1 = extractNullifier(inputs, 'coinbase_attestation');
    const result2 = extractNullifier(inputs, 'coinbase_attestation');
    expect(result1).toBe(result2);
  });
});

describe('extractScope', () => {
  it.each(['coinbase_attestation', 'coinbase_country_attestation'] as const)('reads the scope field of %s: keccak256(scope) mod p', (circuit) => {
    const scope = reduceOprfName('zkproofport-community:topic:alice');
    const inputs = generateMockWithKnownValues(circuit, ZERO, scope);
    expect(extractScope(inputs, circuit)).toBe(scope);
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

  it.each([90, 150, 215])('refuses an earlier %i-input vector by its count', (n) => {
    const inputs = [...countryIssuerInputs(), ...Array(80).fill(ZERO)].slice(0, n);
    expect(() => extractCountryCondition(inputs, 'coinbase_country_attestation')).toThrow(
      new RegExp(`Expected 155 public inputs; got ${n}`),
    );
  });
});
