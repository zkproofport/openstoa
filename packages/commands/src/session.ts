import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Persisted CLI/MCP session. The Bearer token is a session credential, not an MLS
 * key — it lives in a 0600 `session.json` next to the vault (SI-1: still never
 * logged, still owner-only on disk). MLS/TAK keys stay in the SDK's vault.
 */
export interface SessionData {
  baseUrl: string;
  token?: string;
  userId?: string;
  nickname?: string;
}

export interface SessionStore {
  read(): Promise<SessionData | null>;
  write(data: SessionData): Promise<void>;
  clear(): Promise<void>;
}

/** File-backed session store. The file is written 0600, the parent dir 0700. */
export class FileSessionStore implements SessionStore {
  constructor(private readonly file: string) {}

  async read(): Promise<SessionData | null> {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      return JSON.parse(raw) as SessionData;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async write(data: SessionData): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(tmp, 0o600).catch(() => {});
    await fs.rename(tmp, this.file);
    await fs.chmod(this.file, 0o600).catch(() => {});
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}

/** In-memory store for tests / ephemeral MCP sessions. */
export class MemorySessionStore implements SessionStore {
  private data: SessionData | null;
  constructor(initial: SessionData | null = null) {
    this.data = initial;
  }
  async read(): Promise<SessionData | null> {
    return this.data;
  }
  async write(data: SessionData): Promise<void> {
    this.data = data;
  }
  async clear(): Promise<void> {
    this.data = null;
  }
}
