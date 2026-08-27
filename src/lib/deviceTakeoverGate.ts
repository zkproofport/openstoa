/**
 * The one-device rule, in one place, for every path a HUMAN signs in through.
 *
 * WHY IT IS SHARED. It was written inline in the proof-login poll route, which
 * meant `dev-login` — the other way a person gets a session — silently had no
 * rule at all. A rule that one of two doors enforces is not a rule; it is a
 * property of that door. Every human login path calls this, and a third one
 * added later fails to compile without it rather than quietly opting out.
 *
 * WHAT IT DECIDES. A person's chat keys live on the phone that holds them and
 * do not travel with the account, so a second signed-in phone is not "two
 * phones" but "one that works and one that half does". Signing in on a new
 * phone ends the session on the old one.
 *
 * WHAT IT DELIBERATELY DOES NOT DO IS TAKE OVER SILENTLY. The first attempt
 * REFUSES and names what it found, because the only machine that can still back
 * up those keys is the one signed in AT THAT MOMENT — a few seconds later it is
 * not, and nothing can be done. So the client shows the warning, and a
 * confirmed attempt comes back with `takeover: true`.
 *
 * NOT web, NOT agents. A browser cannot read a room (the middleware refuses
 * chat to a web session and the keys were never there), so counting it would
 * end someone's phone session over a laptop that holds nothing. An agent runs
 * on a server its owner controls and authenticates with an API key; counting it
 * would make a human unable to sign in anywhere while their bot is running.
 * See `liveDeviceSessions`.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { deviceSigningKeys } from '@/lib/db/schema';
import { getTakBackup } from '@/lib/keyBackupStore';
import {
  liveDeviceSessions,
  revokeDeviceSessions,
  revokeSession,
  type DeviceKind,
} from '@/lib/sessionStore';
import { logger } from '@/lib/logger';

const MODULE = 'deviceTakeoverGate';

/** What the client is told when the sign-in is refused. */
export interface DeviceConflictBody {
  status: 'device_conflict';
  /**
   * Enough to recognise the device, and nothing more.
   *
   * The device ID itself is NOT returned: it is what the other device proves
   * itself with, so an endpoint that hands it out turns a warning into a way to
   * impersonate the device being warned about.
   */
  existingDevices: Array<{ kind: DeviceKind; issuedAt: number }>;
  /** True when a restorable keychain backup is on the server. */
  hasBackup: boolean;
  /**
   * Epoch ms of the last backup, or null when there has never been one.
   *
   * Returned because "you have a backup" and "you have a backup from before you
   * joined any of these rooms" are different answers, and only the second one
   * tells someone their keys are about to be lost.
   */
  backupUpdatedAt: number | null;
}

export type TakeoverDecision =
  /** Nothing in the way — mint the session. */
  | { kind: 'allow' }
  /** Another phone holds this account and the person has not been asked yet. */
  | { kind: 'conflict'; body: DeviceConflictBody };

export interface TakeoverCheck {
  userId: string;
  /** The kind this login path is minting. Only `mobile` is subject to the rule. */
  deviceKind: DeviceKind;
  /** This install's id, so "the same phone again" is not treated as a second one. */
  deviceId: string;
  /**
   * This device's registered signing key, when it has one.
   *
   * WHY A SECOND ANSWER TO "IS THIS THE SAME PHONE". `deviceId` is a string the
   * client generates and keeps; lose it — a store that cannot be read, a
   * reinstall on Android — and the phone arrives under a new one. The gate then
   * files its OWN previous session under `others` and tells the person they are
   * about to sign out another phone, naming a device that does not exist and
   * warning that the chat keys went with it. Seen on 2026-08-26: the account had
   * accumulated sessions this way and the prompt fired on every sign-in.
   *
   * A key answers the same question without being lose-able in that way: two
   * ids that map to one registered public key are one device. Absent (a first
   * sign-in, or a client that has not registered yet) the id is all there is,
   * which is the previous behaviour rather than a downgrade.
   */
  devicePublicKey?: string;
  /** True only when the person has seen the warning and chose to continue. */
  takeover: boolean;
}

