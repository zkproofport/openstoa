/**
 * createRelayProofRequest / pollProofResult.
 *
 * Edge matrix for the request side (each row maps to a test below):
 *  - circuit: each of the six OpenStoa circuits is sent as itself with its own
 *    message; missing, '', wrong case, prototype keys and a core circuit OpenStoa
 *    does not request (giwa_attestation) throw naming the known ids, before the SDK.
 *  - dApp icon: production / staging / development / local each map to their icon;
 *    unset, '', 'Production', prototype keys and an unknown env throw naming the
 *    known envs, before the SDK; an explicit dappIcon is used as given.
 *  - OIDC request record: an OIDC request records { scope, circuit } under its
 *    requestId with a TTL; non-OIDC requests write nothing; a failed write fails
 *    the request (the proof could never be bound).
 *  - Coinbase Country (v2): the request records { scope, circuit, countryCondition }
 *    (the list exactly as asked, and isIncluded); a failed write fails it; a missing,
 *    empty, 11-code, lower-case, 3-letter, non-array list and a missing / non-boolean
 *    isIncluded are refused with RelayRequestInputError before the SDK; 1 and 10
 *    codes accepted. Nothing is filled in.
 *  - OIDC scope: blank / whitespace / over 4096 UTF-8 bytes refused before the SDK;
 *    exactly 4096 bytes, Korean and emoji scopes accepted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSDKInstance = vi.hoisted(() => ({
  createRelayRequest: vi.fn().mockResolvedValue({ requestId: 'req-123', deepLink: 'zkproofport://test' }),
  pollResult: vi.fn().mockResolvedValue({ status: 'completed', proof: '0x...' }),
  setSigner: vi.fn(),
}));

vi.mock('@zkproofport-app/sdk', () => {
  const SDK = vi.fn().mockImplementation(() => mockSDKInstance);
  (SDK as any).create = vi.fn().mockImplementation(() => mockSDKInstance);
  return { ProofportSDK: SDK };
});

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers');
  return { ethers: { ...actual.ethers, Wallet: { createRandom: vi.fn().mockReturnValue({}) } } };
});

const redisSet = vi.hoisted(() => vi.fn());
vi.mock('@/lib/redis', () => ({ redis: { set: redisSet } }));

beforeEach(() => {
  vi.clearAllMocks();
  mockSDKInstance.createRelayRequest.mockResolvedValue({ requestId: 'req-123', deepLink: 'zkproofport://test' });
  mockSDKInstance.pollResult.mockResolvedValue({ status: 'completed', proof: '0x...' });
  delete process.env.RELAY_URL;
  redisSet.mockReset().mockResolvedValue('OK');
  vi.stubEnv('APP_ENV', 'staging');
  vi.resetModules();
});

describe('createRelayProofRequest', () => {
  it('returns requestId and deepLink', async () => {
    const { createRelayProofRequest } = await import('@/lib/relay');

    const result = await createRelayProofRequest('zkproofport-community', { circuitType: 'coinbase_attestation' });

    expect(result.requestId).toBe('req-123');
    expect(result.deepLink).toBe('zkproofport://test');
  });

  it('uses ProofportSDK constructor with RELAY_URL when set', async () => {
    process.env.RELAY_URL = 'http://relay:4001';
    vi.resetModules();

    const { ProofportSDK } = await import('@zkproofport-app/sdk');
    const { createRelayProofRequest } = await import('@/lib/relay');

    await createRelayProofRequest('zkproofport-community', { circuitType: 'coinbase_attestation' });

    expect(ProofportSDK).toHaveBeenCalledWith({ relayUrl: 'http://relay:4001' });
    expect((ProofportSDK as any).create).not.toHaveBeenCalled();
  });

  it('uses ProofportSDK.create() when RELAY_URL is not set', async () => {
    vi.resetModules();

    const { ProofportSDK } = await import('@zkproofport-app/sdk');
    const { createRelayProofRequest } = await import('@/lib/relay');

    await createRelayProofRequest('zkproofport-community', { circuitType: 'coinbase_attestation' });

    expect((ProofportSDK as any).create).toHaveBeenCalled();
    expect(ProofportSDK).not.toHaveBeenCalledWith(expect.objectContaining({ relayUrl: expect.anything() }));
  });

  it('passes countryList for coinbase_country_attestation circuit', async () => {
    const { createRelayProofRequest } = await import('@/lib/relay');

    await createRelayProofRequest('zkproofport-community', {
      circuitType: 'coinbase_country_attestation',
      countryList: ['US', 'KR'],
      isIncluded: true,
    });

    const [, inputs] = mockSDKInstance.createRelayRequest.mock.calls[0];
    expect(inputs.countryList).toEqual(['US', 'KR']);
    expect(inputs.isIncluded).toBe(true);
  });

  it('passes domain and provider for oidc_domain_attestation circuit', async () => {
    const { createRelayProofRequest } = await import('@/lib/relay');

    await createRelayProofRequest('zkproofport-community', {
      circuitType: 'oidc_domain_attestation',
      domain: 'company.com',
      provider: 'google',
    });

    const [, inputs] = mockSDKInstance.createRelayRequest.mock.calls[0];
    expect(inputs.domain).toBe('company.com');
    expect(inputs.provider).toBe('google');
  });
});

describe('pollProofResult', () => {
  it('returns the result from SDK pollResult', async () => {
    const { pollProofResult } = await import('@/lib/relay');

    const result = await pollProofResult('req-123');

    expect(mockSDKInstance.pollResult).toHaveBeenCalledWith('req-123');
    expect(result).toMatchObject({ status: 'completed', proof: '0x...' });
  });

  /**
   * The typed-error wrapper closing the auth/poll route's residual leak:
   * the SDK's ONLY signal for "the relay genuinely has no record of this
   * request" is throwing the exact literal 'Request not found or expired'
   * (verified against the installed package). Everything else the SDK
   * throws carries the relay's own (potentially arbitrary) response text.
   */
  it('converts the SDK\'s exact "not found or expired" message into RelayRequestNotFoundError', async () => {
    mockSDKInstance.pollResult.mockRejectedValue(new Error('Request not found or expired'));
    const { pollProofResult, RelayRequestNotFoundError } = await import('@/lib/relay');

    await expect(pollProofResult('gone-123')).rejects.toBeInstanceOf(RelayRequestNotFoundError);
  });

  it('does NOT convert a message that merely CONTAINS "not found" — only an exact match qualifies', async () => {
    // Regression guard for the bug this replaces: a substring test would have
    // wrongly classified this as "not found" and (worse) echoed the whole
    // upstream-controlled text to the client.
    mockSDKInstance.pollResult.mockRejectedValue(
      new Error('upstream service https://internal-relay-7.corp:9443/health not found, connection refused'),
    );
    const { pollProofResult, RelayRequestNotFoundError } = await import('@/lib/relay');

    await expect(pollProofResult('req-x')).rejects.not.toBeInstanceOf(RelayRequestNotFoundError);
  });

  it('does NOT convert a message that merely CONTAINS "expired" — only an exact match qualifies', async () => {
    mockSDKInstance.pollResult.mockRejectedValue(new Error('TLS certificate for relay.internal expired 2026-01-01'));
    const { pollProofResult, RelayRequestNotFoundError } = await import('@/lib/relay');

    await expect(pollProofResult('req-y')).rejects.not.toBeInstanceOf(RelayRequestNotFoundError);
  });

  it('passes through any other error unchanged — no message rewriting, no swallowing', async () => {
    const original = new Error('relay says: db pool exhausted at proofport-relay/src/index.ts:88');
    mockSDKInstance.pollResult.mockRejectedValue(original);
    const { pollProofResult } = await import('@/lib/relay');

    await expect(pollProofResult('req-z')).rejects.toBe(original);
  });

  it('passes through a non-Error thrown value unchanged', async () => {
    mockSDKInstance.pollResult.mockRejectedValue('a raw string throw');
    const { pollProofResult } = await import('@/lib/relay');

    await expect(pollProofResult('req-w')).rejects.toBe('a raw string throw');
  });
});

