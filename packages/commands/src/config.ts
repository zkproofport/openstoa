import * as os from 'node:os';
import * as path from 'node:path';

/** Backends the CLI/MCP accept. `vault` is the only one wired through ChatClient today. */
export type KeystoreBackend = 'vault' | 'keychain';

export interface CommandConfig {
  /** OpenStoa origin, e.g. `http://localhost:3200`. Falls back to OPENSTOA_BASE_URL then the saved session. */
  baseUrl?: string;
  /** The `.openstoa` home directory (keys + session). Defaults to `~/.openstoa`. */
  vaultRoot?: string;
  /** Keystore backend flag. Default `vault`. */
  backend?: KeystoreBackend;
  /** Stable MLS device identity override (else auto-persisted in the vault). */
  deviceId?: string;
  /**
   * A scoped API key (`osk_...`), an alternative to interactive `login` that
   * lets an agent authenticate with zero login round-trip (design §7
   * follow-up). Priority in `createCommands`: this field > `OPENSTOA_API_KEY`
   * env > `<home>/credentials` file > the saved session token.
   */
  apiKey?: string;
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolve the `.openstoa` home directory (session.json + vault live here). */
export function resolveHome(vaultRoot?: string): string {
  return expandHome(vaultRoot ?? path.join(os.homedir(), '.openstoa'));
}
