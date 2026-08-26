/*
 * The recovery code is offered when it is needed, and stops being offered when
 * it is not.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. `master_key` is generated on the phone and
 * never leaves it. Everything sealed under it — group state, archive keys, the
 * cached plaintexts — is unreadable to anyone without that key, including its
 * owner on their next phone. The recovery code is the only copy that exists off
 * the device, and the only moment somebody is certain to still HAVE the device
 * is the moment they first sign in.
 *
 * THE MISREADING THIS GUARDS AGAINST. "Make it early and it goes stale" is the
 * intuitive worry and it is wrong: the code wraps `master_key`, which does not
 * change, so a code written down on day one opens a backup made on day ninety.
 * What the takeover screen warns about — "anything after its last backup is not
 * in it" — is the TAK UPLOAD lagging, not the code ageing. A future change that
 * starts re-issuing codes "because they are old" would be solving a problem that
 * does not exist while creating one that does.
 *
 * THE AXIS IS REPETITION, as with everything else found today. One launch cannot
 * tell "asked once" from "asks every time", and a prompt that reappears on every
 * cold start is one people learn to dismiss without reading — which is the same
 * outcome as never asking.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   repetition (THE guard) → 20 launches with a backup on file ask zero times
 *   contract   → a first run with no backup asks
 *   integrity  → an account WITH a wrap is never asked, first run or not
 *   integrity  → a passkey counts as a backup
 *   integrity  → losing the local mark does not make a backed-up account ask
 *   boundary   → no backup and not a first run STILL asks
 *   race       → showing twice in one launch is suppressed by the mark
 *   external   → a store that throws errs towards asking, never towards silence
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recoveryPrompt,
  markRecoveryShown,
  markRecoveryStored,
  RECOVERY_SHOWN_KEY,
  type LocalFlagStore,
  type BackupState,
} from '../lib/firstRunRecovery';

function store(): LocalFlagStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
  };
}

function brokenStore(): LocalFlagStore {
  return {
    getItem: async () => {
      throw new Error('store unavailable');
    },
    setItem: async () => {
      throw new Error('store unavailable');
    },
  };
}

const NO_BACKUP: BackupState = { hasRecoveryWrap: false, hasPasskey: false };
const HAS_CODE: BackupState = { hasRecoveryWrap: true, hasPasskey: false };
const HAS_PASSKEY: BackupState = { hasRecoveryWrap: false, hasPasskey: true };

let s: ReturnType<typeof store>;
beforeEach(() => {
  s = store();
});

describe('offering the recovery code', () => {
  it('CONTRACT: a first run with no backup is asked', async () => {
    const p = await recoveryPrompt(s, NO_BACKUP, { isFirstRun: true });
    expect(p).toEqual({ kind: 'show', reason: 'first-run' });
  });

  it('REPETITION: 20 launches with a backup on file ask zero times', async () => {
    /*
     * THE guard. A prompt that returns every cold start is one people dismiss
     * without reading, which is the same outcome as never asking at all.
     */
    const asked: string[] = [];

    for (let i = 0; i < 20; i++) {
      const p = await recoveryPrompt(s, HAS_CODE, { isFirstRun: i === 0 });
      if (p.kind === 'show') asked.push(p.reason);
    }

    expect(asked).toEqual([]);
  });

  it('INTEGRITY: an account with a wrap is never asked, even on a first run', async () => {
    // First run is about the DEVICE; the backup is about the ACCOUNT. A new
    // phone for an account that already has a code does not need a second one.
    const p = await recoveryPrompt(s, HAS_CODE, { isFirstRun: true });
    expect(p.kind).toBe('none');
  });

  it('INTEGRITY: a passkey counts as a backup', async () => {
    const p = await recoveryPrompt(s, HAS_PASSKEY, { isFirstRun: true });
    expect(p.kind).toBe('none');
  });

  it('BOUNDARY: no backup and not a first run still asks', async () => {
    /*
     * The account that dismissed it once, or whose backup was removed. Not
     * asking again leaves them one lost phone away from losing every room they
     * are in, silently.
     */
    const p = await recoveryPrompt(s, NO_BACKUP, { isFirstRun: false });
    expect(p).toEqual({ kind: 'show', reason: 'no-backup' });
  });

  it('RACE: within one launch the mark suppresses a second sheet', async () => {
    await markRecoveryShown(s);

    const p = await recoveryPrompt(s, NO_BACKUP, { isFirstRun: false });

    expect(p.kind).toBe('none');
  });

  it('INTEGRITY: the mark does not override a first run', async () => {
    /*
     * A first run has nothing on file by definition, so a leftover mark from
     * some earlier install must not swallow the one prompt that matters.
     */
    await markRecoveryShown(s);

    const p = await recoveryPrompt(s, NO_BACKUP, { isFirstRun: true });

    expect(p.kind).toBe('show');
  });

  it('CONTRACT: "shown" and "stored" are distinguishable', async () => {
    // A dismissed sheet must not look like a completed one — otherwise the next
    // launch believes the person wrote something down that they never saw.
    await markRecoveryShown(s);
    expect(s.data.get(RECOVERY_SHOWN_KEY)).toBe('pending');

    await markRecoveryStored(s);
    expect(s.data.get(RECOVERY_SHOWN_KEY)).toBe('stored');
  });

  it('EXTERNAL: a store that throws errs towards asking', async () => {
    /*
     * Direction matters. Asking twice costs a dismissed sheet; not asking costs
     * everything the account cannot get back.
     */
    const p = await recoveryPrompt(brokenStore(), NO_BACKUP, { isFirstRun: false });
    expect(p.kind).toBe('show');
  });

  it('EXTERNAL: a throwing store still never asks an account that has a backup', async () => {
    // The failure must not flip the other way either: a broken flag store is
    // not a reason to nag somebody who is already covered.
    const p = await recoveryPrompt(brokenStore(), HAS_CODE, { isFirstRun: false });
    expect(p.kind).toBe('none');
  });

  it('REPETITION: a backup appearing mid-life stops the asking', async () => {
    // The person completes it on launch three; four through twenty are quiet.
    const asked: number[] = [];

    for (let i = 0; i < 20; i++) {
      const backups = i < 3 ? NO_BACKUP : HAS_CODE;
      const p = await recoveryPrompt(store(), backups, { isFirstRun: i === 0 });
      if (p.kind === 'show') asked.push(i);
    }

    expect(asked).toEqual([0, 1, 2]);
  });
});