describe('the circuit is never filled in', () => {
  it.each([undefined, '', 'COINBASE_ATTESTATION', '__proto__', 'constructor', 'hasOwnProperty', 'giwa_attestation',
    'mdl_kr_ownership', 'mdl_kr_age', 'mdl_kr_region'])(
    'circuit %j throws naming the known circuits, before the SDK', async (circuit) => {
      const { createRelayProofRequest } = await import('@/lib/relay');
      await expect(createRelayProofRequest('s', { circuitType: circuit as never }))
        .rejects.toThrow(/Unknown circuit .*Known: coinbase_attestation, coinbase_country_attestation, oidc_domain_attestation\.$/);
      expect(mockSDKInstance.createRelayRequest).not.toHaveBeenCalled();
    });

  it.each([
    ['coinbase_attestation', 'Verify your Coinbase KYC to access OpenStoa'],
    ['coinbase_country_attestation', 'Verify your country via Coinbase attestation for OpenStoa'],
    ['oidc_domain_attestation', 'Verify your organization affiliation for OpenStoa'],
  ])('%s is requested as itself with its own message', async (circuit, message) => {
    const { createRelayProofRequest } = await import('@/lib/relay');
    await createRelayProofRequest('s', { circuitType: circuit as never, countryList: ['KR'], isIncluded: true });
    const [sent, , options] = mockSDKInstance.createRelayRequest.mock.calls[0];
    expect(sent).toBe(circuit);
    expect(options.message).toBe(message);
  });

  it.each([['google', 'Google Workspace'], ['microsoft', 'Microsoft 365']] as const)(
    'the OIDC message names %s', async (provider, name) => {
      const { createRelayProofRequest } = await import('@/lib/relay');
      await createRelayProofRequest('s', { circuitType: 'oidc_domain_attestation', provider });
      expect(mockSDKInstance.createRelayRequest.mock.calls[0][2].message).toBe(`Verify ${name} affiliation for OpenStoa`);
    });
});

