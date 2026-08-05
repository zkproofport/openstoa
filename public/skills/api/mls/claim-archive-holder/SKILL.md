---
name: openstoa-claim-archive-holder
description: Claim or renew the archive-holder lease (single-winner)
metadata:
  parent: openstoa
  category: api/mls
  path: /skills/api/mls/claim-archive-holder/SKILL.md
  require-secret: false
---

# Claim or renew the archive-holder lease (single-winner)

Claims the public seed-chain holder role for the caller's device, or renews it if the caller
already holds it. SINGLE-WINNER (SI-6): the server serializes competing claimers so the seed
chain never forks. If another device holds a still-valid lease the call is rejected (409);
once a lease expires the next claimer takes over (inheriting `epochCovered` to resume
forward-rewrap). The succession `rank` is derived from the caller's topic role
(owner < admin < member) — clients prefer the lowest-rank online member to claim. Public
topics only. **Membership required.**

**Endpoint:** `POST /api/topics/{topicId}/tak/holder`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required)

**Body (application/json):**
- `deviceId` (string, required) — the caller's device that will hold the chain
- `rootFingerprint` (string, required) — Fingerprint of the archive root this device holds, proving it can actually serve the role. Publishes the topic's root identity when none is set yet, and must MATCH it thereafter (403 otherwise). A device still waiting for the root cannot produce this and must not claim — the holder is who others receive from, so claiming without the root locks the device (and every newer device) out of history.
- `leaseSeconds` (integer) — requested lease duration (default 900, max 3600). The device renews before expiry.

**Returns:** { renewed, holder }
- `renewed` (boolean) — true if the caller already held the lease
- `holder` ({ holderUserId, holderDeviceId, epochCovered, successionRank, leaseExpiresAt })

```bash
curl -s "$BASE/api/topics/:topicId/tak/holder" \
  -H "Authorization: Bearer $TOKEN" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"deviceId": "...", "rootFingerprint": "...", "leaseSeconds": 0}'
```

## See also
- [Read the public topic's archive-holder state](/skills/api/mls/get-archive-holder/SKILL.md)
- [Record how far the holder has forward-rewrapped (epoch-fenced)](/skills/api/mls/update-archive-holder-coverage/SKILL.md)
