/**
 * OpenStoa on @zkproofport-app/core 0.4.0-beta.3: Coinbase Country v2
 * (`coinbase_country_attestation`, 215 public inputs).
 *
 * Edge matrix (each row maps to a test below):
 *  - count: 215 reaches the v2 verifier; v1's 150 refused before any network
 *    call; 214 / 216 / 0 refused.
 *  - verifier per environment and signer package: standard / android /
 *    android_factory in staging (Base Sepolia) and production (Base mainnet)
 *    call that package's pinned contract, which is the deployment named in the
 *    circuits records; an android claim on a standard-length proof and an
 *    android-length proof with no claim refused without a call.
 *  - attested_at (core): 16 minutes old / 6 minutes ahead refused before the call.
 *  - the list: a Country proof with no requested list is refused (never
 *    accepted for whatever list it carries); a list that differs, a subset, a
 *    superset, an exclusion proof, length 0 / 11, a lower-case code and
 *    non-zero bytes past the length are refused; the same set in another
 *    order and 10 codes are accepted.
 *  - topic gate (requireTopicProof): the topic's list in any case/order with
 *    duplicates is held to its upper-case set; mismatch, exclusion, v1 proof,
 *    another account's scope, length 0 / 11 -> 400 with no contract call and no
 *    cache write; a matching proof saves the predicate; android/android_factory
 *    proofs join through their verifiers.
 *  - relay results: a Country result is verified against the list recorded
 *    for the POLLED request id; no record, a record for another circuit, a
 *    record with no or a corrupt list, and a proof over another list are
 *    refused; the record of another request id is not consulted.
 *  - unaffected: KYC v2 (193) and OIDC v2 (214) still verify with no country
 *    list, and a list passed with them changes nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearOidcKeyCache,
  COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT,
  getPinnedVariantVerifier,
  getPinnedVerifier,
} from '@zkproofport-app/core';
import { coinbaseIssuerInputs, countryIssuerInputs, encodedBool, jwksFetch, oidcIssuerInputs, proofField } from './fixtures/trusted-proof';

const state = vi.hoisted(() => ({ calls: [] as string[], result: vi.fn() }));
vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  class FakeProvider {
    constructor(_url: string) {}
    async call(tx: { to: string }) {
      state.calls.push(String(tx.to).toLowerCase());
      return state.result();
    }
  }
  return { ...actual, ethers: { ...actual.ethers, JsonRpcProvider: FakeProvider } };
});
const store = vi.hoisted(() => ({ data: new Map<string, string>() }));
vi.mock('@/lib/redis', () => ({
  redis: {
    get: async (key: string) => store.data.get(key) ?? null,
    set: async (key: string, value: string) => { store.data.set(key, value); return 'OK'; },
  },
}));
const cache = vi.hoisted(() => ({ saved: [] as unknown[][] }));
vi.mock('@/lib/verification-cache', () => ({
  circuitToCacheType: (circuit: string) => circuit,
  getVerificationCache: async () => null,
  saveVerificationCache: async (...args: unknown[]) => { cache.saved.push(args); },
}));

import { verifyTrustedTopicProof, verifyProofFromRelay, PUBLIC_INPUT_COUNTS } from '@/lib/proof';
import { requireTopicProof, topicProofScope } from '@/lib/topic-proof';

const proofOfLog = (log: number) => '0x' + 'ab'.repeat(32 * (82 + 12 * log));
const STANDARD = proofOfLog(20);
const ANDROID = proofOfLog(21);
const COUNTRY = 'coinbase_country_attestation';
const KR = { countryList: ['KR'], isIncluded: true };
const TEN = ['KR', 'US', 'JP', 'DE', 'FR', 'GB', 'CA', 'AU', 'SG', 'NZ'];

beforeEach(() => {
  state.calls.length = 0;
  cache.saved.length = 0;
  store.data.clear();
  state.result.mockReset().mockResolvedValue(encodedBool(true));
  clearOidcKeyCache();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(jwksFetch()));
  vi.stubEnv('APP_ENV', 'staging');
});

describe('Coinbase Country v2 count', () => {
  it('OpenStoa expects core\'s 215', () => {
    expect(PUBLIC_INPUT_COUNTS.coinbase_country_attestation).toBe(215);
  });

  it('a 215-input proof reaches the Base Sepolia v2 verifier', async () => {
    expect(await verifyTrustedTopicProof(COUNTRY, STANDARD, countryIssuerInputs(), undefined, undefined, undefined, KR)).toEqual({ valid: true });
    expect(state.calls).toEqual(['0xc5363d7587bd580148373d0d8b7909be423242cb']);
  });

  it.each([0, 150, 214, 216])('%i inputs are refused before any network call', async (n) => {
    const result = await verifyTrustedTopicProof(COUNTRY, STANDARD, Array(n).fill(proofField(0)), undefined, undefined, undefined, KR);
    expect(result).toEqual({ valid: false, error: 'Expected 215 32-byte public inputs for coinbase_country_attestation' });
    expect(state.calls).toHaveLength(0);
  });

  it.each([
    ['16 minutes old', -16 * 60, /behind this verifier's clock/],
    ['6 minutes ahead', 6 * 60, /ahead of this verifier's clock/],
  ])('attested_at %s is refused before the contract call', async (_label, offset, message) => {
    const inputs = countryIssuerInputs();
    inputs[COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT.ATTESTED_AT] = proofField(Math.floor(Date.now() / 1000) + offset);
    const result = await verifyTrustedTopicProof(COUNTRY, STANDARD, inputs, undefined, undefined, undefined, KR);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(message);
    expect(state.calls).toHaveLength(0);
  });
});

describe('each Country package verifies on its own pinned contract', () => {
  const rows = [
    ['staging', 84532, 'standard', '0xc5363d7587bd580148373d0d8b7909be423242cb'],
    ['staging', 84532, 'android', '0x98013abb7ac83b6c985dcfbd5748ad2ae04c8c12'],
    ['staging', 84532, 'android_factory', '0xd7bfd6d7bcc6c627da12cfcdf39fca6f64fdc0b9'],
    ['production', 8453, 'standard', '0x509dee10cc1578361b450fed7475ea3bd69c6e8d'],
    ['production', 8453, 'android', '0xb57182062141f59ddbb98da73764ec1676689832'],
    ['production', 8453, 'android_factory', '0x1f2975abd0711cf6b98084829e04712ee105d8f7'],
  ] as const;

  it.each(rows)('%s (%i) / %s -> %s', async (env, chainId, variant, address) => {
    vi.stubEnv('APP_ENV', env);
    const proof = variant === 'standard' ? STANDARD : ANDROID;
    const claim = variant === 'standard' ? undefined : variant;
    expect(await verifyTrustedTopicProof(COUNTRY, proof, countryIssuerInputs(), undefined, undefined, claim, KR)).toEqual({ valid: true });
    expect(state.calls).toEqual([address]);
    const pinned = variant === 'standard' ? getPinnedVerifier(COUNTRY, chainId) : getPinnedVariantVerifier(COUNTRY, variant, chainId);
    expect(pinned.address).toBe(address);
  });

  it('an android claim on a standard-length proof is refused without a call', async () => {
    const result = await verifyTrustedTopicProof(COUNTRY, STANDARD, countryIssuerInputs(), undefined, undefined, 'android', KR);
    expect(result.valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });

  it('an Android-length proof with no claim is refused, not sent to the standard verifier', async () => {
    const result = await verifyTrustedTopicProof(COUNTRY, ANDROID, countryIssuerInputs(), undefined, undefined, undefined, KR);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/does not say which signer made it/);
    expect(state.calls).toHaveLength(0);
  });
});

describe('a Country proof is held to the list it was asked for', () => {
  it('no requested list: refused, never accepted for whatever list it carries', async () => {
    const result = await verifyTrustedTopicProof(COUNTRY, STANDARD, countryIssuerInputs());
    expect(result).toEqual({ valid: false, error: 'A Coinbase Country proof needs the country list it was asked for; none is known here' });
    expect(state.calls).toHaveLength(0);
  });

  it.each([
    ['another list', { countries: ['US'] }, KR],
    ['a subset', { countries: ['KR'] }, { countryList: ['KR', 'US'], isIncluded: true }],
    ['a superset', { countries: ['KR', 'US'] }, KR],
    ['an exclusion proof', { countries: ['KR'], isIncluded: 0 }, KR],
    ['length 0', { countries: [], length: 0 }, KR],
    ['length 11', { countries: TEN, length: 11 }, KR],
    ['a lower-case code', { countries: ['kr'] }, KR],
    ['bytes past the length', { countries: ['KR', 'US'], length: 1 }, KR],
  ])('%s is refused before the contract call', async (_label, options, condition) => {
    const result = await verifyTrustedTopicProof(COUNTRY, STANDARD, countryIssuerInputs(options), undefined, undefined, undefined, condition);
    expect(result.valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });

  it.each([
    ['the same set in another order', { countries: ['US', 'KR'] }, { countryList: ['KR', 'US'], isIncluded: true }],
    ['ten codes', { countries: TEN }, { countryList: [...TEN].reverse(), isIncluded: true }],
  ])('%s verifies', async (_label, options, condition) => {
    expect(await verifyTrustedTopicProof(COUNTRY, STANDARD, countryIssuerInputs(options), undefined, undefined, undefined, condition)).toEqual({ valid: true });
    expect(state.calls).toHaveLength(1);
  });

  it('the contract answering false is invalid, not thrown', async () => {
    state.result.mockResolvedValue(encodedBool(false));
    expect((await verifyTrustedTopicProof(COUNTRY, STANDARD, countryIssuerInputs(), undefined, undefined, undefined, KR)).valid).toBe(false);
  });
});

describe('the topic gate', () => {
  const userId = 'user-1';
  const scope = topicProofScope(userId);
  const gate = (allowedCountries: unknown, body: Record<string, unknown>) =>
    requireTopicProof(userId, { proofType: 'country', allowedCountries: allowedCountries as string[] }, body);

  it('joins with an inclusion proof over the topic\'s list, normalised (case, order, duplicates)', async () => {
    const response = await gate(['us', 'KR', 'kr'], { proof: STANDARD, publicInputs: countryIssuerInputs({ countries: ['KR', 'US'], scope }) });
    expect(response).toBeNull();
    expect(state.calls).toEqual([getPinnedVerifier(COUNTRY, 84532).address]);
    expect(cache.saved).toHaveLength(1);
    expect(cache.saved[0][1]).toBe(COUNTRY);
  });

  it('accepts the concatenated-hex form of public inputs', async () => {
    const hex = '0x' + countryIssuerInputs({ countries: ['KR'], scope }).map(v => v.slice(2)).join('');
    expect(await gate(['KR'], { proof: STANDARD, publicInputs: hex })).toBeNull();
  });

  it.each(['android', 'android_factory'] as const)('an %s proof joins through its pinned verifier', async (variant) => {
    const response = await gate(['KR'], { proof: ANDROID, publicInputs: countryIssuerInputs({ countries: ['KR'], scope }), signerVariant: variant });
    expect(response).toBeNull();
    expect(state.calls).toEqual([getPinnedVariantVerifier(COUNTRY, variant, 84532).address]);
  });

  it.each([
    ['another list', ['KR'], countryIssuerInputs({ countries: ['US'], scope })],
    ['an exclusion proof', ['KR'], countryIssuerInputs({ countries: ['KR'], isIncluded: 0, scope })],
    ['a v1 (150-input) proof', ['KR'], countryIssuerInputs({ countries: ['KR'], scope }).slice(0, 150)],
    ['another account\'s scope', ['KR'], countryIssuerInputs({ countries: ['KR'], scope: topicProofScope('someone-else') })],
    ['length 0', ['KR'], countryIssuerInputs({ countries: [], length: 0, scope })],
    ['length 11', TEN, countryIssuerInputs({ countries: TEN, length: 11, scope })],
  ])('%s is a 400 with no contract call and no cache write', async (_label, allowed, publicInputs) => {
    const response = await gate(allowed, { proof: STANDARD, publicInputs });
    expect(response?.status).toBe(400);
    expect(state.calls).toHaveLength(0);
    expect(cache.saved).toHaveLength(0);
  });

  it.each([[[]], [[...TEN, 'BR']], [['KOR']], [null]])('a topic list %j is refused as an invalid predicate', async (allowed) => {
    const response = await gate(allowed, { proof: STANDARD, publicInputs: countryIssuerInputs({ countries: ['KR'], scope }) });
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: 'Invalid country predicate' });
    expect(state.calls).toHaveLength(0);
  });

  it('a topic of ten countries accepts a ten-country proof', async () => {
    expect(await gate(TEN, { proof: STANDARD, publicInputs: countryIssuerInputs({ countries: TEN, scope }) })).toBeNull();
  });
});

describe('a Country relay result is verified against the list OpenStoa asked for', () => {
  const record = (requestId: string, value: unknown) =>
    store.data.set(`community:relay-request:${requestId}`, typeof value === 'string' ? value : JSON.stringify(value));
  const result = (extra: Record<string, unknown> = {}) => ({
    requestId: 'carried', status: 'completed', circuit: COUNTRY,
    proof: STANDARD, publicInputs: countryIssuerInputs({ countries: ['KR'] }), ...extra,
  }) as never;

  it('verifies against the record of the polled id', async () => {
    record('polled', { scope: 's', circuit: COUNTRY, countryCondition: KR });
    expect(await verifyProofFromRelay(result(), 'polled')).toEqual({ valid: true });
    expect(state.calls).toHaveLength(1);
  });

  it('an android result verifies on the android contract', async () => {
    record('polled', { scope: 's', circuit: COUNTRY, countryCondition: KR });
    expect(await verifyProofFromRelay(result({ proof: ANDROID, signerVariant: 'android' }), 'polled')).toEqual({ valid: true });
    expect(state.calls).toEqual([getPinnedVariantVerifier(COUNTRY, 'android', 84532).address]);
  });

  it.each([
    ['no record', undefined],
    ['a record for another circuit', { scope: 's', circuit: 'oidc_domain_attestation' }],
    ['a record with no list', { scope: 's', circuit: COUNTRY }],
    ['a record with an invalid list', { scope: 's', circuit: COUNTRY, countryCondition: { countryList: [], isIncluded: true } }],
    ['a record with no direction', { scope: 's', circuit: COUNTRY, countryCondition: { countryList: ['KR'] } }],
    ['a corrupt record', '{not json'],
    ['a record over another list', { scope: 's', circuit: COUNTRY, countryCondition: { countryList: ['US'], isIncluded: true } }],
  ])('%s: refused without a contract call', async (_label, value) => {
    if (value !== undefined) record('polled', value);
    const verdict = await verifyProofFromRelay(result(), 'polled');
    expect(verdict.valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });

  it('the record under the id the result carries is not consulted', async () => {
    record('carried', { scope: 's', circuit: COUNTRY, countryCondition: KR });
    expect((await verifyProofFromRelay(result(), 'polled')).valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });
});

describe('KYC v2 and OIDC v2 are unaffected', () => {
  it('KYC v2 verifies with no country list, and a list passed with it changes nothing', async () => {
    expect(await verifyTrustedTopicProof('coinbase_attestation', STANDARD, coinbaseIssuerInputs())).toEqual({ valid: true });
    expect(await verifyTrustedTopicProof('coinbase_attestation', STANDARD, coinbaseIssuerInputs(), undefined, undefined, undefined, { countryList: ['US'], isIncluded: false })).toEqual({ valid: true });
    expect(state.calls).toEqual([getPinnedVerifier('coinbase_attestation', 84532).address, getPinnedVerifier('coinbase_attestation', 84532).address]);
  });

  it('OIDC v2 (device flow) verifies with no country list', async () => {
    expect(await verifyTrustedTopicProof('oidc_domain_attestation', STANDARD, oidcIssuerInputs())).toEqual({ valid: true });
  });

  it('a KYC relay result reads no record', async () => {
    const verdict = await verifyProofFromRelay({
      requestId: 'r', status: 'completed', circuit: 'coinbase_attestation', proof: STANDARD, publicInputs: coinbaseIssuerInputs(),
    } as never, 'r');
    expect(verdict).toEqual({ valid: true });
  });
});
