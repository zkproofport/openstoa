---
name: openstoa-list-ai-grants
description: List active AI grants in a topic
metadata:
  parent: openstoa
  category: api/ai
  path: /skills/api/ai/list-ai-grants/SKILL.md
  require-secret: false
---

# List active AI grants in a topic

Returns the topic's active (non-revoked) AI grants — metadata only (cmd allowlist, history
scope, depth, optional bindings), never key material (SI-1). **Membership required.**

**Endpoint:** `GET /api/topics/{topicId}/ai/grants`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required)

**Returns:** { grants }
- `grants` (object[])

```bash
curl -s "$BASE/api/topics/:topicId/ai/grants" \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Grant a scoped UCAN-shaped capability to an AI member (owner only)](/skills/api/ai/create-ai-grant/SKILL.md)
