---
name: openstoa-mark-chat-read
description: Move this account's read cursor for a conversation
metadata:
  parent: openstoa
  category: api/chat
  path: /skills/api/chat/mark-chat-read/SKILL.md
  require-secret: false
---

# Move this account's read cursor for a conversation

Records how far the CALLING ACCOUNT has read in this topic's chat. This is what makes an
unread badge disappear, and it is per USER — reading on one device clears the badge on
every other device signed in to the same account.

Not to be confused with `POST /api/topics/{topicId}/chat/delivered`, which is per DEVICE
and answers a different question ("may the server drop its live copy of the ciphertext").
A client that implements chat should call both: `delivered` after a successful
fetch-and-decrypt pass, `read` when the messages were actually put in front of the user.

**Call it when a room is on screen**, with the newest message the user has seen, and
again as new messages arrive while they stay in the room. Debounce it — a room scrolling
through a burst should issue one request, not one per message. Treat it as
fire-and-forget: a failure here must never break the room, and the next call recovers.

A message the client could not DECRYPT still advances the cursor. It was on screen as a
locked placeholder, so refusing it would strand the badge on a message the user has no
way to clear.

The cursor only ever moves FORWARD (an older `readAt` is accepted and ignored), a value
in the future is clamped to the server's clock, and a locally-minted `pending-` id is
rejected — it names a row the server has never stored.

Read the cursor back with `GET` on this same path, or for every joined room at once from
`GET /api/topics`, which carries `lastReadAt` and `unreadCount` per topic.

**Endpoint:** `PUT /api/topics/{topicId}/chat/read`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required) — Topic ID (a DM channel's topic id works here too)

**Body (application/json):**
- `messageId` (string, required) — Server id of the newest message the user has seen. Must be a stored message id IN THIS TOPIC; a provisional `pending-` id from an optimistic send, and an id from another topic, are each rejected with 400.
- `readAt` (string, required) — That message's `createdAt`, verbatim, INCLUSIVE. Use the server's value rather than the device clock. Advisory while the message exists — the server prefers the row's own instant, which is more precise than any JSON timestamp — and authoritative only for a message the server no longer holds, where a future value is clamped to now.

**Returns:** { lastReadAt, lastReadMessageId, unreadCount }
- `lastReadAt` (string) — INCLUSIVE instant of the newest message this account has read, or null when the room has never been read. This is the authoritative value — `unreadCount` is derived from it.
- `lastReadMessageId` (string) — The message `lastReadAt` names, or null. Informational: use it to stop a local walk exactly at that row when a burst shares a millisecond.
- `unreadCount` (integer) — Messages past the cursor, capped at 999. Counts only rows newer than `lastReadAt`, never your own messages or anything beneath one (sending is being in the room), and never system join/leave rows. A client that already holds a message window may count locally instead; both rules are the same.

```bash
curl -s "$BASE/api/topics/:topicId/chat/read" \
  -H "Authorization: Bearer $TOKEN" \
  -X PUT \
  -H "Content-Type: application/json" \
  -d '{"messageId": "...", "readAt": "..."}'
```

## See also
- [Get chat history](/skills/api/chat/get-chat-history/SKILL.md)
- [Subscribe to real-time chat via SSE](/skills/api/chat/subscribe-chat-sse/SKILL.md)
- [Acknowledge chat messages as delivered to this device](/skills/api/chat/ack-chat-delivery/SKILL.md)
- [List topics](/skills/api/topics/list-topics/SKILL.md)