describe('the dApp icon comes from a table keyed by APP_ENV', () => {
  it.each([
    ['production', 'https://www.openstoa.xyz/icon.png'],
    ['staging', 'https://stg-community.zkproofport.app/icon.png'],
    ['development', 'http://localhost:3200/icon.png'],
    ['local', 'http://localhost:3200/icon.png'],
  ])('%s -> %s', async (env, icon) => {
    vi.stubEnv('APP_ENV', env);
    const { createRelayProofRequest } = await import('@/lib/relay');
    await createRelayProofRequest('s', { circuitType: 'coinbase_attestation' });
    expect(mockSDKInstance.createRelayRequest.mock.calls[0][2].dappIcon).toBe(icon);
  });

  it.each([undefined, '', 'Production', 'test', '__proto__', 'constructor'])(
    'APP_ENV %j throws naming the known environments, before the SDK', async (env) => {
      vi.stubEnv('APP_ENV', env as string);
      const { createRelayProofRequest, dappIconFor } = await import('@/lib/relay');
      expect(() => dappIconFor(env)).toThrow(/Unknown APP_ENV .*Known: production, staging, development, local/);
      await expect(createRelayProofRequest('s', { circuitType: 'coinbase_attestation' })).rejects.toThrow(/Unknown APP_ENV/);
      expect(mockSDKInstance.createRelayRequest).not.toHaveBeenCalled();
    });

  it('an explicit dappIcon is used as given', async () => {
    vi.stubEnv('APP_ENV', 'unknown');
    const { createRelayProofRequest } = await import('@/lib/relay');
    await createRelayProofRequest('s', { circuitType: 'coinbase_attestation', dappIcon: 'https://x.test/i.png' });
    expect(mockSDKInstance.createRelayRequest.mock.calls[0][2].dappIcon).toBe('https://x.test/i.png');
  });
});

