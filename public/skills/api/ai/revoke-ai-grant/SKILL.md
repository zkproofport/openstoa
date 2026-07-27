---
name: openstoa-revoke-ai-grant
description: Revoke an AI grant (owner or the bot itself)
metadata:
  parent: openstoa
  category: api/ai
  path: /skills/api/ai/revoke-ai-grant/SKILL.md
  require-secret: false
---

# Revoke an AI grant (owner or the bot itself)

Revokes a grant by setting `revoked_at`, which immediately makes the AI's future chat
sends / history reads 403 (design §7, D11). Allowed callers: the topic **owner/admin**, or
**the AI itself** (a bot may relinquish its own capability). Idempotent — revoking an
already-revoked or unknown grant returns 404.

**D11 (documented cost):** this gates FUTURE server-mediated actions and pairs with a
client-driven MLS Remove (future PCS). Past plaintext the AI already received is NOT
cryptographically revocable — revocation = server access-gating + MLS Remove(future) +
grant revoke, never a retroactive unshare.

**Endpoint:** `DELETE /api/topics/{topicId}/ai/grants/{grantId}`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required)
- `grantId` (string, required)

**Returns:** { revoked, id }
- `revoked` (boolean)
- `id` (string)

```bash
curl -s "$BASE/api/topics/:topicId/ai/grants/:grantId" \
  -H "Authorization: Bearer $TOKEN" \
  -X DELETE
```

## See also
- [Grant a scoped UCAN-shaped capability to an AI member (owner only)](/skills/api/ai/create-ai-grant/SKILL.md)
- [List active AI grants in a topic](/skills/api/ai/list-ai-grants/SKILL.md)
