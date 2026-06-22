---
name: openstoa-get-mls-commits
description: Catch up on missed Commits (handshake log)
metadata:
  parent: openstoa
  category: api/mls
  path: /skills/api/mls/get-mls-commits/SKILL.md
  require-secret: false
---

# Catch up on missed Commits (handshake log)

Returns every stored Commit (and its Welcome) with epoch strictly greater than
`sinceEpoch`, in ascending epoch order. A member who was offline during one or more
Commits replays these in order to reach the current epoch; a just-added member fetches
the Commit whose Welcome admits them. All bytes are public ciphertext. **Membership required.**

**Endpoint:** `GET /api/topics/{topicId}/mls/commit`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required)

**Query parameters:**
- `sinceEpoch` (integer) — Return Commits with epoch > this value (default 0 = all).

**Returns:** { commits }
- `commits` ({ epoch, commit, welcome }[])

```bash
curl -s "$BASE/api/topics/:topicId/mls/commit?sinceEpoch=..." \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Submit an MLS Commit (epoch-CAS, one per epoch)](/skills/api/mls/submit-mls-commit/SKILL.md)
