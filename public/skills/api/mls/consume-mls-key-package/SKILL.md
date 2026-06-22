---
name: openstoa-consume-mls-key-package
description: Atomically consume one KeyPackage for a joining device (SI-3)
metadata:
  parent: openstoa
  category: api/mls
  path: /skills/api/mls/consume-mls-key-package/SKILL.md
  require-secret: false
---

# Atomically consume one KeyPackage for a joining device (SI-3)

Called by an existing member who is about to MLS-Add a joiner. Atomically claims **exactly
one** unconsumed KeyPackage belonging to `userId` (`UPDATE ... WHERE consumed_at IS NULL
... RETURNING` with row locking), so two concurrent adders can never consume the same
package (SI-3 — no double-join). Non-last-resort packages are marked consumed; last-resort
(AI) packages are returned without consuming. Returns 404 when the user has no package
available. **Membership required.**

**Endpoint:** `GET /api/topics/{topicId}/mls/key-packages`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required)

**Query parameters:**
- `userId` (string, required) — The joining user (nullifier) whose KeyPackage to consume.
- `deviceId` (string) — Optionally restrict to a specific device of that user.

**Returns:** { id, deviceId, keyPackage, isLastResort }
- `id` (string)
- `deviceId` (string)
- `keyPackage` (string) — base64 KeyPackage bytes
- `isLastResort` (boolean)

```bash
curl -s "$BASE/api/topics/:topicId/mls/key-packages?userId=...&deviceId=..." \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Publish a device MLS KeyPackage (public key material)](/skills/api/mls/publish-mls-key-package/SKILL.md)
- `commit-mls` (skill not found — fix x-related-skills in JSDoc)
