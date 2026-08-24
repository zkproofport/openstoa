/**
 * The mini-app's transport for the read-cursor sync.
 *
 * The web twin (`src/lib/chatReadSyncHttp.ts`) posts with a cookie; this sends
 * the host's Bearer through the shared client. That difference is the whole
 * reason the transport is injected and the RULE lives in the byte-identical
 * `./chatReadSync` — see its header.
 */
import type { OpenStoaClient } from '../api/openstoaClient';
import { scheduleChatReadSync, endChatReadSync, type ReadableRow, type ReadMark } from './chatReadSync';

/** One line for a call site inside `ChatRoomScreen`. */
export function syncChatReadMls(
  client: OpenStoaClient,
  topicId: string,
  rows: readonly ReadableRow[],
): void {
  scheduleChatReadSync(topicId, rows, {
    put: (t: string, mark: ReadMark) => client.put(`/api/topics/${t}/chat/read`, mark),
  });
}

/**
 * Send a room's pending mark immediately — called when the room unmounts.
 *
 * Without it, backing straight out of a room drops the write that was still
 * inside the debounce window, and the badge stays lit on the user's other
 * devices until the next time they open that room. One last attempt and no
 * retry timer left behind (see `endChatReadSync`). Never rejects.
 */
export function flushChatReadMls(topicId: string): void {
  endChatReadSync(topicId);
}
