---
name: openstoa-store-archive-message
description: Store a TAK-re-encrypted past message (archive ingest)
metadata:
  parent: openstoa
  category: api/mls
  path: /skills/api/mls/store-archive-message/SKILL.md
  require-secret: false
---

# Store a TAK-re-encrypted past message (archive ingest)

Stores one past message body re-encrypted under the topic's current TAK so later members
can read it (Phase 3, design §9.2). The **client** does the re-encryption — the server must
never see plaintext (SI-1), so it stores opaque ciphertext keyed by the original message id
and the TAK version used. Idempotent: one archive row per message, so a retry or two senders
racing the same message do not duplicate. **Membership required.** Rate-limited and
size-capped (SI-4).

**Endpoint:** `POST /api/topics/{topicId}/archive`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required)

**Body (application/json):**
- `messageId` (string, required) — id of the original chat_messages row this archive body corresponds to.
- `takVersion` (integer, required) — which TAK version encrypted this body (lets the reader pick the right key).
- `archive` (string, required) — base64 TAK-encrypted message body. Server stores it as-is. Capped at 256 KiB.

```bash
curl -s "$BASE/api/topics/:topicId/archive" \
  -H "Authorization: Bearer $TOKEN" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"messageId": "...", "takVersion": 0, "archive": "..."}'
```

## See also
- [Read TAK-encrypted archived messages (keyset paginated)](/skills/api/mls/get-archive/SKILL.md)
- [Deliver an HPKE-wrapped TAK bundle to a member's device (history back-fill)](/skills/api/mls/deliver-tak-bundle/SKILL.md)
