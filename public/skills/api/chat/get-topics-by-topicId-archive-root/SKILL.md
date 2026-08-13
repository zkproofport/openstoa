---
name: openstoa-get-topics-by-topicId-archive-root
description: Fetch the server-held archive root (public topics only)
metadata:
  parent: openstoa
  category: api/chat
  path: /skills/api/chat/get-topics-by-topicId-archive-root/SKILL.md
  require-secret: false
---

# Fetch the server-held archive root (public topics only)

Returns the archive root for a **public** topic, so a member who joined after
the conversation started can decrypt its history immediately. Members only.

Refused with 403 for `private` and `secret` topics: their archive keys never
reach the server. A private topic's root travels inside its invite link; a
secret topic shares no history at all.

**Endpoint:** `GET /api/topics/{topicId}/archive/root`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required) — The topic whose archive root is wanted.

```bash
curl -s "$BASE/api/topics/:topicId/archive/root" \
  -H "Authorization: Bearer $TOKEN"
```
