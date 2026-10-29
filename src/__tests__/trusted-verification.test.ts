/**
 * verifyTrustedTopicProof / verifyProofFromRelay on @zkproofport-app/core 0.3.0
 * (OIDC v2: 214 public inputs, audience / nonce / now policy).
 *
 * Edge matrix (each row maps to a test below):
 *  - environment: production / staging / development / local route each circuit to
 *    its chain and core's pinned verifier; unset, unknown, prototype keys refused.
 *  - circuit: the three accepted ids; unknown, empty, prototype keys, core circuits
 *    OpenStoa does not accept (giwa_attestation, dojang_playground) and the removed
 *    Korea Mobile ID ids (mdl_kr_*) refused naming the known ids.
 *  - public inputs: exact count per circuit; count-1, count+1, empty; non-hex, short
 *    and non-string fields refused before any network call.
 *  - proof bytes: empty, bare 0x and non-hex refused.
 *  - issuer anchors (core): wrong Coinbase signer root, an RSA key the provider does
 *    not publish, JWKS offline / HTTP 500, a Microsoft key scoped to one tenant --
 *    all refused before the contract call; published Google and Microsoft keys pass.
 *  - relay claim: a differing verifierAddress or chainId is refused; a matching one
 *    (any case) and an absent one are accepted; a result with no circuit is refused.
 *  - contract: false, a non-true value and an RPC failure all answer invalid, never throw.
 *  - integrity: OpenStoa's counts equal core's layouts; every (environment, circuit)
 *    chain has a pinned verifier in core.
 *  - OIDC request binding (core 0.3.0): a mode-0 (device flow) proof verifies with no
 *    request; a mode-1 (app) proof without its request, or with any nonce_mode other
 *    than 0, is refused before any network call; with the right request it verifies;
 *    another requestId, another scope (also Korean / emoji scopes), a non-UUID or
 *    upper-case requestId are refused; a v1 (148-input) proof is refused; a `now`
 *    16 minutes old is refused.
 *  - relay results: an OIDC result verifies only against the request OpenStoa
 *    recorded for the POLLED id (not the id the result carries); no record, a
 *    corrupt record, a record for another circuit, and Redis down are all refused /
 *    rejected, never verified without the request; non-OIDC results read no record.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers as realEthers } from 'ethers';
import {
  clearOidcKeyCache,
  getPinnedVerifier,
  OIDC_PUBLIC_INPUT_COUNT,
  SIGNER_ROOT_LAYOUTS,
  RPC_ENDPOINTS,
} from '@zkproofport-app/core';
import { coinbaseIssuerInputs, oidcIssuerInputs, testJwk, jwksFetch, encodedBool, proofField, OIDC_AUDIENCES } from './fixtures/trusted-proof';

const state = vi.hoisted(() => ({
  providers: [] as string[],
  calls: [] as Array<{ to: string; data: string }>,
  result: vi.fn(),
}));
vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  class FakeProvider {
    constructor(url: string) { state.providers.push(url); }
    async call(tx: { to: string; data: string }) {
      state.calls.push({ to: String(tx.to).toLowerCase(), data: tx.data });
      return state.result();
    }
  }
  return { ...actual, ethers: { ...actual.ethers, JsonRpcProvider: FakeProvider } };
});
const store = vi.hoisted(() => ({ data: new Map<string, string>(), down: false }));
vi.mock('@/lib/redis', () => ({
  redis: {
    get: async (key: string) => { if (store.down) throw new Error('redis down'); return store.data.get(key) ?? null; },
    set: async (key: string, value: string) => { if (store.down) throw new Error('redis down'); store.data.set(key, value); return 'OK'; },
  },
}));

import {
  verifyTrustedTopicProof,
  verifyProofFromRelay,
  VERIFICATION_CHAINS,
  PUBLIC_INPUT_COUNTS,
  type VerifiableCircuit,
} from '@/lib/proof';

const CIRCUITS = Object.keys(PUBLIC_INPUT_COUNTS) as VerifiableCircuit[];
const ENVIRONMENTS = ['production', 'staging', 'development', 'local'];

function validInputs(circuit: VerifiableCircuit): string[] {
  if (circuit === 'coinbase_attestation') return coinbaseIssuerInputs(193);
  if (circuit === 'coinbase_country_attestation') return coinbaseIssuerInputs(150);
  if (circuit === 'oidc_domain_attestation') return oidcIssuerInputs();
  throw new Error(`No fixture for circuit '${circuit}'. Known: ${CIRCUITS.join(', ')}.`);
}

beforeEach(() => {
  store.data.clear();
  store.down = false;
  state.providers.length = 0;
  state.calls.length = 0;
  state.result.mockReset().mockResolvedValue(encodedBool(true));
  clearOidcKeyCache();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(jwksFetch()));
  vi.stubEnv('APP_ENV', 'staging');
});

describe('environment and circuit select core\'s pinned verifier', () => {
  const rows = ENVIRONMENTS.flatMap((env) => CIRCUITS.map((circuit) => [env, circuit] as const));
  it.each(rows)('%s / %s calls the pinned verifier on its chain', async (env, circuit) => {
    vi.stubEnv('APP_ENV', env);
    const chainId = VERIFICATION_CHAINS[env][circuit];
    const result = await verifyTrustedTopicProof(circuit, '0xab', validInputs(circuit));
    expect(result).toEqual({ valid: true });
    expect(state.providers).toEqual([RPC_ENDPOINTS[chainId]]);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].to).toBe(getPinnedVerifier(circuit, chainId).address);
  });

  it('production Coinbase KYC is the Base mainnet v2 verifier, staging the Base Sepolia v2 one', async () => {
    vi.stubEnv('APP_ENV', 'production');
    await verifyTrustedTopicProof('coinbase_attestation', '0xab', validInputs('coinbase_attestation'));
    vi.stubEnv('APP_ENV', 'staging');
    await verifyTrustedTopicProof('coinbase_attestation', '0xab', validInputs('coinbase_attestation'));
    expect(state.providers).toEqual(['https://mainnet.base.org', 'https://sepolia.base.org']);
    expect(state.calls.map((c) => c.to)).toEqual([
      '0x6fc22d3576fb70457d1529b3f70f711a3cba7a7f',
      '0x1885aa2283db21ad0fc63a2df98efe92f31908e6',
    ]);
  });

  it.each([undefined, '', 'unknown', 'Production', '__proto__', 'constructor', 'toString'])(
    'environment %j is refused without a call', async (env) => {
      vi.stubEnv('APP_ENV', env as string);
      const result = await verifyTrustedTopicProof('coinbase_attestation', '0xab', validInputs('coinbase_attestation'));
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Unknown proof environment/);
      expect(state.calls).toHaveLength(0);
    });

  it.each(['missing', '', '__proto__', 'constructor', 'hasOwnProperty', 'giwa_attestation', 'dojang_playground', 'COINBASE_ATTESTATION',
    'mdl_kr_ownership', 'mdl_kr_age', 'mdl_kr_region'])(
    'circuit %j is refused without a call, naming the known circuits', async (circuit) => {
      const result = await verifyTrustedTopicProof(circuit, '0xab', validInputs('coinbase_attestation'));
      expect(result.valid).toBe(false);
      expect(result.error).toBe(`Unsupported verifier circuit '${circuit}'. Known: coinbase_attestation, coinbase_country_attestation, oidc_domain_attestation.`);
      expect(state.calls).toHaveLength(0);
    });
});

describe('public inputs and proof bytes are checked before any network call', () => {
  const lengths = CIRCUITS.flatMap((circuit) => [
    [circuit, PUBLIC_INPUT_COUNTS[circuit] - 1],
    [circuit, PUBLIC_INPUT_COUNTS[circuit] + 1],
    [circuit, 0],
  ] as const);
  it.each(lengths)('%s with %i inputs is refused', async (circuit, length) => {
    const result = await verifyTrustedTopicProof(circuit, '0xab', Array(length).fill(proofField(0)));
    expect(result.valid).toBe(false);
    expect(state.calls).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([['not hex', 'zz'], ['short field', '0x01'], ['unprefixed', '00'.repeat(32)], ['null', null], ['number', 1]])(
    'a %s field is refused', async (_label, bad) => {
      const inputs = validInputs('coinbase_attestation') as unknown[];
      inputs[5] = bad;
      expect((await verifyTrustedTopicProof('coinbase_attestation', '0xab', inputs as string[])).valid).toBe(false);
      expect(state.calls).toHaveLength(0);
    });

  it.each(['', '0x', 'ab', '0xzz', ' 0xab'])('proof %j is refused', async (proof) => {
    expect((await verifyTrustedTopicProof('coinbase_attestation', proof, validInputs('coinbase_attestation'))).valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });
});

describe('issuer anchors are checked by core before the contract', () => {
  it('a Coinbase proof over a signer root of the prover\'s choosing is refused', async () => {
    const result = await verifyTrustedTopicProof('coinbase_attestation', '0xab', Array(193).fill(proofField(0)));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/signer-list root/);
    expect(state.calls).toHaveLength(0);
  });

  it('a Country proof with a wrong signer root is refused', async () => {
    const inputs = coinbaseIssuerInputs(150);
    inputs[40] = proofField(7);
    expect((await verifyTrustedTopicProof('coinbase_country_attestation', '0xab', inputs)).valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });

  it('an RSA key the provider does not publish is refused', async () => {
    const inputs = oidcIssuerInputs();
    inputs[3] = proofField(5);
    const result = await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', inputs);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/does not publish/);
    expect(state.calls).toHaveLength(0);
  });

  it.each([
    ['offline', vi.fn().mockRejectedValue(new Error('offline'))],
    ['HTTP 500', vi.fn(async () => new Response('nope', { status: 500 }))],
    ['not JSON', vi.fn(async () => new Response('<html>', { status: 200 }))],
  ])('JWKS %s fails closed', async (_label, fetcher) => {
    vi.stubGlobal('fetch', fetcher);
    expect((await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', oidcIssuerInputs())).valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });

  it.each([
    [0, 'https://www.googleapis.com/oauth2/v3/certs'],
    [1, 'https://login.microsoftonline.com/organizations/discovery/v2.0/keys'],
  ])('provider %i key is fetched from its fixed JWKS URL without following redirects', async (provider, url) => {
    const inputs = oidcIssuerInputs(provider === 1 ? { provider, aud: OIDC_AUDIENCES.microsoft } : { provider });
    expect(await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', inputs)).toEqual({ valid: true });
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error' }));
    expect(state.calls).toHaveLength(1);
  });

  it('a Microsoft key scoped to one tenant is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(jwksFetch([{ ...testJwk, issuer: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0' }])));
    const inputs = oidcIssuerInputs({ provider: 1, aud: OIDC_AUDIENCES.microsoft });
    expect((await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', inputs)).valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });

  it('an unknown provider number is refused, not thrown', async () => {
    const inputs = oidcIssuerInputs();
    inputs[147] = proofField(2);
    expect((await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', inputs)).valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });
});

describe('the relay\'s verifier claim is compared, never used', () => {
  const relayResult = (extra: Record<string, unknown>) => ({
    requestId: 'r', status: 'completed', circuit: 'coinbase_attestation', proof: '0xab',
    publicInputs: validInputs('coinbase_attestation'), ...extra,
  }) as never;

  it('a differing verifierAddress is refused without a call', async () => {
    const result = await verifyProofFromRelay(relayResult({ verifierAddress: '0x000000000000000000000000000000000000dEaD', chainId: 84532 }), 'r');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Refusing rather than trusting the response/);
    expect(state.calls).toHaveLength(0);
  });

  it('a differing chainId is refused without a call', async () => {
    const result = await verifyProofFromRelay(relayResult({ verifierAddress: '0x1885aA2283DB21ad0fc63A2Df98efe92F31908E6', chainId: 8453 }), 'r');
    expect(result.valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });

  it('the pinned address in checksum case is accepted', async () => {
    expect(await verifyProofFromRelay(relayResult({ verifierAddress: '0x1885aA2283DB21ad0fc63A2Df98efe92F31908E6', chainId: 84532 }), 'r')).toEqual({ valid: true });
    expect(state.calls[0].to).toBe('0x1885aa2283db21ad0fc63a2df98efe92f31908e6');
  });

  it('no claim at all is accepted and verified on the pinned verifier', async () => {
    expect((await verifyProofFromRelay(relayResult({}), 'r')).valid).toBe(true);
    expect(state.calls).toHaveLength(1);
  });

  it.each([['circuit', undefined], ['circuit', ''], ['proof', undefined], ['publicInputs', undefined]])(
    'a result with no %s is refused', async (field, value) => {
      expect((await verifyProofFromRelay(relayResult({ [field]: value }), 'r')).valid).toBe(false);
      expect(state.calls).toHaveLength(0);
    });

  it.each(['mdl_kr_ownership', 'mdl_kr_age', 'mdl_kr_region'])('a %s relay result is refused as unknown', async (circuit) => {
    vi.stubEnv('APP_ENV', 'production');
    const result = await verifyProofFromRelay(relayResult({
      circuit, publicInputs: Array(96).fill(proofField(0)),
      verifierAddress: '0x044116dF792eB424c9648DF2DeEda97aFa617Ac0', chainId: 84532,
    }), 'r');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Unsupported verifier circuit .*Known: coinbase_attestation, coinbase_country_attestation, oidc_domain_attestation\./);
    expect(state.calls).toHaveLength(0);
  });
});

describe('the contract decides, and its failures answer invalid', () => {
  it('false is invalid', async () => {
    state.result.mockResolvedValue(encodedBool(false));
    expect((await verifyTrustedTopicProof('coinbase_attestation', '0xab', validInputs('coinbase_attestation'))).valid).toBe(false);
  });
  it('a non-boolean return is invalid', async () => {
    state.result.mockResolvedValue('0x');
    expect((await verifyTrustedTopicProof('coinbase_attestation', '0xab', validInputs('coinbase_attestation'))).valid).toBe(false);
  });
  it('an RPC failure is invalid, not a throw', async () => {
    state.result.mockRejectedValue(new Error('RPC down'));
    expect((await verifyTrustedTopicProof('coinbase_attestation', '0xab', validInputs('coinbase_attestation'))).valid).toBe(false);
  });
  it('the call carries the proof and the inputs unchanged', async () => {
    const inputs = validInputs('coinbase_attestation');
    await verifyTrustedTopicProof('coinbase_attestation', '0xabcd', inputs);
    const iface = new realEthers.Interface(['function verify(bytes _proof, bytes32[] _publicInputs) view returns (bool)']);
    const [proof, publicInputs] = iface.decodeFunctionData('verify', state.calls[0].data);
    expect(proof).toBe('0xabcd');
    expect(publicInputs).toEqual(inputs);
  });
});

describe('integrity against core', () => {
  it('public-input counts equal core\'s layouts', () => {
    expect(PUBLIC_INPUT_COUNTS.coinbase_attestation).toBe(SIGNER_ROOT_LAYOUTS.coinbase_attestation.publicInputCount);
    expect(PUBLIC_INPUT_COUNTS.coinbase_country_attestation).toBe(SIGNER_ROOT_LAYOUTS.coinbase_country_attestation.publicInputCount);
    expect(PUBLIC_INPUT_COUNTS.oidc_domain_attestation).toBe(OIDC_PUBLIC_INPUT_COUNT);
    expect(CIRCUITS.sort()).toEqual(['coinbase_attestation', 'coinbase_country_attestation', 'oidc_domain_attestation']);
  });
  it('every environment names the same circuits, each with a pinned verifier and an RPC endpoint', () => {
    for (const env of Object.keys(VERIFICATION_CHAINS)) {
      expect(Object.keys(VERIFICATION_CHAINS[env]).sort()).toEqual([...CIRCUITS].sort());
      for (const circuit of CIRCUITS) {
        const chainId = VERIFICATION_CHAINS[env][circuit];
        expect(() => getPinnedVerifier(circuit, chainId)).not.toThrow();
        expect(RPC_ENDPOINTS[chainId]).toBeTruthy();
      }
    }
  });
});

const REQUEST_ID = '6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f';
const OTHER_REQUEST_ID = '0b9a8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d';
const SCOPE = 'zkproofport-community';
const appProof = (request = { scope: SCOPE, requestId: REQUEST_ID }) => oidcIssuerInputs({ nonceMode: 1, request });

describe('OIDC v2: the request an app proof answers is checked by core', () => {
  it('a device-flow (mode 0) proof verifies with no request', async () => {
    expect(await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', oidcIssuerInputs())).toEqual({ valid: true });
    expect(state.calls).toHaveLength(1);
  });

  it('an app (mode 1) proof without its request is refused before any network call', async () => {
    const result = await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', appProof());
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/needs the request it answers/);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.calls).toHaveLength(0);
  });

  it.each([2, 255])('nonce_mode %i without a request is refused before any network call', async (mode) => {
    const inputs = oidcIssuerInputs();
    inputs[180] = proofField(mode);
    expect((await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', inputs)).valid).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an app proof with the request it is bound to verifies', async () => {
    expect(await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', appProof(), undefined,
      { scope: SCOPE, requestId: REQUEST_ID })).toEqual({ valid: true });
    expect(state.calls).toHaveLength(1);
  });

  it.each(['zkproofport-community:topic:사용자', 'scope 🚀 with\ttab'])('a UTF-8 scope %j binds and verifies', async (scope) => {
    const request = { scope, requestId: REQUEST_ID };
    expect(await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', appProof(request), undefined, request)).toEqual({ valid: true });
  });

  it.each([
    ['another requestId', { scope: SCOPE, requestId: OTHER_REQUEST_ID }, /nonce is bound/],
    ['another scope', { scope: 'zkproofport-community:topic:alice', requestId: REQUEST_ID }, /scope/],
    ['an upper-case requestId', { scope: SCOPE, requestId: REQUEST_ID.toUpperCase() }, /requestId|UUID/i],
    ['a non-UUID requestId', { scope: SCOPE, requestId: 'r' }, /requestId|UUID/i],
    ['a blank scope', { scope: '   ', requestId: REQUEST_ID }, /scope/],
  ])('an app proof checked against %s is refused without a contract call', async (_label, request, message) => {
    const result = await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', appProof(), undefined, request);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(message);
    expect(state.calls).toHaveLength(0);
  });

  it('a v1 proof (148 inputs) is refused', async () => {
    const result = await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', oidcIssuerInputs().slice(0, 148));
    expect(result.valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });

  it('a proof whose now is 16 minutes old is refused', async () => {
    const inputs = oidcIssuerInputs({ now: Math.floor(Date.now() / 1000) - 16 * 60 });
    const result = await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', inputs);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/behind/);
  });

  it('the Google web client in mode 0 is refused (it is the app client, always nonce bound)', async () => {
    const inputs = oidcIssuerInputs({ aud: OIDC_AUDIENCES.googleWeb });
    expect((await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', inputs)).valid).toBe(false);
  });
});

describe('an OIDC relay result is verified against the request OpenStoa recorded', () => {
  const oidcResult = (extra: Record<string, unknown> = {}) => ({
    requestId: REQUEST_ID, status: 'completed', circuit: 'oidc_domain_attestation', proof: '0xab',
    publicInputs: appProof(), ...extra,
  }) as never;
  const record = (requestId: string, value: unknown) =>
    store.data.set(`community:relay-request:${requestId}`, typeof value === 'string' ? value : JSON.stringify(value));

  it('the recorded scope and the polled id verify, and the request is returned', async () => {
    record(REQUEST_ID, { scope: SCOPE, circuit: 'oidc_domain_attestation' });
    expect(await verifyProofFromRelay(oidcResult(), REQUEST_ID)).toEqual({
      valid: true, request: { scope: SCOPE, requestId: REQUEST_ID },
    });
  });

  it('no record refuses the proof without verifying it', async () => {
    const result = await verifyProofFromRelay(oidcResult(), REQUEST_ID);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/no record of relay request/);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.calls).toHaveLength(0);
  });

  it.each([['not JSON', '{oops'], ['an array', '[]'], ['no scope', { circuit: 'oidc_domain_attestation' }], ['a numeric scope', { scope: 1, circuit: 'oidc_domain_attestation' }]])(
    'a corrupt record (%s) is treated as none', async (_label, value) => {
      record(REQUEST_ID, value);
      expect((await verifyProofFromRelay(oidcResult(), REQUEST_ID)).valid).toBe(false);
      expect(state.calls).toHaveLength(0);
    });

  it('a record for another circuit refuses the proof', async () => {
    record(REQUEST_ID, { scope: SCOPE, circuit: 'coinbase_attestation' });
    const result = await verifyProofFromRelay(oidcResult(), REQUEST_ID);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/created for coinbase_attestation/);
  });

  it('the polled id is used, not the id the result carries', async () => {
    // The proof is bound to REQUEST_ID; OpenStoa polled OTHER_REQUEST_ID and
    // the relay answered with a result naming REQUEST_ID.
    record(OTHER_REQUEST_ID, { scope: SCOPE, circuit: 'oidc_domain_attestation' });
    record(REQUEST_ID, { scope: SCOPE, circuit: 'oidc_domain_attestation' });
    const result = await verifyProofFromRelay(oidcResult({ requestId: REQUEST_ID }), OTHER_REQUEST_ID);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/nonce is bound/);
    expect(state.calls).toHaveLength(0);
  });

  it('a recorded scope other than the one the proof was made for is refused', async () => {
    record(REQUEST_ID, { scope: 'zkproofport-community:topic:alice', circuit: 'oidc_domain_attestation' });
    expect((await verifyProofFromRelay(oidcResult(), REQUEST_ID)).valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });

  it('Redis down rejects: the proof is never verified without its request', async () => {
    store.down = true;
    await expect(verifyProofFromRelay(oidcResult(), REQUEST_ID)).rejects.toThrow(/redis down/);
    expect(state.calls).toHaveLength(0);
  });

  it('a non-OIDC result reads no record', async () => {
    store.down = true;
    const result = await verifyProofFromRelay({
      requestId: 'r', status: 'completed', circuit: 'coinbase_attestation', proof: '0xab',
      publicInputs: validInputs('coinbase_attestation'),
    } as never, 'r');
    expect(result).toEqual({ valid: true });
  });
});
