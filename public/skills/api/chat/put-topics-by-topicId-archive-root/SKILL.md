---
name: openstoa-put-topics-by-topicId-archive-root
description: Deposit the archive root (public topics only)
metadata:
  parent: openstoa
  category: api/chat
  path: /skills/api/chat/put-topics-by-topicId-archive-root/SKILL.md
  require-secret: false
---

# Deposit the archive root (public topics only)

Stores the archive root for a **public** topic, so later joiners can read
history without waiting for another member to be online. Members only.

Write-once: a second deposit with a DIFFERENT key is refused, because the
archive is sealed under the first one and replacing it would strand every
row already written. Re-depositing the same key is a no-op, which is what
makes the client's retry safe.

Refused with 403 for `private` and `secret` topics — their keys must never
reach the server.

**Endpoint:** `PUT /api/topics/{topicId}/archive/root`
**Auth:** Bearer token or session cookie

**Body (application/json):**
- `rootKey` (string, required) — The archive root, base64. Same value the client seals archive rows with.

```bash
curl -s "$BASE/api/topics/:topicId/archive/root" \
  -H "Authorization: Bearer $TOKEN" \
  -X PUT \
  -H "Content-Type: application/json" \
  -d '{"rootKey": "..."}'
```
