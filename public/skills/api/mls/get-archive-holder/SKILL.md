---
name: openstoa-get-archive-holder
description: Read the public topic's archive-holder state
metadata:
  parent: openstoa
  category: api/mls
  path: /skills/api/mls/get-archive-holder/SKILL.md
  require-secret: false
---

# Read the public topic's archive-holder state

Returns who currently holds the public seed chain (SI-6) — the member whose device
forward-rewraps the chain on membership changes so any current member can derive every
archived epoch's TAK — plus how far it has covered and when its lease expires. Clients use
this to decide whether to claim the role (e.g. the lease has expired). Public topics only.
**Membership required.**

**Endpoint:** `GET /api/topics/{topicId}/tak/holder`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required)

**Returns:** { holder }
- `holder` ({ holderUserId, holderDeviceId, epochCovered, successionRank, leaseExpiresAt })

```bash
curl -s "$BASE/api/topics/:topicId/tak/holder" \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Claim or renew the archive-holder lease (single-winner)](/skills/api/mls/claim-archive-holder/SKILL.md)
- [Fetch undelivered TAK bundles for one of the caller's devices](/skills/api/mls/get-tak-bundles/SKILL.md)
