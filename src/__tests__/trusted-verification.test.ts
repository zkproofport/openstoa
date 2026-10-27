/**
 * verifyTrustedTopicProof / verifyProofFromRelay on @zkproofport-app/core 0.2.0.
 *
 * Edge matrix (each row maps to a test below):
 *  - environment: production / staging / development / local route each circuit to
 *    its chain and core's pinned verifier; unset, unknown, prototype keys refused.
 *  - circuit: the six accepted ids; unknown, empty, prototype keys and core circuits
 *    OpenStoa does not accept (giwa_attestation, dojang_playground) refused.
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
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers as realEthers } from 'ethers';
import {
  clearOidcKeyCache,
  getPinnedVerifier,
  OIDC_PUBLIC_INPUT_COUNT,
  SIGNER_ROOT_LAYOUTS,
  MDL_KR_PUBLIC_INPUT_LAYOUT,
  RPC_ENDPOINTS,
} from '@zkproofport-app/core';
import { coinbaseIssuerInputs, oidcIssuerInputs, testJwk, jwksFetch, encodedBool, proofField } from './fixtures/trusted-proof';

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
  if (circuit === 'coinbase_attestation') return coinbaseIssuerInputs(128);
  if (circuit === 'coinbase_country_attestation') return coinbaseIssuerInputs(150);
  if (circuit === 'oidc_domain_attestation') return oidcIssuerInputs();
  return Array(PUBLIC_INPUT_COUNTS[circuit]).fill(proofField(0));
}

beforeEach(() => {
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

  it('production Coinbase KYC is Base mainnet, staging is the beta.19 Base Sepolia verifier', async () => {
    vi.stubEnv('APP_ENV', 'production');
    await verifyTrustedTopicProof('coinbase_attestation', '0xab', validInputs('coinbase_attestation'));
    vi.stubEnv('APP_ENV', 'staging');
    await verifyTrustedTopicProof('coinbase_attestation', '0xab', validInputs('coinbase_attestation'));
    expect(state.providers).toEqual(['https://mainnet.base.org', 'https://sepolia.base.org']);
    expect(state.calls.map((c) => c.to)).toEqual([
      '0xf7ded73e7a7fc8fb030c35c5a88d40abe6865382',
      '0x42d165a48256ae184e1de4e7e6372e870e2bc883',
    ]);
  });

  it('Korea Mobile ID verifies on Base Sepolia even in production', async () => {
    vi.stubEnv('APP_ENV', 'production');
    expect((await verifyTrustedTopicProof('mdl_kr_age', '0xab', validInputs('mdl_kr_age'))).valid).toBe(true);
    expect(state.providers).toEqual(['https://sepolia.base.org']);
    expect(state.calls[0].to).toBe('0x45d4850a9b197ceba185b5069fb13ce0be1dc6d6');
  });

  it.each([undefined, '', 'unknown', 'Production', '__proto__', 'constructor', 'toString'])(
    'environment %j is refused without a call', async (env) => {
      vi.stubEnv('APP_ENV', env as string);
      const result = await verifyTrustedTopicProof('coinbase_attestation', '0xab', validInputs('coinbase_attestation'));
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Unknown proof environment/);
      expect(state.calls).toHaveLength(0);
    });

  it.each(['missing', '', '__proto__', 'constructor', 'hasOwnProperty', 'giwa_attestation', 'dojang_playground', 'COINBASE_ATTESTATION'])(
    'circuit %j is refused without a call', async (circuit) => {
      const result = await verifyTrustedTopicProof(circuit, '0xab', validInputs('coinbase_attestation'));
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Unsupported verifier circuit/);
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
    const result = await verifyTrustedTopicProof('coinbase_attestation', '0xab', Array(128).fill(proofField(0)));
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
    const inputs = oidcIssuerInputs();
    inputs[147] = proofField(provider);
    expect((await verifyTrustedTopicProof('oidc_domain_attestation', '0xab', inputs)).valid).toBe(true);
    expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error' }));
    expect(state.calls).toHaveLength(1);
  });

  it('a Microsoft key scoped to one tenant is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(jwksFetch([{ ...testJwk, issuer: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0' }])));
    const inputs = oidcIssuerInputs();
    inputs[147] = proofField(1);
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
    const result = await verifyProofFromRelay(relayResult({ verifierAddress: '0x000000000000000000000000000000000000dEaD', chainId: 84532 }));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Refusing rather than trusting the response/);
    expect(state.calls).toHaveLength(0);
  });

  it('a differing chainId is refused without a call', async () => {
    const result = await verifyProofFromRelay(relayResult({ verifierAddress: '0x42d165a48256Ae184e1dE4e7E6372E870E2bC883', chainId: 8453 }));
    expect(result.valid).toBe(false);
    expect(state.calls).toHaveLength(0);
  });

  it('the pinned address in checksum case is accepted', async () => {
    expect(await verifyProofFromRelay(relayResult({ verifierAddress: '0x42d165a48256Ae184e1dE4e7E6372E870E2bC883', chainId: 84532 }))).toEqual({ valid: true });
    expect(state.calls[0].to).toBe('0x42d165a48256ae184e1de4e7e6372e870e2bc883');
  });

  it('no claim at all is accepted and verified on the pinned verifier', async () => {
    expect((await verifyProofFromRelay(relayResult({}))).valid).toBe(true);
    expect(state.calls).toHaveLength(1);
  });

  it.each([['circuit', undefined], ['circuit', ''], ['proof', undefined], ['publicInputs', undefined]])(
    'a result with no %s is refused', async (field, value) => {
      expect((await verifyProofFromRelay(relayResult({ [field]: value }))).valid).toBe(false);
      expect(state.calls).toHaveLength(0);
    });

  it('a mobile ID result reported on Base Sepolia passes in production', async () => {
    vi.stubEnv('APP_ENV', 'production');
    const result = await verifyProofFromRelay(relayResult({
      circuit: 'mdl_kr_region', publicInputs: validInputs('mdl_kr_region'),
      verifierAddress: '0x044116dF792eB424c9648DF2DeEda97aFa617Ac0', chainId: 84532,
    }));
    expect(result).toEqual({ valid: true });
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
    expect(PUBLIC_INPUT_COUNTS.mdl_kr_ownership).toBe(MDL_KR_PUBLIC_INPUT_LAYOUT.OWNERSHIP_OWNER_COMMIT_END + 1);
    expect(PUBLIC_INPUT_COUNTS.mdl_kr_age).toBe(MDL_KR_PUBLIC_INPUT_LAYOUT.AGE_CURRENT_YEAR + 1);
    expect(PUBLIC_INPUT_COUNTS.mdl_kr_region).toBe(MDL_KR_PUBLIC_INPUT_LAYOUT.REGION_CODE_END + 1);
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
