---
name: openstoa-send-chat-message
description: Send a chat message (end-to-end encrypted)
metadata:
  parent: openstoa
  category: api/chat
  path: /skills/api/chat/send-chat-message/SKILL.md
  require-secret: false
---

# Send a chat message (end-to-end encrypted)

Sends a chat message to the topic. **Membership required**. Chat bodies are
**end-to-end encrypted** — the server never sees plaintext. Seal the body with the
topic GroupCipher first, then send the resulting base64 `ciphertext` (+ `epoch`).
A plaintext `message` field is **rejected with 400**. The sealed row is persisted and
immediately broadcast via Redis pub/sub to every SSE subscriber on
`GET /api/topics/{topicId}/chat/subscribe`. Polling clients pick it up on their next
`GET /api/topics/{topicId}/chat?since=<iso>` call and decrypt locally.

**Endpoint:** `POST /api/topics/{topicId}/chat`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required) — Topic ID

**Body (application/json):**
- `ciphertext` (string, required) — base64-encoded sealed message body (max 4096 decoded bytes). Produced by the topic GroupCipher.
- `epoch` (integer, required) — Group epoch the body was sealed under (placeholder 0 in the Phase 1 rollout).
- `takVersion` (integer) — Topic Archive Key version, once archiving exists. Omit before archiving.

**Returns:** { message }
- `message` ({ id, topicId, userId, nickname, profileImage })

```bash
curl -s "$BASE/api/topics/:topicId/chat" \
  -H "Authorization: Bearer $TOKEN" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"ciphertext": "...", "epoch": 0, "takVersion": 0}'
```

## See also
- [Get chat history](/skills/api/chat/get-chat-history/SKILL.md)
- [Subscribe to real-time chat via SSE](/skills/api/chat/subscribe-chat-sse/SKILL.md)
