import { ethers } from 'ethers';
import { ProofportSDK } from '@zkproofport-app/sdk';
import type { CircuitType, RelayProofResult } from '@zkproofport-app/sdk';
import { OIDC_MAX_SCOPE_BYTES } from '@zkproofport-app/core';
import { rememberRelayRequest } from './oidcRequestContext';

function createSDK(): ProofportSDK {
  const relayUrl = process.env.RELAY_URL;

  let sdk: ProofportSDK;
  if (relayUrl) {
    // Local Docker or custom relay
    sdk = new ProofportSDK({ relayUrl });
  } else {
    // Production relay (used by both staging and production)
    sdk = ProofportSDK.create();
  }

  // Ephemeral random wallet per request — only used for relay nonce replay prevention
  sdk.setSigner(ethers.Wallet.createRandom());
  return sdk;
}

// The circuits OpenStoa requests proofs for: the ones it can also verify
// (VerifiableCircuit in ./proof).
export type ExtendedCircuitType =
  | 'coinbase_attestation'
  | 'coinbase_country_attestation'
  | 'oidc_domain_attestation';

const PROVIDER_NAMES: Record<'google' | 'microsoft', string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft 365',
};

// What the proof request asks the person to confirm, per circuit. Also the
// list of circuits OpenStoa requests at all: a circuit not in it is refused,
// never sent as some other circuit's request.
const DEFAULT_MESSAGES: Record<ExtendedCircuitType, (provider?: 'google' | 'microsoft') => string> = {
  coinbase_attestation: () => 'Verify your Coinbase KYC to access OpenStoa',
  coinbase_country_attestation: () => 'Verify your country via Coinbase attestation for OpenStoa',
  oidc_domain_attestation: (provider) =>
    `Verify ${provider ? PROVIDER_NAMES[provider] : 'your organization'} affiliation for OpenStoa`,
};

export const RELAY_CIRCUITS = Object.keys(DEFAULT_MESSAGES) as ExtendedCircuitType[];

export function isRelayCircuit(value: unknown): value is ExtendedCircuitType {
  return typeof value === 'string' && Object.hasOwn(DEFAULT_MESSAGES, value);
}

// The icon the ZKProofport app shows for an OpenStoa request, per deployment
// environment (APP_ENV, the same keys proof verification uses).
const DAPP_ICONS: Record<string, string> = {
  production: 'https://www.openstoa.xyz/icon.png',
  staging: 'https://stg-community.zkproofport.app/icon.png',
  development: 'http://localhost:3200/icon.png',
  local: 'http://localhost:3200/icon.png',
};

export function dappIconFor(environment: string | undefined): string {
  if (!environment || !Object.hasOwn(DAPP_ICONS, environment)) {
    throw new Error(`Unknown APP_ENV '${environment}'. Known: ${Object.keys(DAPP_ICONS).join(', ')}.`);
  }
  return DAPP_ICONS[environment];
}

export async function createRelayProofRequest(
  scope: string,
  options: {
    circuitType: ExtendedCircuitType;
    dappName?: string;
    dappIcon?: string;
    message?: string;
    countryList?: string[];
    isIncluded?: boolean;
    domain?: string;
    provider?: 'google' | 'microsoft';
  },
): Promise<{ requestId: string; deepLink: string }> {
  const circuit = options?.circuitType;
  if (!isRelayCircuit(circuit)) {
    throw new Error(`Unknown circuit '${circuit}'. Known: ${RELAY_CIRCUITS.join(', ')}.`);
  }
  // Core binds an app OIDC proof to keccak256(scope) and refuses a blank
  // scope or one over OIDC_MAX_SCOPE_BYTES at verification; refuse it here,
  // before the person proves for a request that can never verify.
  if (circuit === 'oidc_domain_attestation'
    && (typeof scope !== 'string' || scope.trim() === '' || Buffer.byteLength(scope, 'utf8') > OIDC_MAX_SCOPE_BYTES)) {
    throw new Error(`An OIDC proof request needs a non-blank scope of at most ${OIDC_MAX_SCOPE_BYTES} UTF-8 bytes.`);
  }
  const dappIcon = options.dappIcon ?? dappIconFor(process.env.APP_ENV);
  const sdk = createSDK();
  const inputs: Record<string, unknown> = { scope };
  if (circuit === 'coinbase_country_attestation') {
    inputs.countryList = options.countryList ?? [];
    inputs.isIncluded = options.isIncluded ?? true;
  }
  if (circuit === 'oidc_domain_attestation') {
    if (options.domain) inputs.domain = options.domain;
    if (options.provider) inputs.provider = options.provider;
  }

  const relay = await sdk.createRelayRequest(circuit satisfies CircuitType, inputs as any, {
    dappName: options.dappName ?? 'OpenStoa',
    dappIcon,
    message: options.message ?? DEFAULT_MESSAGES[circuit](options.provider),
  });
  // An OIDC proof from the app is bound to this request's scope and id, and
  // its verifier needs both to check that (verifyProofFromRelay). If the
  // record cannot be written, the request is useless: fail now, not at poll.
  if (circuit === 'oidc_domain_attestation') {
    await rememberRelayRequest(relay.requestId, { scope, circuit });
  }
  return { requestId: relay.requestId, deepLink: relay.deepLink };
}

/**
 * Thrown when the relay genuinely has no record of `requestId` (expired or
 * never existed) — a real, expected 404 condition, not a leak.
 *
 * WHY THIS EXISTS: `@zkproofport-app/sdk`'s `pollResult` is a plain
 * `throw new Error(...)` interface with no typed/discriminated error and no
 * HTTP status attached to the thrown value (verified against the installed
 * package — see `node_modules/@zkproofport-app/sdk/dist/index.js`). For a
 * real relay 404 it throws the exact literal `'Request not found or
 * expired'` — a fixed string the SDK owns, never derived from upstream
 * content. For every OTHER relay failure it throws
 * `new Error(error.error || 'Poll failed: HTTP ' + status)`, where
 * `error.error` is the relay's OWN response body verbatim — arbitrary,
 * upstream-controlled text.
 *
 * The route used to do `message.includes('not found') ||
 * message.includes('expired')` and echo the caught `message` straight to
 * the client on a match. That is wrong twice over: (1) it also matches the
 * SECOND, arbitrary-text case whenever the relay's own error happens to
 * contain either substring, and (2) even on a genuine match it echoes
 * whatever else that text carries, not just the safe fixed phrase — the
 * same class of leak this file's error-leak sweep closed everywhere else,
 * just reached through a keyword gate instead of a bare catch-all.
 *
 * This wrapper does the ONE comparison that is actually safe — an EXACT
 * match against the SDK's own fixed literal, not a substring test — and
 * converts it to a typed error the route can `instanceof`-check. Anything
 * else (including the arbitrary-text case) passes through unchanged and
 * falls into the route's normal `unhandledRouteError` catch-all, which logs
 * the full text server-side and never puts it in the response.
 */
export class RelayRequestNotFoundError extends Error {
  constructor() {
    super('Request not found or expired');
    this.name = 'RelayRequestNotFoundError';
  }
}

const SDK_NOT_FOUND_MESSAGE = 'Request not found or expired';

export async function pollProofResult(
  requestId: string,
): Promise<RelayProofResult> {
  const sdk = createSDK();
  try {
    return await sdk.pollResult(requestId);
  } catch (error) {
    if (error instanceof Error && error.message === SDK_NOT_FOUND_MESSAGE) {
      throw new RelayRequestNotFoundError();
    }
    throw error;
  }
}

export { createSDK };
