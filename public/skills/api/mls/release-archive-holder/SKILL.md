---
name: openstoa-release-archive-holder
description: Release this device's archive-holder lease
metadata:
  parent: openstoa
  category: api/mls
  path: /skills/api/mls/release-archive-holder/SKILL.md
  require-secret: false
---

# Release this device's archive-holder lease

Gives up the holder role for the caller's own device. Call this when a device discovers it
cannot serve the role after all — most often a device that claimed before learning it has no
archive root. The holder is the party other devices receive the root FROM, so a holder that
cannot serve blocks every newer device on the topic until its lease expires; releasing hands
succession over immediately. Scoped to the caller's own device, so this can never evict a
rival. `epochCovered` is preserved for the next holder. Public topics only.
**Membership required.**

**Endpoint:** `DELETE /api/topics/{topicId}/tak/holder`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required)

**Query parameters:**
- `deviceId` (string, required) — the caller's device that currently holds the lease

**Returns:** { released }
- `released` (boolean) — true when this device's lease was the one expired

```bash
curl -s "$BASE/api/topics/:topicId/tak/holder?deviceId=..." \
  -H "Authorization: Bearer $TOKEN" \
  -X DELETE
```

## See also
- [Claim or renew the archive-holder lease (single-winner)](/skills/api/mls/claim-archive-holder/SKILL.md)
- [Read the public topic's archive-holder state](/skills/api/mls/get-archive-holder/SKILL.md)
