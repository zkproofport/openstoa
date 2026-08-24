/**
 * Handing a topic's chat keys to the devices that are missing them.
 *
 * This used to live only inside `ChatRoomScreen`, which is why a private room's
 * second device stayed on "Encrypted — this device has no key for it" until
 * somebody happened to reopen that exact chat. The keys were never the problem:
 * they travel sealed to a recipient leaf through the bundle mailbox, and the
 * server cannot open them. The problem was that the one function which posts
 * them only ran when a room was on screen.
 *
 * So it moves here, where the account-wide event stream can call it for any
 * topic without opening anything. A device that holds nothing does nothing.
 */
import type { HostApi } from '@openstoa/miniapp-bridge';
import type { OpenStoaClient } from '../api/openstoaClient';
import { getTakSessionStore } from './mobileTransport';
import { chatTierOf, usesTopicRootKey } from '../lib/chatTierPolicy';

interface TopicShape {
  topic?: { visibility?: string; kind?: string } | null;
  currentUserRole?: string | null;
}

/**
 * Give what this device holds for `topicId`, following the tier's own rule.
 *
 * The same split the chat room applies on entry:
 *   public  — publish the shared archive root, which the server may hold.
 *   dm      — hand the conversation's root to the peer's leaves and to this
 *             account's other devices. The server may NOT hold this one, so
 *             this call is the only route it has.
 *   private — grant the epochs this member holds to every member leaf.
 *   secret  — the owner alone grants; a member handing out a hidden room's
 *             history is the thing that tier exists to prevent.
 *
 * `dm` used to return here immediately, on the reasoning that "both parties were
 * there from the start". Both ACCOUNTS were; their devices were not, and a
 * device is what holds a key. The early return meant a DM's key never left the
 * device that minted it.
 *
 * Silent by design. It runs off a broadcast that goes to every member, so most
 * calls are expected to find nothing worth sending, and a failure is covered by
 * the room's own retry.
 */
export async function grantRoomKeys(
  client: OpenStoaClient,
  host: HostApi,
  topicId: string,
): Promise<void> {
  const tak = getTakSessionStore(client, host.secureStore, host.localStore);

  // The tier decides the action and the role gates `secret`, so both are read
  // before anything is sent. A topic this account cannot read answers 403 here,
  // which is the correct end of the story.
  const meta = await client.get<TopicShape>(`/api/topics/${topicId}`);
  const tier = chatTierOf(meta?.topic?.visibility, meta?.topic?.kind === 'dm');

  if (usesTopicRootKey(tier)) {
    await tak.distributeRootWhenGroupChanged(topicId, tier);
    return;
  }
  if (tier === 'private') {
    await tak.grantPrivateHistory(topicId);
    return;
  }
  if (tier === 'secret' && meta?.currentUserRole === 'owner') {
    await tak.grantPrivateHistory(topicId);
  }
}
