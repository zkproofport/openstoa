/**
 * What a second device is told before it takes over.
 *
 * THE SITUATION THIS DECIDES. One account, one device — so signing in here ends
 * the session on the other one. That part is a nuisance. The part that cannot
 * be undone is the chat keys: they are on the other device and do not travel
 * with an account. Without a backup, every private and secret room it joined
 * becomes unreadable, on BOTH devices, permanently.
 *
 * And the only machine that can still make that backup is the OLD one, which is
 * signed in AT THIS MOMENT and will not be a few seconds from now. So the
 * warning has to carry the server's real answer about whether a backup exists —
 * not a generic "did you remember to back up?", which asks someone to recall
 * something they have no way to check from the phone in their hand.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → no backup → blocked; stale → warned; fresh → ready
 *   boundary   → exactly at the staleness threshold, one ms either side
 *   hostile    → a backup timestamp in the FUTURE (clock skew) must not read as
 *                fresh; NaN and Infinity likewise
 *   empty      → hasBackup true but no timestamp; an empty device list
 *   integrity  → a restore is always announced when a backup exists, because
 *                signing in does not carry keys across
 *   integrity  → "blocked" never actually blocks — someone who has already
 *                wiped the old phone must still be able to reach their account
 *   authz/UTF-8/large/race → N/A: this module is a pure decision over three
 *                numbers; the network call and the screen are elsewhere
 */
import { describe, it, expect } from 'vitest';
import {
  takeoverNotice,
  BACKUP_STALE_AFTER_MS,
  type DeviceConflict,
} from '../lib/deviceTakeover';

const NOW = 1_800_000_000_000;

function conflict(over: Partial<DeviceConflict> = {}): DeviceConflict {
  return {
    existingDevices: [{ kind: 'mobile', issuedAt: NOW - 86_400_000 }],
    hasBackup: true,
    backupUpdatedAt: NOW - 1000,
    ...over,
  };
}

describe('no backup at all', () => {
  it('CONTRACT: blocked, and no restore is promised', () => {
    const n = takeoverNotice(conflict({ hasBackup: false, backupUpdatedAt: null }), NOW);
    expect(n.severity).toBe('blocked');
    expect(n.needsRestoreHere).toBe(false);
    expect(n.titleKey).toBe('openstoa.takeover.noBackup.title');
  });

  it('INTEGRITY: blocked does NOT mean refused', () => {
    // Someone may have already wiped the old phone, or may not care about the
    // rooms. Refusing outright would strand them out of their own account to
    // protect data they have decided to lose. The screen makes "back up first"
    // the emphasised action; continuing stays possible.
    expect(takeoverNotice(conflict({ hasBackup: false, backupUpdatedAt: null }), NOW).canProceed).toBe(
      true,
    );
  });

  it('EMPTY: hasBackup true but no timestamp is treated as no backup', () => {
    // A row that exists with no date tells us nothing about what is in it.
    const n = takeoverNotice(conflict({ hasBackup: true, backupUpdatedAt: null }), NOW);
    expect(n.severity).toBe('blocked');
  });
});

describe('a backup exists', () => {
  it('CONTRACT: a recent one is "ready", and still announces the restore', () => {
    // The restore is the part people get wrong: they sign in, see empty rooms,
    // and conclude the app lost their messages.
    const n = takeoverNotice(conflict({ backupUpdatedAt: NOW - 60_000 }), NOW);
    expect(n.severity).toBe('ready');
    expect(n.needsRestoreHere).toBe(true);
  });

  it('CONTRACT: an old one is "stale" and says how old', () => {
    const fortyDays = 40 * 24 * 60 * 60 * 1000;
    const n = takeoverNotice(conflict({ backupUpdatedAt: NOW - fortyDays }), NOW);
    expect(n.severity).toBe('stale');
    expect(n.bodyValues.days).toBe(40);
    expect(n.needsRestoreHere).toBe(true);
  });

  it('BOUNDARY: exactly at the threshold is still fresh; one ms past is stale', () => {
    expect(takeoverNotice(conflict({ backupUpdatedAt: NOW - BACKUP_STALE_AFTER_MS }), NOW).severity).toBe(
      'ready',
    );
    expect(
      takeoverNotice(conflict({ backupUpdatedAt: NOW - BACKUP_STALE_AFTER_MS - 1 }), NOW).severity,
    ).toBe('stale');
  });

  it('BOUNDARY: made this instant', () => {
    expect(takeoverNotice(conflict({ backupUpdatedAt: NOW }), NOW).severity).toBe('ready');
  });
});

describe('HOSTILE: clocks that lie', () => {
  it('a backup dated in the FUTURE is stale, never fresh', () => {
    /*
     * The one answer that must never be given by mistake. A device with its
     * clock set wrong would otherwise compute a negative age and read as
     * freshly backed up — telling someone their keys are safe at the exact
     * moment they are about to lose them.
     */
    const n = takeoverNotice(conflict({ backupUpdatedAt: NOW + 86_400_000 }), NOW);
    expect(n.severity).toBe('stale');
    expect(n.bodyValues.days).toBe(0); // never a negative day count on screen
  });

  it('NaN and Infinity are stale, not fresh', () => {
    expect(takeoverNotice(conflict({ backupUpdatedAt: Number.NaN }), NOW).severity).toBe('stale');
    expect(takeoverNotice(conflict({ backupUpdatedAt: Number.POSITIVE_INFINITY }), NOW).severity).toBe(
      'stale',
    );
  });
});

describe('the other devices', () => {
  it('EMPTY: an empty list still produces a notice', () => {
    // The server would not normally send a conflict with no devices, but a
    // notice that throws here would break the sign-in it exists to explain.
    const n = takeoverNotice(conflict({ existingDevices: [] }), NOW);
    expect(n.bodyValues.devices).toBe(0);
  });

  it('HOSTILE: a malformed list counts as none rather than throwing', () => {
    const n = takeoverNotice(
      { ...conflict(), existingDevices: undefined as never },
      NOW,
    );
    expect(n.bodyValues.devices).toBe(0);
  });

  it('several devices are counted', () => {
    const n = takeoverNotice(
      conflict({
        existingDevices: [
          { kind: 'mobile', issuedAt: NOW },
          { kind: 'web', issuedAt: NOW },
        ],
      }),
      NOW,
    );
    expect(n.bodyValues.devices).toBe(2);
  });
});
