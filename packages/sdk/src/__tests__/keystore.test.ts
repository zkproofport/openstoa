/**
 * FileVaultStore unit tests: round-trip, per-topic namespacing, 0600/0700 perms,
 * path-traversal safety, and the createKeyStore factory fallback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileVaultStore, createKeyStore, createFileVaultStore } from '../keystore';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'openstoa-vault-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('FileVaultStore', () => {
  it('round-trips a value and returns null for a missing key', async () => {
    const s = new FileVaultStore({ root });
    expect(await s.get('missing')).toBeNull();
    await s.set('k', 'v-value-123');
    expect(await s.get('k')).toBe('v-value-123');
    await s.set('k', 'overwritten');
    expect(await s.get('k')).toBe('overwritten');
  });

  it('isolates namespaces (per-topic directories + a global area)', async () => {
    const g = new FileVaultStore({ root });
    const t1 = new FileVaultStore({ root, namespace: 'topic-aaa' });
    const t2 = new FileVaultStore({ root, namespace: 'topic-bbb' });
    await g.set('master_key', 'GLOBAL');
    await t1.set('mls.state.dev.topic-aaa', 'STATE1');
    await t2.set('mls.state.dev.topic-bbb', 'STATE2');
    // Same key name in different namespaces does not collide.
    await t1.set('shared', 'ONE');
    await t2.set('shared', 'TWO');
    expect(await t1.get('shared')).toBe('ONE');
    expect(await t2.get('shared')).toBe('TWO');
    expect(await g.get('master_key')).toBe('GLOBAL');
    // The on-disk layout has the expected directories.
    const dirs = await fs.readdir(path.join(root));
    expect(dirs).toContain('_global');
    expect(dirs).toContain('topic-aaa');
    expect(dirs).toContain('topic-bbb');
  });

  it('writes files 0600 and directories 0700', async () => {
    const s = new FileVaultStore({ root, namespace: 'perm' });
    await s.set('secret', 'x');
    const dirStat = await fs.stat(path.join(root, 'perm'));
    const fileStat = await fs.stat(path.join(root, 'perm', 'secret'));
    // Mask to the permission bits.
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it('neutralizes path traversal / separators in keys (no escape from the namespace dir)', async () => {
    const s = new FileVaultStore({ root, namespace: 'ns' });
    const evil = '../../etc/passwd';
    await s.set(evil, 'contained');
    expect(await s.get(evil)).toBe('contained');
    // Nothing was written outside the namespace directory.
    const nsFiles = await fs.readdir(path.join(root, 'ns'));
    expect(nsFiles.length).toBe(1);
    // The escaping path does not exist.
    await expect(fs.stat(path.join(root, 'etc'))).rejects.toBeTruthy();
    // Slashes in the key are encoded, not turned into subdirectories.
    expect(nsFiles[0]).not.toContain('/');
  });

  it('round-trips UTF-8, empty string, and large values', async () => {
    const s = new FileVaultStore({ root, namespace: 'utf' });
    await s.set('kr', '안녕하세요 🌏 test');
    expect(await s.get('kr')).toBe('안녕하세요 🌏 test');
    await s.set('empty', '');
    expect(await s.get('empty')).toBe('');
    const big = 'x'.repeat(200_000);
    await s.set('big', big);
    expect(await s.get('big')).toBe(big);
  });

  it('distinct long keys do not collide after length-capping', async () => {
    const s = new FileVaultStore({ root, namespace: 'long' });
    const a = 'mls.state.' + 'a'.repeat(300);
    const b = 'mls.state.' + 'b'.repeat(300);
    await s.set(a, 'A');
    await s.set(b, 'B');
    expect(await s.get(a)).toBe('A');
    expect(await s.get(b)).toBe('B');
  });
});

describe('createKeyStore factory', () => {
  it('defaults to the file vault and honours the root override', async () => {
    const s = await createKeyStore({ root, namespace: 'topic-z' });
    await s.set('k', 'v');
    // Root points at the `.openstoa` dir; the vault lives under `<root>/vault`.
    expect(await fs.readFile(path.join(root, 'vault', 'topic-z', 'k'), 'utf8')).toBe('v');
  });

  it("keychain backend falls back to the vault when keytar is unavailable (non-strict)", async () => {
    const s = await createKeyStore({ backend: 'keychain', root });
    await s.set('k', 'v');
    expect(await s.get('k')).toBe('v');
  });

  it('createFileVaultStore is a sync vault-only factory', async () => {
    const s = createFileVaultStore({ root, namespace: 'sync-ns' });
    await s.set('k', 'v2');
    expect(await s.get('k')).toBe('v2');
  });
});
