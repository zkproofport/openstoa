/**
 * One refused read must not be reported as a failed recovery.
 *
 * WHAT HAPPENED, on a phone 2026-08-27. Recovery installs the master key first
 * — the step that cannot be repeated, because the code is shown once — and then
 * reads the account's chat-key snapshot. That read was refused once (the edge
 * was rate-limiting the app), the throw travelled to the screen, and the person
 * was told their recovery had failed. It had not: the durable half was already
 * done, and the half that failed is retried on its own at the next launch.
 *
 * Telling someone a one-shot action failed when it succeeded is the expensive
 * kind of wrong: they go looking for their code again.
 *
 * These read the source rather than run the flow, because running it needs the
 * whole crypto stack; what is being pinned is the SHAPE — install first, then a
 * read whose failure cannot escape.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..');
const TRANSPORT = fs.readFileSync(path.join(SRC, 'crypto/mobileTransport.ts'), 'utf8');
const SCREEN = fs.readFileSync(path.join(SRC, 'screens/profile/AccountRecoveryScreen.tsx'), 'utf8');
const KO = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n/locales/ko.json'), 'utf8')) as {
  openstoa: { recovery: Record<string, string> };
};

/** The body of `recoverDevice`, up to the next top-level declaration. */
function recoverBody(): string {
  const from = TRANSPORT.indexOf('export async function recoverDevice');
  expect(from).toBeGreaterThan(-1);
  const rest = TRANSPORT.slice(from);
  const end = rest.indexOf('\n}\n');
  return rest.slice(0, end);
}

describe('a refused read does not undo a recovery', () => {
  it('THE DEFECT: the chat-key read is wrapped, so its failure cannot escape', () => {
    const body = recoverBody();
    const read = body.indexOf('restoreTakKeychain');
    const guard = body.indexOf('try {');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(read); // the try opens BEFORE the read
  });

  it('CONTRACT: the master key is installed BEFORE anything that can fail', () => {
    const body = recoverBody();
    expect(body.indexOf('installMasterKey')).toBeLessThan(body.indexOf('restoreTakKeychain'));
  });

  it('CONTRACT: a refused read still tells the rooms to re-render', () => {
    // Without this the app holds a recovered key that no open room ever notices.
    const body = recoverBody();
    const afterCatch = body.slice(body.indexOf('catch'));
    expect(afterCatch).toContain('bumpCryptoGeneration');
  });

  it('CONTRACT: a refused read returns a value rather than throwing', () => {
    const body = recoverBody();
    const afterCatch = body.slice(body.indexOf('catch'));
    expect(afterCatch).toContain("return 'keys-pending'");
    expect(afterCatch).not.toContain('throw');
  });

  it('the screen says something different when the keys have not arrived', () => {
    expect(SCREEN).toContain("outcome === 'keys-pending'");
    expect(SCREEN).toContain('openstoa.recovery.keysPending');
  });

  it('that sentence is Korean and does NOT ask the person to recover again', () => {
    const s = KO.openstoa.recovery.keysPending;
    expect(s).toBeTruthy();
    expect(s).toMatch(/[가-힣]/);
    expect(s).not.toMatch(/[A-Za-z]{4,}/);
    // The whole point: it must not send them back for their code.
    expect(s).toContain('다시 복구하지 않아도');
  });
});
