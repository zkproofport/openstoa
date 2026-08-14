import type { OpenStoaClient } from '../../api/openstoaClient';
import type { MlsSessionStore } from '../../crypto/mlsSession';

/**
 * Evict the kicked account's MLS leaves right after a server-side kick
 * (TopicMembersScreen's `DELETE /api/topics/{topicId}/members`), and report
 * how many of its devices the sweep could NOT remove.
 *
 * Mirrors the web member page's `handleKick`
 * (src/app/topics/[topicId]/members/page.tsx): the DB row already gates the
 * REST API the instant the kick succeeds, but the MLS ratchet tree only
 * catches up when some client commits a Remove. Waiting for the next chat
 * open (ChatRoomScreen's own silent `reconcileMembership` call) would leave
 * the kicked account's devices deriving every future epoch key in the
 * meantime — best closed from the admin's own client, right now.
 *
 * Best-effort on the SWEEP: a network failure, a lost epoch-CAS race, or the
 * admin backgrounding the app mid-kick all resolve to "the next member's
 * client reconciles instead" — never a thrown error the caller must handle.
 *
 * Not best-effort on the RESULT: `reconcileMembership` returns
 * `unattributable`, the count of leaves it refused to evict because their
 * credential predates `<userId>:<deviceId>` and cannot be safely attributed
 * to the kicked account (see leafIdentity.ts). This is exactly what used to
 * happen, silently, to an SDK-based AI member before its leaf identity was
 * bound: the membership row was deleted while the agent's device kept
 * deriving every epoch key, and the admin was told nothing. Swallowing this
 * count here would quietly reintroduce that gap for any credential format
 * the binding does not yet cover — so a genuinely partial removal is always
 * reported back to the caller, never merged into the silent-failure path.
 *
 * Extracted from TopicMembersScreen so it can be unit-tested directly: the
 * screen's kick action is reached through a native ActionSheetIOS/Alert
 * confirm chain the test harness's thin RN stand-in does not simulate
 * (`packages/mobile/src/__tests__/harness/reactNative.tsx`'s `Alert.alert`
 * records only title/message, not the `buttons` callbacks) — this function
 * is what actually needs the coverage, not the confirm dialog around it.
 */
export async function reconcileAfterKick(
  client: OpenStoaClient,
  mls: MlsSessionStore,
  topicId: string,
): Promise<number> {
  try {
    const fresh = await client.get<{ members: Array<{ userId: string }> }>(
      `/api/topics/${topicId}/members`,
    );
    const remaining = (fresh.members ?? []).map((m) => m.userId);
    // Nothing to reconcile against is the common case right after the last
    // non-owner member is kicked from a topic; sweeping an EMPTY list would
    // read as "evict everyone still in the tree" to reconcileMembership, so
    // it is refused here rather than passed through.
    if (remaining.length === 0) return 0;
    const { unattributable } = await mls.reconcileMembership(topicId, remaining);
    return unattributable;
  } catch {
    // A failed sweep is not a false assurance — the tree is untouched and the
    // next member to open the room reconciles instead.
    return 0;
  }
}
