---
name: openstoa-update-api-key
description: Edit an API key's scope (cmd + historyGrant)
metadata:
  parent: openstoa
  category: api/profile
  path: /skills/api/profile/update-api-key/SKILL.md
  require-secret: false
---

# Edit an API key's scope (cmd + historyGrant)

Re-scopes one of the caller's OWN, still-active API keys — the "edit" counterpart to
revoke-and-reissue. Only `cmd` and `historyGrant` are editable; `name` and `isAI` are fixed
at issuance and this endpoint never touches the key's secret or its hash (the raw key
keeps working unchanged, only what it is ALLOWED to do changes). Takes effect immediately —
the very next request authenticated with this key is gated by the new scope. Scoped by
session user id, same as revoke: a foreign or revoked `keyId` returns 404, not a
distinguishing 403 (no ownership oracle). Callable only from a real session — never from
another API key, regardless of that key's own `cmd` (see the 403 below).

**Endpoint:** `PATCH /api/profile/api-keys/{keyId}`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `keyId` (string, required)

**Body (application/json):**
- `cmd` (string[], required) — Replaces the key's ability allowlist entirely — a (possibly empty) subset of the allowed commands. Unknown commands are rejected with 400.
- `historyGrant` (string, required) — Replaces the chat archive scope this key may back-fill: none | Nd | since_epoch:N | full. Invalid scope → 400.

**Returns:** { key }
- `key` (object) — Metadata for the updated key (id

```bash
curl -s "$BASE/api/profile/api-keys/:keyId" \
  -H "Authorization: Bearer $TOKEN" \
  -X PATCH \
  -H "Content-Type: application/json" \
  -d '{"cmd": [], "historyGrant": "..."}'
```

## See also
- [Issue a new scoped API key](/skills/api/profile/create-api-key/SKILL.md)
- [List your API keys](/skills/api/profile/list-api-keys/SKILL.md)
- [Revoke an API key](/skills/api/profile/revoke-api-key/SKILL.md)
