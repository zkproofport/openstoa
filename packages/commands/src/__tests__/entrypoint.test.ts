/**
 * Regression tests for the executable entry guard used by both bins
 * (`openstoa`, `openstoa-mcp`).
 *
 * npm installs package bins as symlinks, so argv[1] is the symlink path while
 * import.meta.url is the realpath. Comparing them raw made the guard false for
 * every global install — `openstoa --help` printed nothing and exited 0, and
 * `openstoa-mcp` never spoke on stdio. These tests fail if the realpath
 * resolution is removed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntrypoint } from '../entrypoint';

describe('isEntrypoint', () => {
  let dir: string;
  let real: string;
  let link: string;

  beforeEach(() => {
    // realpathSync: on macOS tmpdir() is /var/... which is itself a symlink to
    // /private/var/..., so the fixture must start from the resolved path — the
    // real import.meta.url is always a realpath (Node's ESM loader resolves it).
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'openstoa-entry-')));
    real = join(dir, 'cli.js');
    link = join(dir, 'openstoa');
    writeFileSync(real, '// bin\n');
    symlinkSync(real, link);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is true when argv[1] is a SYMLINK to the module (the npm bin case)', () => {
    expect(isEntrypoint(pathToFileURL(real).href, link)).toBe(true);
  });
  it('is true when argv[1] is the module path itself', () => {
    expect(isEntrypoint(pathToFileURL(real).href, real)).toBe(true);
  });
  it('is false when argv[1] is an unrelated file (module imported, e.g. by vitest)', () => {
    const other = join(dir, 'other.js');
    writeFileSync(other, '// other\n');
    expect(isEntrypoint(pathToFileURL(real).href, other)).toBe(false);
  });
  it('is false when argv[1] is undefined', () => {
    expect(isEntrypoint(pathToFileURL(real).href, undefined)).toBe(false);
  });
  it('does not throw when argv[1] does not exist on disk', () => {
    const missing = join(dir, 'gone.js');
    expect(() => isEntrypoint(pathToFileURL(real).href, missing)).not.toThrow();
    expect(isEntrypoint(pathToFileURL(missing).href, missing)).toBe(true);
  });
});
