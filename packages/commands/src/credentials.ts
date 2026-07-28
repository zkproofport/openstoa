import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Optional `<home>/credentials` file — a persistent alternative to the
 * `OPENSTOA_API_KEY` env var for agents that can't (or shouldn't) rely on the
 * calling process's environment (design §7 follow-up, API-key auth). Lets an
 * operator bootstrap once with `openstoa login`, mint a scoped key via
 * `openstoa apikey create`, and drop it here so every subsequent CLI/MCP
 * invocation authenticates with NO interactive login at all.
 *
 * Read-only from this package's perspective — nothing here ever WRITES the
 * file; that's an operator/deployment concern, kept simple on purpose.
 */
export interface Credentials {
  apiKey?: string;
}

/** Read `<home>/credentials` (JSON). Returns null if absent or malformed — never throws. */
export async function readCredentials(home: string): Promise<Credentials | null> {
  try {
    const raw = await fs.readFile(path.join(home, 'credentials'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const apiKey = (parsed as Record<string, unknown>).apiKey;
    return { apiKey: typeof apiKey === 'string' ? apiKey : undefined };
  } catch {
    // Missing file, bad JSON, permission error — treat as "no credentials"
    // rather than crash agent startup over an optional bootstrap file.
    return null;
  }
}
