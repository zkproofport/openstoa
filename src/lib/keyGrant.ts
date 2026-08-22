/**
 * Handing a topic's chat keys to the devices that are missing them — web half.
 *
 * Twin of `packages/mobile/src/crypto/keyGrant.ts` in intent, not in code: the
 * two clients reach their key stores differently (the mini-app is handed a
 * client and a host, the browser has module singletons), so a byte-identical
 * copy is not possible here. The RULE they must agree on lives in
 * `chatTierPolicy`, and the branch below is the same one the chat surfaces
 * apply on entry.
 *
 * On the scoped tiers the server holds no key, so a newcomer can only be
 * unlocked by a device that already has one — and that device is almost never
 * in the room. Until now this only ran when a chat was on screen, which is why
 * a private topic's second device stayed sealed until somebody happened to
 * reopen that exact conversation.
 */
import { apiFetch } from '@/lib/apiFetch';
import { getTakSessionStore } from '@/lib/mls/webTransport';

interface TopicShape {
  topic?: { visibility?: string; kind?: string } | null;
  currentUserRole?: string | null;
}

/**
 * Give what this browser holds for `topicId`, following the tier's own rule.
 *
 *   public  — publish the shared archive root, which the server may hold.
 *   private — grant the epochs this member holds to every member leaf.
 *   secret  — the owner alone grants; a member handing out a hidden room's
 *             history is the thing that tier exists to prevent.
 *   dm      — nothing to do: both parties were there from the start.
 *
 * Silent by design: it runs off a broadcast sent to every member, so most calls
 * are expected to find nothing to send.
 */
export async function grantRoomKeys(topicId: string): Promise<void> {
  const res = await apiFetch(`/api/topics/${topicId}`, { credentials: 'include' });
  if (!res.ok) return; // not a member any more, or gone — nothing to hand over
  const meta = (await res.json()) as TopicShape;
  const visibility = meta?.topic?.visibility;
  if (meta?.topic?.kind === 'dm') return;

  const tak = getTakSessionStore();
  if (visibility === 'public') {
    await tak.distributePublicRootWhenGroupChanged(topicId);
    return;
  }
  if (visibility === 'private') {
    await tak.grantPrivateHistory(topicId);
    return;
  }
  if (visibility === 'secret' && meta?.currentUserRole === 'owner') {
    await tak.grantPrivateHistory(topicId);
  }
}
