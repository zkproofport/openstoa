/**
 * What a member's MLS leaf says about who owns it.
 *
 * A leaf's basic credential used to carry a bare device id — `web-<uuid>` —
 * which is unlinkable to an account by design and turned out to be unlinkable
 * to an account in the one place it needed to be linked: removal. An admin
 * kicking a member could not tell which leaves were theirs, so nobody built the
 * Remove Commit, so the epoch never advanced, so per-epoch keys — the entire
 * reason `private` and `secret` are not the simpler tier — bought nothing.
 *
 * The identity now names both: `<userId>:<deviceId>`. Any member can read the
 * ratchet tree and find every leaf belonging to an account, which is what makes
 * removal complete rather than best-effort. The server is not consulted, so the
 * mapping cannot go stale the way a join-time snapshot would: a device added
 * after the fact is in the tree, and the tree is what is being read.
 *
 * What this discloses to other members: how many devices an account has in this
 * topic. They already know who the members are, so the addition is small — and
 * it is paid to make "you are removed" true rather than nominal.
 *
 * THREE copies exist — `src/lib/mls/leafIdentity.ts` (web),
 * `packages/mobile/src/crypto/leafIdentity.ts` (mini-app) and
 * `packages/sdk/src/mls/leafIdentity.ts` (agent SDK) — and a test asserts they
 * stay BYTE-IDENTICAL, so keep this file dependency-free.
 *
 * The SDK copy is why the count changed. Its leaf was a bare `sdk-<uuid>`, so
 * `userIdOfLeaf` refused to attribute it and an admin removing an AI member
 * deleted the membership row while the agent's leaf kept deriving every future
 * epoch key. Binding the rule was the fix; see #71 for the agents that had
 * already joined and cannot be renamed.
 */

/**
 * Separator between the two parts.
 *
 * A colon cannot appear in a nullifier (hex with an `0x` prefix), so the FIRST
 * colon always ends the user id however odd the device id is.
 */
const SEP = ':';

/** The credential identity for one device of one account. */
export function leafIdentity(userId: string, deviceId: string): string {
  return `${userId}${SEP}${deviceId}`;
}

/**
 * The account that owns a leaf, or null when the identity predates this format.
 *
 * Returning null rather than guessing matters: a legacy `web-<uuid>` leaf
 * belongs to SOMEBODY, and treating it as belonging to whoever is being removed
 * would evict an innocent member; treating it as belonging to nobody merely
 * leaves it in place. Neither is good, and only one is safe.
 */
export function userIdOfLeaf(identity: string): string | null {
  const i = identity.indexOf(SEP);
  if (i <= 0 || i === identity.length - 1) return null;
  return identity.slice(0, i);
}

/** The device part, or null for a legacy identity. */
export function deviceIdOfLeaf(identity: string): string | null {
  const i = identity.indexOf(SEP);
  if (i <= 0 || i === identity.length - 1) return null;
  return identity.slice(i + 1);
}

/** Whether this leaf belongs to `userId`. False for anything unparseable. */
export function leafBelongsTo(identity: string, userId: string): boolean {
  return userIdOfLeaf(identity) === userId;
}
