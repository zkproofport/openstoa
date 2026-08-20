/**
 * Events addressed to a PERSON rather than to a room.
 *
 * The chat stream is per topic and only exists while that room is open, which
 * makes it useless for the one thing scoped-tier chat depends on: telling a
 * device that holds keys that another device needs them. The holder is, almost
 * by definition, not in the room — that is why the newcomer is stuck.
 *
 * So this is a second, account-wide channel. A client subscribes once while the
 * app is open and receives anything meant for that account, whichever topic it
 * concerns.
 *
 * Nothing secret travels here. The payload names a topic and says "someone in
 * it may be waiting for keys"; the keys themselves go the way they always have,
 * sealed to a recipient leaf and posted to the bundle mailbox, which the server
 * cannot open. This channel only decides WHEN a holder tries — the reason a
 * newcomer used to wait for a member to happen to reopen the chat.
 */
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';

const MODULE = 'userEvents';

/** Redis pub/sub channel for one account. */
export function userChannel(userId: string): string {
  return `user:events:${userId}`;
}

/**
 * Which of an account's DEVICES currently hold a stream.
 *
 * A hash rather than one key per device, for two reasons: it can be enumerated
 * without SCAN, and the whole account's presence expires as one object when the
 * last stream stops beating. Field = the device's routing handle, value = when
 * that field stops counting.
 */
function presenceKey(userId: string): string {
  return `user:sse:${userId}`;
}

/**
 * How long a device's presence outlives its last refresh.
 *
 * Longer than the stream's 30-second heartbeat so an ordinary slow tick does
 * not read as a disconnect, short enough that a device which vanished without
 * closing cleanly — the phone that went into a tunnel — stops being treated as
 * reachable within a minute or two.
 */
export const SSE_PRESENCE_TTL_SECONDS = 90;

/**
 * Mark one DEVICE of this account as holding a stream, and keep it marked.
 *
 * `handle` is the device's push routing handle where it has one. That is what
 * makes the two halves line up: push targets are devices addressed by handle,
 * so presence has to be recorded against the same name or the fan-out cannot
 * tell which device is already listening. A client with no handle — the web,
 * which has no push at all — passes its own connection id, which will never
 * match a push target and therefore never suppresses one.
 */
export async function markUserStreamOpen(userId: string, handle: string): Promise<void> {
  const redis = getRedis();
  const key = presenceKey(userId);
  await redis.hset(key, handle, String(Date.now() + SSE_PRESENCE_TTL_SECONDS * 1000));
  // Whole-object TTL as the backstop for a process that dies without cleanup;
  // refreshed on every heartbeat, so a live account never loses it.
  await redis.expire(key, SSE_PRESENCE_TTL_SECONDS * 2);
}

/** Drop one device's marker when its stream closes, rather than waiting it out. */
export async function markUserStreamClosed(userId: string, handle: string): Promise<void> {
  await getRedis().hdel(presenceKey(userId), handle);
}

/**
 * The devices of this account with a live stream right now.
 *
 * Expired fields are filtered on read rather than swept: a device that stopped
 * beating must stop counting immediately, and nothing else needs to run for
 * that to be true.
 */
export async function streamingHandles(userId: string): Promise<Set<string>> {
  const raw = await getRedis().hgetall(presenceKey(userId));
  const now = Date.now();
  const out = new Set<string>();
  for (const [handle, expiresAt] of Object.entries(raw ?? {})) {
    if (Number(expiresAt) > now) out.add(handle);
  }
  return out;
}

/** Events this channel carries. Add to the union, not to a magic string. */
export type UserEvent = {
  /**
   * A device in `topicId` may be missing chat keys.
   *
   * Advisory: a recipient that holds nothing simply does nothing, and a
   * recipient that has already granted this leaf skips it. So a broadcast to
   * every member is cheap and needs no reasoning about who the holder is —
   * which the server could not do anyway, since it cannot see the ratchet tree.
   */
  event: 'key-needed';
  data: { topicId: string; epoch: number };
};

/**
 * Tell these accounts that a topic may need keys handed out.
 *
 * BOTH routes run, and the split is per DEVICE rather than per account. An
 * earlier version chose one or the other by whether the account had any stream
 * at all, and that is wrong in the case that matters most: the browser is open
 * and the phone — which is the device actually holding the keys — is asleep.
 * The account looked reachable, no push went out, and the grant never happened.
 *
 * So: publish to the account channel unconditionally (a channel nobody is
 * listening to costs one no-op), and wake exactly the devices that have no
 * stream of their own. A device already listening is never also pushed, so
 * nobody sees a notification for something their app is handling.
 *
 * Best-effort by construction: this runs after a commit that has already been
 * accepted, and a failure here must never turn an accepted commit into an
 * error. The room's own retry remains the safety net for anyone offline.
 */
export async function publishKeyNeeded(
  userIds: readonly string[],
  topicId: string,
  epoch: number,
  /**
   * Wakes devices with no stream, given the handles that DO have one per
   * account. Optional so a caller with no push configured, and every test, can
   * leave it out — the SSE half must never depend on push being set up.
   */
  wakeSleepingDevices?: (perUser: Map<string, Set<string>>) => Promise<void>,
): Promise<void> {
  if (userIds.length === 0) return;
  const payload = JSON.stringify({ event: 'key-needed', data: { topicId, epoch } } satisfies UserEvent);
  try {
    const redis = getRedis();
    await Promise.all(userIds.map((id) => redis.publish(userChannel(id), payload)));

    if (!wakeSleepingDevices) return;
    const perUser = new Map<string, Set<string>>();
    await Promise.all(
      userIds.map(async (id) => {
        perUser.set(id, await streamingHandles(id));
      }),
    );
    await wakeSleepingDevices(perUser);
  } catch (e) {
    logger.warn(MODULE, 'key-needed fan-out failed; the room retry still covers it', {
      topicId,
      epoch,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
