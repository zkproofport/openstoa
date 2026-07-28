/**
 * File-backed SecureKVStore for a Node SDK agent (the DEFAULT keystore).
 *
 * Layout under the vault root (default `~/.openstoa/vault`):
 *   <root>/_global/<key>            — identity / master_key and other unscoped keys
 *   <root>/<topicId>/<key>          — per-topic MLS state, TAK keys, message cache
 *
 * SI-1: this holds the agent's self-custodied secrets. Every file is written 0600
 * and every directory 0700, so keys never leak to other local users. Values are
 * still MLS/TAK ciphertext or master_key-encrypted blobs when wrapped by
 * EncryptingKVStore; the file perms are defence-in-depth, not the only guard.
 *
 * SecureKVStore keys arrive as opaque strings (e.g. `mls.state.<id>.<topic>`,
 * `tak.epoch.<topic>.<n>`). We sanitise them into a single safe filename so a
 * stray `/` or `..` can never escape the namespace directory.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SecureKVStore } from '../mls';

const GLOBAL_NS = '_global';

/** Map an opaque store key to a filesystem-safe basename (no path traversal). */
function safeName(key: string): string {
  // Encode everything outside [A-Za-z0-9._-] so `/`, `..`, control chars, etc.
  // can never produce a path segment. Length-cap to stay under filesystem limits;
  // a hash suffix keeps distinct long keys from colliding after truncation.
  const encoded = key.replace(/[^A-Za-z0-9._-]/g, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'));
  if (encoded.length <= 200) return encoded;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  return encoded.slice(0, 190) + '.' + (h >>> 0).toString(16);
}

/** Expand a leading `~` to the user's home directory. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface FileVaultStoreOptions {
  /** Vault root. Defaults to `~/.openstoa/vault`. */
  root?: string;
  /** Namespace directory (a topicId, or the global area). Defaults to global. */
  namespace?: string;
}

export class FileVaultStore implements SecureKVStore {
  private readonly dir: string;

  constructor(opts: FileVaultStoreOptions = {}) {
    const root = expandHome(opts.root ?? path.join(os.homedir(), '.openstoa', 'vault'));
    const ns = opts.namespace && opts.namespace.length > 0 ? safeName(opts.namespace) : GLOBAL_NS;
    this.dir = path.join(root, ns);
  }

  /** A store scoped to a specific topic under the same root. */
  static forTopic(root: string | undefined, topicId: string): FileVaultStore {
    return new FileVaultStore({ root, namespace: topicId });
  }

  private file(key: string): string {
    return path.join(this.dir, safeName(key));
  }

  async get(key: string): Promise<string | null> {
    try {
      return await fs.readFile(this.file(key), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async set(key: string, value: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const target = this.file(key);
    // Write to a temp sibling then rename, so a crash mid-write never leaves a
    // truncated key file. The temp file is created 0600 up front.
    const tmp = target + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
    await fs.writeFile(tmp, value, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(tmp, 0o600).catch(() => {});
    await fs.rename(tmp, target);
    await fs.chmod(target, 0o600).catch(() => {});
  }
}
