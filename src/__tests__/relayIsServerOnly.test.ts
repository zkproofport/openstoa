/**
 * `@/lib/relay` records OIDC relay requests in Redis (./oidcRequestContext),
 * and holds the relay SDK with its ephemeral signer. None of that belongs in a
 * browser bundle. ProofGate used to import it for QR rendering; it now uses
 * the `qrcode` library directly. This keeps every client module off the
 * server-only modules.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SERVER_ONLY = ['@/lib/relay', '@/lib/oidcRequestContext', '@/lib/redis'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

it('no client module imports a server-only module', () => {
  const clientFiles = sources(ROOT).filter((file) => /^\s*['"]use client['"]/.test(readFileSync(file, 'utf8')));
  expect(clientFiles.length).toBeGreaterThan(0);
  const offenders = clientFiles.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return SERVER_ONLY.filter((mod) => text.includes(`'${mod}'`) || text.includes(`"${mod}"`))
      .map((mod) => `${relative(ROOT, file)} imports ${mod}`);
  });
  expect(offenders).toEqual([]);
});

it('ProofGate is a client module (so the check above covers it)', () => {
  expect(readFileSync(join(ROOT, 'components/ProofGate.tsx'), 'utf8')).toMatch(/^\s*['"]use client['"]/);
});
