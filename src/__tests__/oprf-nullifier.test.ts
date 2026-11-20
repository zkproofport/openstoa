/**
 * OpenStoa on the OPRF nullifier (@zkproofport-app/core 0.4.0-beta.9).
 *
 * Edge matrix (each row maps to a test below):
 *  - scope encoding, per circuit, with scopes whose keccak256 is at or above
 *    the BN254 modulus p (so the encodings differ): coinbase_attestation and
 *    coinbase_country_attestation expect keccak256(scope) mod p, OIDC the raw
 *    keccak256; an unknown circuit ('', prototype keys, giwa_attestation,
 *    upper case) throws naming the known ones; Korean / emoji scopes; a scope
 *    with a control character (tab, NUL) cannot be an OPRF name: it throws for
 *    a wallet circuit and never matches, while OIDC still hashes it.
 *  - scopeFieldMatches (the browser proof page's check): the right value in
 *    either hex case matches; the raw keccak256 for a wallet circuit, another
 *    scope, non-hex, over-long, a number, undefined and an unknown circuit
 *    do not.
 *  - the topic gate's scope check (proofScopeMatches) on real public inputs:
 *    the reduced scope matches; the raw keccak256 written into the scope field
 *    is refused (core reads it as a value at or above p).
 *  - OPRF domain on a submitted proof (no request known): OpenStoa's domain for
 *    APP_ENV verifies; another domain, the scope written into the domain field
 *    (swapped) and a zero domain are refused before any contract call.
 *  - OPRF key hash: a key hash other than the one core pins for the
 *    environment is refused before the contract call; production has no key.
 *  - relay request (walletRequest): the right { scope, requestId, oprfDomain }
 *    verifies; a proof made for another requestId (signal_hash), another
 *    scope, or a request naming another OPRF domain is refused before the
 *    contract call; an action-bound proof (action_hash set) with a non-zero
 *    signal_hash is refused.
 *  - oprfDomainError: a wrong count names it; a value at or above p is refused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  clearOidcKeyCache,
  COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT,
  COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT,
  COINBASE_COUNTRY_PUBLIC_INPUT_COUNT,
  reduceOprfName,
} from '@zkproofport-app/core';
import { coinbaseIssuerInputs, countryIssuerInputs, encodedBool, jwksFetch, proofField, STAGING_OPRF_DOMAIN } from './fixtures/trusted-proof';

const state = vi.hoisted(() => ({ calls: [] as string[], result: vi.fn() }));
vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  class FakeProvider {
    constructor(_url: string) {}
    async call(tx: { to: string }) { state.calls.push(String(tx.to).toLowerCase()); return state.result(); }
  }
  return { ...actual, ethers: { ...actual.ethers, JsonRpcProvider: FakeProvider } };
});
vi.mock('@/lib/redis', () => ({ redis: { get: async () => null, set: async () => 'OK' } }));

import { verifyTrustedTopicProof, proofScopeMatches, expectedScopeField, oprfDomainError, OPRF_SETTINGS } from '@/lib/proof';
import { scopeFieldFor, scopeFieldMatches, isOprfCircuit } from '@/lib/proofScopeField';

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const keccak = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
const WALLET = ['coinbase_attestation', 'coinbase_country_attestation'] as const;
const KR = { countryList: ['KR'], isIncluded: true };
const REQUEST_ID = '6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f';
const STANDARD = '0x' + 'ab'.repeat(32 * (82 + 12 * 20));

/** Scopes of each shape whose keccak256 is at or above p, found by search so the property is real. */
function aboveP(prefix: string): string {
  for (let n = 0; n < 2000; n++) {
    const scope = `${prefix}${n}`;
    if (BigInt(keccak(scope)) >= P) return scope;
  }
  throw new Error(`no ${prefix}<n> above p`);
}
const HIGH_SCOPES = [aboveP('zkproofport-community:topic:u'), aboveP('topic:사용자'), aboveP('scope 🚀 ')];

function walletInputs(circuit: typeof WALLET[number], options: Parameters<typeof coinbaseIssuerInputs>[1] = {}): string[] {
  return circuit === 'coinbase_attestation'
    ? coinbaseIssuerInputs(COINBASE_ATTESTATION_PUBLIC_INPUT_COUNT, options)
    : countryIssuerInputs({ countries: ['KR'], ...options });
}
const country = (circuit: string) => (circuit === 'coinbase_country_attestation' ? KR : undefined);

beforeEach(() => {
  state.calls.length = 0;
  state.result.mockReset().mockResolvedValue(encodedBool(true));
  clearOidcKeyCache();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(jwksFetch()));
  vi.stubEnv('APP_ENV', 'staging');
});

