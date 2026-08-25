/**
 * What to tell someone signing in while another device is still signed in.
 *
 * THE SITUATION. One account, one device — so this sign-in ends the session on
 * the other one. That part is a nuisance. The part that is not recoverable is
 * the chat keys: they live on the device that holds them and do not travel with
 * an account. If the old device is signed out without a backup, every private
 * and secret room it joined becomes unreadable, on both devices, permanently.
 *
 * WHY THE WARNING HAS TO COME FIRST. The only machine that can still make a
 * backup is the OLD one, and it is signed in right now. Five seconds later it
 * is not, and there is nothing anyone can do. So this is asked before the
 * takeover, with the server's real answer about whether a backup exists —
 * not a generic "did you remember to back up?", which asks a person to recall
 * something they have no way to check from the phone in their hand.
 *
 * THREE OUTCOMES, and they are genuinely different:
 *   no backup      → stop. Go to the old device, Profile → back up keys, come
 *                    back. Continuing loses the rooms.
 *   stale backup   → warn. Rooms joined since that date are not in it.
 *   fresh backup   → proceed, and say plainly that the next step on THIS device
 *                    is restoring from it — otherwise the person signs in, sees
 *                    empty rooms, and concludes the app lost their messages.
 *
 * Pure and content-only: no navigation, no network, no React. The screen
 * decides how to show it; this decides what is true.
 */

/** What the server said when it refused the sign-in. */
export interface DeviceConflict {
  existingDevices: Array<{ kind: string; issuedAt: number }>;
  hasBackup: boolean;
  /** Epoch ms of the last backup, or null when there has never been one. */
  backupUpdatedAt: number | null;
}

export type TakeoverSeverity =
  /** Proceeding destroys keys. The primary action must not be "continue". */
  | 'blocked'
  /** A backup exists but predates rooms this account may have joined since. */
  | 'stale'
  /** A recent backup exists; continuing is fine, restoring is the next step. */
  | 'ready';

export interface TakeoverNotice {
  severity: TakeoverSeverity;
  /** i18n key for the headline. */
  titleKey: string;
  /** i18n key for the body. */
  bodyKey: string;
  /** Interpolation values for the body. */
  bodyValues: Record<string, string | number>;
  /**
   * Whether the new device will have to restore after signing in.
   *
   * Always true when a backup exists: signing in does not carry keys across, so
   * the restore is a step the person takes, not something that happens for
   * them. Saying so up front is the difference between "I have to restore" and
   * "the app lost my chats".
   */
  needsRestoreHere: boolean;
  /** Whether "continue" should be the emphasised action. */
  canProceed: boolean;
}

/**
 * How old a backup may be before it is called stale.
 *
 * Thirty days is not a security boundary — it is the point past which "I backed
 * up at some point" stops being evidence about the rooms someone is in now. A
 * shorter window would cry wolf at people who back up monthly; a longer one
 * would call a backup current when a whole season of rooms is missing from it.
 */
export const BACKUP_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Decide what to say.
 *
 * `now` is a parameter so the boundary is testable without touching the clock.
 */
export function takeoverNotice(conflict: DeviceConflict, now: number): TakeoverNotice {
  const others = Array.isArray(conflict.existingDevices) ? conflict.existingDevices.length : 0;

  if (!conflict.hasBackup || conflict.backupUpdatedAt === null) {
    return {
      severity: 'blocked',
      titleKey: 'openstoa.takeover.noBackup.title',
      bodyKey: 'openstoa.takeover.noBackup.body',
      bodyValues: { devices: others },
      needsRestoreHere: false,
      /*
       * NOT a hard block. The person may have already wiped the old phone, or
       * may not care about the rooms — refusing outright would strand them out
       * of their own account to protect data they have decided to lose. What it
       * does is stop being the easy path: the screen makes "back up first" the
       * emphasised action and continuing the deliberate one.
       */
      canProceed: true,
    };
  }

  /*
   * Guard the arithmetic, not just the value. A backup timestamp in the future
   * — clock skew, a device set wrong — would otherwise compute a negative age
   * and read as freshly made, which is the one answer that must never be given
   * by mistake. Treat anything not plausibly in the past as stale.
   */
  const age = now - conflict.backupUpdatedAt;
  const stale = !Number.isFinite(age) || age < 0 || age > BACKUP_STALE_AFTER_MS;

  if (stale) {
    return {
      severity: 'stale',
      titleKey: 'openstoa.takeover.staleBackup.title',
      bodyKey: 'openstoa.takeover.staleBackup.body',
      bodyValues: { days: Math.max(0, Math.floor(age / (24 * 60 * 60 * 1000))) },
      needsRestoreHere: true,
      canProceed: true,
    };
  }

  return {
    severity: 'ready',
    titleKey: 'openstoa.takeover.ready.title',
    bodyKey: 'openstoa.takeover.ready.body',
    bodyValues: { devices: others },
    needsRestoreHere: true,
    canProceed: true,
  };
}
