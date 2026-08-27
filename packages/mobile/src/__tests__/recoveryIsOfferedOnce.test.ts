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
  resetRecoveryLaunchMark,
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
  // Each case is a fresh LAUNCH. The "already asked" latch is in memory now —
  // see `recoveryPrompt` — so it has to be cleared the way a process restart
  // clears it, or one case silences the next and the suite lies in the same
  // direction the defect did.
  resetRecoveryLaunchMark();
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

/*
 * ONE DISMISSAL MUST NOT SILENCE THE NEXT ACCOUNT — found on a device, 2026-08-27.
 *
 * Three sign-ins on one phone produced three accounts and only TWO recovery
 * keys. The third was never asked and started with no way back.
 *
 * The cause was scope. `markRecoveryShown` wrote `pending` to the STORE, and
 * `recoveryPrompt` read it back and returned `none` — so a single "Not now"
 * became a permanent mark on the install, and every account that signed in on
 * that phone afterwards was skipped in silence. The branch's own comment said
 * asking again was right; the code did the opposite.
 *
 * The suppression is now in memory and lasts one launch, which is the scope it
 * was always described as having. The stored mark survives and still chooses the
 * WORDING (`first-run` vs `no-backup`) — it just no longer decides whether to
 * ask.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   race        → two asks in one launch: the second is suppressed
 *   contract    → a NEW launch asks again after a dismissal
 *   integrity   → five accounts in a row are each asked (the cumulative axis)
 *   integrity   → a stored `pending` from an older build does not suppress
 *   boundary    → an unreadable store still asks
 */
describe('a dismissal is scoped to its launch, not to the phone', () => {
  it('RACE: two asks inside one launch — the second is suppressed', async () => {
    // The behaviour that IS wanted: a re-render must not stack a second sheet.
    resetRecoveryLaunchMark();
    const s1 = store();
    expect((await recoveryPrompt(s1, NO_BACKUP, { isFirstRun: false })).kind).toBe('show');
    await markRecoveryShown(s1);
    expect((await recoveryPrompt(s1, NO_BACKUP, { isFirstRun: false })).kind).toBe('none');
  });

  it('CONTRACT: a NEW launch asks again after a dismissal', async () => {
    /*
     * "Not now" leaves `pending` in the store on purpose — it records that this
     * install has been through it. What it must not do is answer the next
     * launch's question.
     */
    const s1 = store();
    resetRecoveryLaunchMark();
    await markRecoveryShown(s1);
    expect(s1.data.get(RECOVERY_SHOWN_KEY)).toBe('pending');

    resetRecoveryLaunchMark(); // the process restarted
    expect((await recoveryPrompt(s1, NO_BACKUP, { isFirstRun: false })).kind).toBe('show');
  });

  it('INTEGRITY: five accounts in a row on one phone are EACH asked', async () => {
    /*
     * The cumulative axis, and the shape the device actually produced. A single
     * account passing proves the branch runs once; it says nothing about the
     * second person to use the phone — or, as here, the same person signing in
     * again after a logout, which mints a new account.
     *
     * The store is shared across all five because it is one install.
     */
    const shared = store();
    const asked: number[] = [];

    for (let account = 0; account < 5; account++) {
      resetRecoveryLaunchMark(); // each sign-in is its own launch of the flow
      const p = await recoveryPrompt(shared, NO_BACKUP, { isFirstRun: false });
      if (p.kind === 'show') asked.push(account);
      // Every one of them dismisses rather than storing — the worst case.
      await markRecoveryShown(shared);
    }

    expect(asked).toEqual([0, 1, 2, 3, 4]);
  });

  it('INTEGRITY: a stored `pending` left by an older build does not suppress', async () => {
    // Phones in the field already carry this value. The fix must not depend on
    // it being absent.
    const s1 = store();
    await s1.setItem(RECOVERY_SHOWN_KEY, 'pending');
    resetRecoveryLaunchMark();

    expect((await recoveryPrompt(s1, NO_BACKUP, { isFirstRun: false })).kind).toBe('show');
  });

  it('BOUNDARY: an unreadable store still asks', async () => {
    resetRecoveryLaunchMark();
    const broken: LocalFlagStore = {
      getItem: async () => {
        throw new Error('keystore unavailable');
      },
      setItem: async () => {},
    };
    expect((await recoveryPrompt(broken, NO_BACKUP, { isFirstRun: false })).kind).toBe('show');
  });

  it('CONTRACT: an account WITH a backup is still never asked', async () => {
    // The fix widens who gets asked; it must not start pestering accounts that
    // already have a key on file.
    resetRecoveryLaunchMark();
    const s1 = store();
    const withWrap = { hasRecoveryWrap: true, hasPasskey: false };
    for (let i = 0; i < 5; i++) {
      expect((await recoveryPrompt(s1, withWrap, { isFirstRun: false })).kind).toBe('none');
    }
  });
});
