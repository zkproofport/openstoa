import type { OprfEnvironment } from '@zkproofport-app/core';

/**
 * What a wallet credential proof's OPRF nullifier is keyed by, per deployment
 * environment (APP_ENV, the keys VERIFICATION_CHAINS uses):
 *
 * - `domain` is the OPRF domain OpenStoa names in every proof request it
 *   builds, and the one a proof submitted to it must carry. The person sees it
 *   before signing. Changing it changes every member's nullifier.
 * - `environment` is the row of core's OPRF_KEY_HASHES the proof's key hash
 *   must match. Core refuses 'production' until a production key exists.
 *
 * An unknown APP_ENV throws naming it; nothing is filled in.
 */
export const OPRF_SETTINGS: Record<string, { domain: string; environment: OprfEnvironment }> = {
  production: { domain: 'openstoa.xyz', environment: 'production' },
  staging: { domain: 'stg-community.zkproofport.app', environment: 'staging' },
  development: { domain: 'localhost', environment: 'local' },
  local: { domain: 'localhost', environment: 'local' },
};

export function oprfSettingsFor(environment: string | undefined): { domain: string; environment: OprfEnvironment } {
  if (!environment || !Object.hasOwn(OPRF_SETTINGS, environment)) {
    throw new Error(`Unknown APP_ENV '${environment}' for the OPRF domain. Known: ${Object.keys(OPRF_SETTINGS).join(', ')}.`);
  }
  return OPRF_SETTINGS[environment];
}