describe('an OIDC request is recorded so its proof can be bound to it', () => {
  it('records { scope, circuit } under the relay requestId with a TTL', async () => {
    const { createRelayProofRequest } = await import('@/lib/relay');
    await createRelayProofRequest('zkproofport-community', { circuitType: 'oidc_domain_attestation' });
    expect(redisSet).toHaveBeenCalledExactlyOnceWith(
      'community:relay-request:req-123',
      JSON.stringify({ scope: 'zkproofport-community', circuit: 'oidc_domain_attestation' }),
      'EX', 1800,
    );
  });

  it('coinbase_attestation writes no record', async () => {
    const { createRelayProofRequest } = await import('@/lib/relay');
    await createRelayProofRequest('s', { circuitType: 'coinbase_attestation' });
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('a failed record write fails the request', async () => {
    redisSet.mockRejectedValue(new Error('redis down'));
    const { createRelayProofRequest } = await import('@/lib/relay');
    await expect(createRelayProofRequest('s', { circuitType: 'oidc_domain_attestation' })).rejects.toThrow('redis down');
  });

  it.each(['', '   ', '\n\t', 'a'.repeat(4097), '가'.repeat(1366)])('OIDC scope of %#th shape is refused before the SDK', async (scope) => {
    const { createRelayProofRequest } = await import('@/lib/relay');
    await expect(createRelayProofRequest(scope, { circuitType: 'oidc_domain_attestation' })).rejects.toThrow(/non-blank scope/);
    expect(mockSDKInstance.createRelayRequest).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it.each(['a'.repeat(4096), 'zkproofport-community:topic:사용자', 'scope 🚀'])('OIDC scope %#th shape is accepted', async (scope) => {
    const { createRelayProofRequest } = await import('@/lib/relay');
    await createRelayProofRequest(scope, { circuitType: 'oidc_domain_attestation' });
    expect(JSON.parse(redisSet.mock.calls[0][1]).scope).toBe(scope);
  });
});

describe('a Coinbase Country request carries its list as asked, and is recorded', () => {
  const TEN = ['KR', 'US', 'JP', 'DE', 'FR', 'GB', 'CA', 'AU', 'SG', 'NZ'];

  it.each([[['KR']], [TEN], [['US', 'KR']]])('list %j is sent and recorded unchanged', async (countryList) => {
    const { createRelayProofRequest } = await import('@/lib/relay');
    await createRelayProofRequest('zkproofport-community:topic:u', { circuitType: 'coinbase_country_attestation', countryList, isIncluded: true });
    const [, inputs] = mockSDKInstance.createRelayRequest.mock.calls[0];
    expect(inputs).toEqual({ scope: 'zkproofport-community:topic:u', countryList, isIncluded: true });
    expect(redisSet).toHaveBeenCalledExactlyOnceWith(
      'community:relay-request:req-123',
      JSON.stringify({ scope: 'zkproofport-community:topic:u', circuit: 'coinbase_country_attestation', countryCondition: { countryList, isIncluded: true } }),
      'EX', 1800,
    );
  });

  it('an exclusion request records isIncluded false', async () => {
    const { createRelayProofRequest } = await import('@/lib/relay');
    await createRelayProofRequest('s', { circuitType: 'coinbase_country_attestation', countryList: ['KR'], isIncluded: false });
    expect(JSON.parse(redisSet.mock.calls[0][1]).countryCondition).toEqual({ countryList: ['KR'], isIncluded: false });
  });

  it.each([
    ['missing', undefined],
    ['empty', []],
    ['11 codes', [...TEN, 'BR']],
    ['lower case', ['kr']],
    ['three letters', ['KOR']],
    ['a string', 'KR'],
    ['a non-string code', [82]],
    ['SQL-shaped', ["K'; DROP --"]],
    ['emoji', ['🇰🇷']],
  ])('countryList %s is refused before the SDK', async (_label, countryList) => {
    const { createRelayProofRequest, RelayRequestInputError } = await import('@/lib/relay');
    const attempt = createRelayProofRequest('s', { circuitType: 'coinbase_country_attestation', countryList: countryList as never, isIncluded: true });
    await expect(attempt).rejects.toBeInstanceOf(RelayRequestInputError);
    await expect(attempt).rejects.toThrow(/^countryList: /);
    expect(mockSDKInstance.createRelayRequest).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it.each([[undefined], ['true'], [1], [null]])('isIncluded %j is refused, never filled in', async (isIncluded) => {
    const { createRelayProofRequest, RelayRequestInputError } = await import('@/lib/relay');
    await expect(createRelayProofRequest('s', { circuitType: 'coinbase_country_attestation', countryList: ['KR'], isIncluded: isIncluded as never }))
      .rejects.toBeInstanceOf(RelayRequestInputError);
    expect(mockSDKInstance.createRelayRequest).not.toHaveBeenCalled();
  });

  it('a failed record write fails the request', async () => {
    redisSet.mockRejectedValue(new Error('redis down'));
    const { createRelayProofRequest } = await import('@/lib/relay');
    await expect(createRelayProofRequest('s', { circuitType: 'coinbase_country_attestation', countryList: ['KR'], isIncluded: true }))
      .rejects.toThrow('redis down');
  });

  it('a country list on a KYC request is ignored, not sent', async () => {
    const { createRelayProofRequest } = await import('@/lib/relay');
    await createRelayProofRequest('s', { circuitType: 'coinbase_attestation', countryList: ['KR'], isIncluded: true });
    expect(mockSDKInstance.createRelayRequest.mock.calls[0][1]).toEqual({ scope: 's' });
  });
});
