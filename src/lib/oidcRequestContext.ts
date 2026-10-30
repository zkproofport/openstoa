import { createHash } from 'node:crypto';
import { countryListError, OIDC_NOW_MAX_AGE_SECONDS, type CountryCondition, type OidcRequestContext } from '@zkproofport-app/core';
import { redis } from './redis';

/**
 * The request an `oidc_domain_attestation` proof answers.
 *
 * A proof made by the ZKProofport app is nonce bound (nonce_mode 1): the ID
 * token's nonce commits to keccak256(scope) and the relay requestId, and core
 * checks that binding only when it is handed `{ scope, requestId }`. Without
 * it, a mode-1 proof made for any other request would pass. So OpenStoa
 * records the scope of every OIDC relay request it creates, and a verifier
 * that cannot find the record refuses the proof (see `verifyProofFromRelay`).
 *
 * The same record holds a `coinbase_country_attestation` request's country
 * list and direction: the proof's list is a public input the prover chooses,
 * so its result is verified against the list OpenStoa asked for.
 */
const REQUEST_KEY = (requestId: string) => `community:relay-request:${requestId}`;
const BOUND_PROOF_KEY = (proof: string) =>
  `community:oidc-bound-proof:${createHash('sha256').update(proof).digest('hex')}`;

// Longer than the relay keeps a request, so a record never expires before the
// result it describes can be polled.
export const RELAY_REQUEST_TTL_SECONDS = 30 * 60;

export interface RelayRequestRecord {
  scope: string;
  circuit: string;
  /** Coinbase Country requests only: the list and direction asked for. */
  countryCondition?: CountryCondition;
}

function parseCountryCondition(value: unknown): CountryCondition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { countryList, isIncluded } = value as Record<string, unknown>;
  if (countryListError(countryList) !== undefined || typeof isIncluded !== 'boolean') return null;
  return { countryList: [...(countryList as string[])], isIncluded };
}

function parseRecord(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown> : null;
}

export async function rememberRelayRequest(requestId: string, record: RelayRequestRecord): Promise<void> {
  if (typeof requestId !== 'string' || requestId === '') {
    throw new Error('Cannot record a relay request without a requestId');
  }
  await redis.set(REQUEST_KEY(requestId), JSON.stringify(record), 'EX', RELAY_REQUEST_TTL_SECONDS);
}

/** The recorded request, or null when OpenStoa has no (readable) record of it. */
export async function relayRequestFor(requestId: string): Promise<RelayRequestRecord | null> {
  if (typeof requestId !== 'string' || requestId === '') return null;
  const record = parseRecord(await redis.get(REQUEST_KEY(requestId)));
  if (!record || typeof record.scope !== 'string' || typeof record.circuit !== 'string') return null;
  if (record.countryCondition === undefined) return { scope: record.scope, circuit: record.circuit };
  // A condition that does not read back is a corrupt record, not "no condition".
  const countryCondition = parseCountryCondition(record.countryCondition);
  if (!countryCondition) return null;
  return { scope: record.scope, circuit: record.circuit, countryCondition };
}

/**
 * A proof-only poll hands the proof back to the client, which submits it to a
 * topic gate later. The gate has no requestId of its own, so the request this
 * proof was verified against is kept beside it -- only as long as core would
 * still accept the proof's `now`.
 */
export async function rememberBoundOidcProof(proof: string, request: OidcRequestContext): Promise<void> {
  await redis.set(BOUND_PROOF_KEY(proof), JSON.stringify(request), 'EX', OIDC_NOW_MAX_AGE_SECONDS);
}

export async function boundOidcProofRequest(proof: string): Promise<OidcRequestContext | null> {
  const record = parseRecord(await redis.get(BOUND_PROOF_KEY(proof)));
  if (!record || typeof record.scope !== 'string' || typeof record.requestId !== 'string') return null;
  return { scope: record.scope, requestId: record.requestId };
}
