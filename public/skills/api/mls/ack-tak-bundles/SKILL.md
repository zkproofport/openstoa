---
name: openstoa-ack-tak-bundles
description: Acknowledge delivered TAK bundles
metadata:
  parent: openstoa
  category: api/mls
  path: /skills/api/mls/ack-tak-bundles/SKILL.md
  require-secret: false
---

# Acknowledge delivered TAK bundles

Marks the listed bundle ids delivered for the caller's `deviceId`, called AFTER the device
has durably persisted the keys. Scoped to the caller's own (user, device) — a caller can
never ack another device's bundles. Already-acked or foreign ids are ignored. **Membership
required.**

**Endpoint:** `DELETE /api/topics/{topicId}/tak/bundles`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required)

**Body (application/json):**
- `deviceId` (string, required) — the caller's device id that received the bundles
- `ids` (string[], required) — bundle ids to mark delivered

**Returns:** { acked }
- `acked` (integer)

```bash
curl -s "$BASE/api/topics/:topicId/tak/bundles" \
  -H "Authorization: Bearer $TOKEN" \
  -X DELETE
```

## See also
- [Fetch undelivered TAK bundles for one of the caller's devices](/skills/api/mls/get-tak-bundles/SKILL.md)