describe('the scope value a proof carries, per circuit', () => {
  it.each(HIGH_SCOPES)('scope %j really has keccak256 >= p', (scope) => {
    expect(BigInt(keccak(scope))).toBeGreaterThanOrEqual(P);
    expect(BigInt(reduceOprfName(scope))).toBe(BigInt(keccak(scope)) % P);
  });

  it.each(WALLET.flatMap((circuit) => HIGH_SCOPES.map((scope) => [circuit, scope] as const)))(
    '%s over %j: keccak256(scope) mod p, never the raw keccak256', (circuit, scope) => {
      expect(scopeFieldFor(scope, circuit)).toBe(reduceOprfName(scope));
      expect(expectedScopeField(scope, circuit)).toBe(reduceOprfName(scope));
      expect(scopeFieldFor(scope, circuit)).not.toBe(keccak(scope));
    });

  it.each(HIGH_SCOPES)('oidc_domain_attestation over %j: the raw keccak256', (scope) => {
    expect(scopeFieldFor(scope, 'oidc_domain_attestation')).toBe(keccak(scope));
  });

  it.each(['', '__proto__', 'constructor', 'giwa_attestation', 'COINBASE_ATTESTATION', 'mdl_kr_age'])(
    'circuit %j throws naming the known circuits', (circuit) => {
      expect(() => scopeFieldFor('s', circuit)).toThrow(/Known: coinbase_attestation, coinbase_country_attestation, oidc_domain_attestation/);
      expect(() => expectedScopeField('s', circuit)).toThrow(/Known: coinbase_attestation, coinbase_country_attestation, oidc_domain_attestation/);
    });

  it.each(['scope\twith tab', 'nul\u0000byte', ''])('a scope %j that cannot be an OPRF name throws for a wallet circuit and never matches', (scope) => {
    for (const circuit of WALLET) {
      expect(() => scopeFieldFor(scope, circuit)).toThrow();
      expect(scopeFieldMatches(reduceOprfName('x'), scope, circuit)).toBe(false);
    }
    expect(scopeFieldFor(scope, 'oidc_domain_attestation')).toBe(keccak(scope));
  });

  it('isOprfCircuit: exactly the two wallet circuits OpenStoa accepts', () => {
    expect(['coinbase_attestation', 'coinbase_country_attestation', 'oidc_domain_attestation', 'giwa_attestation', '__proto__'].filter(isOprfCircuit))
      .toEqual(['coinbase_attestation', 'coinbase_country_attestation']);
  });
});

describe('scopeFieldMatches, the browser proof page\'s check', () => {
  const scope = HIGH_SCOPES[0];
  it.each(WALLET)('%s: the reduced value matches in either hex case', (circuit) => {
    const value = reduceOprfName(scope);
    expect(scopeFieldMatches(value, scope, circuit)).toBe(true);
    expect(scopeFieldMatches('0x' + value.slice(2).toUpperCase(), scope, circuit)).toBe(true);
  });
  it('OIDC: the raw keccak256 matches', () => {
    expect(scopeFieldMatches(keccak(scope), scope, 'oidc_domain_attestation')).toBe(true);
  });
  it.each([
    ['the raw keccak256 for a wallet circuit', () => keccak(scope), 'coinbase_attestation'],
    ['the reduced value for OIDC', () => reduceOprfName(scope), 'oidc_domain_attestation'],
    ['another scope', () => reduceOprfName('zkproofport-community:topic:bob'), 'coinbase_attestation'],
    ['non-hex', () => '0xzz', 'coinbase_attestation'],
    ['over-long', () => '0x' + '1'.repeat(65), 'coinbase_attestation'],
    ['a number', () => 5, 'coinbase_attestation'],
    ['undefined', () => undefined, 'coinbase_attestation'],
    ['an unknown circuit', () => reduceOprfName(scope), 'giwa_attestation'],
  ])('%s does not match', (_label, value, circuit) => {
    expect(scopeFieldMatches(value(), scope, circuit)).toBe(false);
  });
});

describe('the topic gate\'s scope check on real public inputs', () => {
  it.each(WALLET.flatMap((circuit) => HIGH_SCOPES.map((scope) => [circuit, scope] as const)))('%s over %j matches', (circuit, scope) => {
    expect(proofScopeMatches(walletInputs(circuit, { scope }), circuit, scope)).toBe(true);
  });
  it.each(WALLET)('%s with the raw keccak256 in the scope field is refused', (circuit) => {
    const scope = HIGH_SCOPES[0];
    const inputs = walletInputs(circuit, { scope });
    inputs[circuit === 'coinbase_attestation' ? COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT.SCOPE : 152] = keccak(scope);
    expect(() => proofScopeMatches(inputs, circuit, scope)).toThrow();
  });
  it.each(WALLET)('%s over another account\'s scope does not match', (circuit) => {
    expect(proofScopeMatches(walletInputs(circuit, { scope: HIGH_SCOPES[0] }), circuit, HIGH_SCOPES[1])).toBe(false);
  });
});

