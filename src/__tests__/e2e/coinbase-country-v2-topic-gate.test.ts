/**
 * The Coinbase Country topic gate on core 0.4.0-beta.3 (Country v2, 215
 * public inputs), over HTTP against a real deployment. No prover needed:
 * every case is a refusal that happens before any contract call, the 402
 * that names what to prove, or a relay request that is only created.
 *
 * Matrix:
 *  - no proof -> 402 naming coinbase_country_attestation, with the topic's list
 *    upper-cased and de-duplicated (['kr', 'US', 'KR'] -> ['KR', 'US'])
 *  - Country v1 shape (150 inputs) -> 400 with the proof requirement
 *  - v2 shape over the caller's scope but another list / an exclusion proof /
 *    length 11 -> 400
 *  - an android claim on a standard-length proof -> 400
 *  - an invalid topic list (empty, 11 codes, 3 letters) -> 400
 *  - proof-request for Country: missing / empty / lower-case / 11-code list or
 *    missing isIncluded -> 400 naming the problem; a valid list -> 200
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import { COINBASE_COUNTRY_PUBLIC_INPUT_COUNT, COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT } from '@zkproofport-app/core';
import { authPost, publicGet } from './helpers';

const field = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const proofOfLog = (log: number) => '0x' + 'ab'.repeat(32 * (82 + 12 * log));
const TEN = ['KR', 'US', 'JP', 'DE', 'FR', 'GB', 'CA', 'AU', 'SG', 'NZ'];
let categoryId: string;
let scope: string;

beforeAll(async () => {
  const res = await publicGet('/api/categories');
  expect(res.status).toBe(200);
  categoryId = (await res.json()).categories[0].id;
  const challenge = await authPost('/api/auth/challenge');
  expect(challenge.status).toBe(200);
  scope = (await challenge.json()).scope;
  expect(scope).toMatch(/^zkproofport-community:topic:/);
});

/** A v2-shaped Country vector over the caller's topic scope (signer root and attested_at left zero). */
function countryInputs(countries: string[], options: { length?: number; isIncluded?: number } = {}): string[] {
  const L = COINBASE_COUNTRY_PUBLIC_INPUT_LAYOUT;
  const inputs = Array(COINBASE_COUNTRY_PUBLIC_INPUT_COUNT).fill(field(0));
  countries.forEach((code, slot) => {
    inputs[L.COUNTRY_LIST_START + 2 * slot] = field(code.charCodeAt(0));
    inputs[L.COUNTRY_LIST_START + 2 * slot + 1] = field(code.charCodeAt(1));
  });
  inputs[L.COUNTRY_LIST_LENGTH] = field(options.length ?? countries.length);
  inputs[L.IS_INCLUDED] = field(options.isIncluded ?? 1);
  Buffer.from(ethers.keccak256(ethers.toUtf8Bytes(scope)).slice(2), 'hex')
    .forEach((byte, i) => inputs[L.SCOPE_START + i] = field(byte));
  return inputs;
}

const createCountry = (allowedCountries: unknown, extra: Record<string, unknown> = {}) => authPost('/api/topics', {
  title: `E2E Country v2 gate ${Date.now()}`,
  description: 'refusal cases',
  categoryId,
  proofType: 'country',
  allowedCountries,
  ...extra,
});

describe.sequential('Country topic gate (Coinbase Country v2)', () => {
  it('without a proof answers 402 naming coinbase_country_attestation and the normalised list', async () => {
    const res = await createCountry(['kr', 'US', 'KR']);
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.proofRequirement.circuit).toBe('coinbase_country_attestation');
    expect(json.proofRequirement.allowedCountries).toEqual(['KR', 'US']);
    expect(json.proofScope).toBe(scope);
  });

  it('a v1-shaped proof (150 public inputs) is refused with the requirement', async () => {
    const res = await createCountry(['KR'], { proof: proofOfLog(19), publicInputs: Array(150).fill(field(0)) });
    expect(res.status).toBe(400);
    expect((await res.json()).proofRequirement.circuit).toBe('coinbase_country_attestation');
  });

  it.each([
    // Built inside the test: the scope arrives in beforeAll, after collection.
    ['another list', () => countryInputs(['US'])],
    ['an exclusion proof', () => countryInputs(['KR'], { isIncluded: 0 })],
    ['length 11', () => countryInputs(TEN, { length: 11 })],
  ])('a v2-shaped proof with %s is refused', async (_label, build) => {
    const res = await createCountry(['KR'], { proof: proofOfLog(20), publicInputs: build() });
    expect(res.status).toBe(400);
  });

  it('an android claim on a standard-length proof is refused', async () => {
    const res = await createCountry(['KR'], { proof: proofOfLog(20), publicInputs: countryInputs(['KR']), signerVariant: 'android' });
    expect(res.status).toBe(400);
  });

  it.each([[[]], [[...TEN, 'BR']], [['KOR']]])('topic list %j is refused', async (allowedCountries) => {
    const res = await createCountry(allowedCountries);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid country predicate');
  });
});

describe('Country relay proof requests', () => {
  const request = (extra: Record<string, unknown>) =>
    authPost('/api/auth/proof-request', { mode: 'proof', circuitType: 'coinbase_country_attestation', ...extra });

  it.each([
    ['no list', { isIncluded: true }, /^countryList: /],
    ['an empty list', { countryList: [], isIncluded: true }, /^countryList: /],
    ['a lower-case code', { countryList: ['kr'], isIncluded: true }, /^countryList: /],
    ['11 codes', { countryList: [...TEN, 'BR'], isIncluded: true }, /^countryList: /],
    ['no isIncluded', { countryList: ['KR'] }, /^isIncluded is required/],
  ])('%s is a 400 naming the problem', async (_label, body, message) => {
    const res = await request(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(message);
  });

  it('a valid list creates a request bound to the caller\'s topic scope', async () => {
    const res = await request({ countryList: ['KR', 'US'], isIncluded: true });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.circuitType).toBe('coinbase_country_attestation');
    expect(json.scope).toBe(scope);
    expect(json.deepLink).toMatch(/^zkproofport:\/\/proof-request\?/);
  });
});
