import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';

/** Locally selected permission key. Proof login remains a separate requirement. */
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

/** Atomically replace the selected key; neither terminal output nor logs contain it. */
export async function writeCredentials(home: string, credentials: Credentials): Promise<void> {
  await fs.mkdir(home, {recursive:true, mode:0o700});
  const temporary=path.join(home, `.credentials-${randomUUID()}`);
  try {
    await fs.writeFile(temporary, JSON.stringify(credentials)+'\n', {mode:0o600, flag:'wx'});
    await fs.rename(temporary, path.join(home,'credentials'));
  } finally {
    await fs.rm(temporary, {force:true});
  }
}