describe('the OPRF domain of a proof submitted without its request', () => {
  it.each(WALLET.flatMap((circuit) => (['staging', 'development', 'local'] as const).map((env) => [circuit, env] as const)))(
    '%s in %s: OpenStoa\'s own domain verifies', async (circuit, env) => {
      vi.stubEnv('APP_ENV', env);
      const result = await verifyTrustedTopicProof(circuit, STANDARD, walletInputs(circuit, { oprfDomain: OPRF_SETTINGS[env].domain }), undefined, undefined, undefined, country(circuit));
      expect(result).toEqual({ valid: true });
      expect(state.calls).toHaveLength(1);
    });

  it.each(WALLET.flatMap((circuit) => [
    [circuit, 'another service', { oprfDomain: 'other.example' }],
    [circuit, 'the production domain on staging', { oprfDomain: 'openstoa.xyz' }],
    [circuit, 'scope and domain swapped', { oprfDomain: 'zkproofport-community', scope: STAGING_OPRF_DOMAIN }],
  ] as const))('%s made for %s is refused before the contract call', async (circuit, _label, options) => {
    const result = await verifyTrustedTopicProof(circuit, STANDARD, walletInputs(circuit, options), undefined, undefined, undefined, country(circuit));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/OPRF domain/);
    expect(state.calls).toHaveLength(0);
  });

  it.each(WALLET)('%s with a zero domain field is refused', async (circuit) => {
    const inputs = walletInputs(circuit);
    inputs[circuit === 'coinbase_attestation' ? COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT.OPRF_DOMAIN : 151] = proofField(0);
    expect((await verifyTrustedTopicProof(circuit, STANDARD, inputs, undefined, undefined, undefined, country(circuit))).valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });
});

describe('the OPRF key hash', () => {
  it.each(WALLET)('%s under a key other than the pinned testnet key is refused before the contract call', async (circuit) => {
    const result = await verifyTrustedTopicProof(circuit, STANDARD, walletInputs(circuit, { oprfKeyHash: proofField(1) }), undefined, undefined, undefined, country(circuit));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/OPRF key hash/);
    expect(state.calls).toHaveLength(0);
  });
});

describe('a relay result is checked against { scope, requestId, oprfDomain }', () => {
  const SCOPE = 'zkproofport-community:topic:alice';
  const request = { scope: SCOPE, requestId: REQUEST_ID, oprfDomain: STAGING_OPRF_DOMAIN };

  it.each(WALLET)('%s answering the request verifies', async (circuit) => {
    const inputs = walletInputs(circuit, { scope: SCOPE, requestId: REQUEST_ID });
    expect(await verifyTrustedTopicProof(circuit, STANDARD, inputs, undefined, undefined, undefined, country(circuit), request)).toEqual({ valid: true });
  });

  it.each(WALLET.flatMap((circuit) => [
    [circuit, 'made for another requestId', { scope: SCOPE, requestId: '0b9a8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d' }, request],
    [circuit, 'made for another scope', { scope: 'zkproofport-community:topic:bob', requestId: REQUEST_ID }, request],
    [circuit, 'checked against a request naming another OPRF domain', { scope: SCOPE, requestId: REQUEST_ID }, { ...request, oprfDomain: 'other.example' }],
    [circuit, 'checked against a request with no OPRF domain', { scope: SCOPE, requestId: REQUEST_ID }, { scope: SCOPE, requestId: REQUEST_ID }],
    [circuit, 'made for, and checked against, a domain that is not OpenStoa\'s', { scope: SCOPE, requestId: REQUEST_ID, oprfDomain: 'other.example' }, { ...request, oprfDomain: 'other.example' }],
  ] as const))('%s %s is refused before the contract call', async (circuit, _label, options, against) => {
    const result = await verifyTrustedTopicProof(circuit, STANDARD, walletInputs(circuit, options), undefined, undefined, undefined, country(circuit), against);
    expect(result.valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });

  it('an action-bound proof (action_hash set) that also carries a signal_hash is refused', async () => {
    const inputs = walletInputs('coinbase_attestation', { scope: SCOPE, requestId: REQUEST_ID });
    inputs[COINBASE_ATTESTATION_PUBLIC_INPUT_LAYOUT.ACTION_HASH_START] = proofField(1);
    expect((await verifyTrustedTopicProof('coinbase_attestation', STANDARD, inputs, undefined, undefined, undefined, undefined, request)).valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });
});

describe('oprfDomainError', () => {
  it('names a wrong count', () => {
    expect(oprfDomainError(walletInputs('coinbase_attestation').slice(0, 132), 'coinbase_attestation', STAGING_OPRF_DOMAIN)).toMatch(/132|count/);
  });
  it('refuses a domain field at or above p', () => {
    const inputs = walletInputs('coinbase_country_attestation');
    inputs[151] = proofField(P);
    expect(oprfDomainError(inputs, 'coinbase_country_attestation', STAGING_OPRF_DOMAIN)).not.toBeNull();
  });
  it('accepts the domain the proof carries', () => {
    expect(oprfDomainError(walletInputs('coinbase_country_attestation'), 'coinbase_country_attestation', STAGING_OPRF_DOMAIN)).toBeNull();
    expect(COINBASE_COUNTRY_PUBLIC_INPUT_COUNT).toBe(155);
  });
});
