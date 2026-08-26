/**
 * Which `/api/topics/...` routes belong to chat.
 *
 * Chat is mobile-only. A browser cannot read a room — the keys are on the phone
 * — but it CAN join a group, advance an epoch, and post ciphertext nobody will
 * ever decrypt, so leaving the API open to it produces damage rather than
 * merely nothing. The UI entry points are gone; this is the part that holds
 * when the UI is not the caller.
 *
 * Matched on the SEGMENT after the topic id, not as a substring of the whole
 * path. The substring form listed `/chat`, `/mls/` and `/tak/` and so let
 * `/archive` and `/keys/` straight through: a browser session could write and
 * read a room's encrypted archive, and could both ask for and hand over epoch
 * keys. Naming the segment means a new chat route is either on this list or it
 * is not chat — there is no third answer that quietly means "allowed".
 *
 * Lives outside `middleware.ts` so the test can call it directly; a middleware
 * file is expected to export `middleware` and `config` and little else.
 */
export const CHAT_SEGMENTS = ['chat', 'mls', 'tak', 'archive', 'keys'] as const;

export function isChatPath(pathname: string): boolean {
  if (!pathname.startsWith('/api/topics/')) return false;
  const rest = pathname.slice('/api/topics/'.length);
  /*
   * `rest` is `<topicId>/<segment>/...`. Reading index 1 rather than searching
   * the string means a topic id that happens to read "chat" cannot open the
   * door, and a segment only counts when it sits exactly where a route puts it.
   */
  const segment = rest.split('/')[1];
  return segment !== undefined && (CHAT_SEGMENTS as readonly string[]).includes(segment);
}