/**
 * Decide, and — on a confirmed takeover — actually end the old sessions.
 *
 * Returning `allow` means the caller may mint. The revocation happens HERE
 * rather than in the caller so the two can never drift apart: a caller that
 * remembered the check but forgot the revoke would leave the account with two
 * live phones and no warning the next time.
 */
/**
 * Every device id that this account has registered under the given public key,
 * plus the id being presented.
 *
 * The presented id is always included: a device that has not registered yet is
 * still itself, and excluding it would make a first sign-in look like a second
 * phone — the exact false alarm this function exists to remove.
 */
async function idsSharingKey(
  userId: string,
  deviceId: string,
  publicKey: string | undefined,
): Promise<Set<string>> {
  const ids = new Set<string>([deviceId]);
  if (!publicKey) return ids;

  try {
    const rows = await db.query.deviceSigningKeys.findMany({
      where: eq(deviceSigningKeys.userId, userId),
    });
    for (const r of rows) {
      if (r.publicKey === publicKey) ids.add(r.deviceId);
    }
  } catch (e) {
    /*
     * A lookup that fails must not turn one phone into two. Falling back to the
     * id alone is the previous behaviour: the prompt may appear when it should
     * not, which is a nuisance. The other direction — silently treating a real
     * second phone as this one — would skip a warning about losing chat keys.
     */
    logger.warn(MODULE, 'could not read device keys; falling back to the id alone', {
      userId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return ids;
}

export async function checkDeviceTakeover(check: TakeoverCheck): Promise<TakeoverDecision> {
  /*
   * Only a phone is subject to the rule, because only a phone holds the keys
   * whose loss the rule exists to prevent. A web or agent login never conflicts
   * and never displaces anything.
   */
  if (check.deviceKind !== 'mobile') return { kind: 'allow' };

  const live = await liveDeviceSessions(check.userId);

  /*
   * Which ids belong to THIS device, by key rather than by name.
   *
   * A device that has proved itself is recognised under every id it has ever
   * used, so an id that was lost and replaced no longer splits one phone into
   * two. Falls back to the id alone when there is no key to compare — a first
   * sign-in has nothing registered yet.
   */
  const sameDevice = await idsSharingKey(check.userId, check.deviceId, check.devicePublicKey);
  const isMine = (s: { deviceId?: string }) =>
    typeof s.deviceId === 'string' && sameDevice.has(s.deviceId);

  const mine = live.filter(isMine);
  const others = live.filter((s) => !isMine(s));

  /*
   * ONE SESSION PER DEVICE, not one per sign-in.
   *
   * Signing in again on the SAME phone used to leave the previous record live,
   * so three sign-ins produced three sessions. Nothing looked broken — until
   * the account is asked how many devices it has, which is the one question
   * this whole mechanism exists to answer. A genuinely-second phone was then
   * told "3 other devices" and the person had no way to make sense of that.
   *
   * Retiring the old record here rather than at mint time keeps the rule in
   * one place: a caller that remembered the check but not the cleanup is the
   * failure this module was extracted to remove the opportunity for.
   */
  for (const stale of mine) await revokeSession(stale.sessionId, check.userId);

  if (others.length === 0) return { kind: 'allow' };

  if (!check.takeover) {
    const backup = await getTakBackup(db, check.userId);
    logger.info(MODULE, 'Another device is signed in; asking before taking over', {
      userId: check.userId,
      others: others.length,
      hasBackup: backup !== null,
    });
    return {
      kind: 'conflict',
      body: {
        status: 'device_conflict',
        existingDevices: others.map((s) => ({ kind: s.deviceKind, issuedAt: s.issuedAt })),
        hasBackup: backup !== null,
        backupUpdatedAt: backup?.updatedAt?.getTime() ?? null,
      },
    };
  }

  const ended = await revokeDeviceSessions(check.userId);
  logger.info(MODULE, 'Takeover confirmed; previous sessions ended', {
    userId: check.userId,
    ended,
  });
  return { kind: 'allow' };
}
