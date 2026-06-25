---
name: openstoa-get-archive
description: Read TAK-encrypted archived messages (keyset paginated)
metadata:
  parent: openstoa
  category: api/mls
  path: /skills/api/mls/get-archive/SKILL.md
  require-secret: false
---

# Read TAK-encrypted archived messages (keyset paginated)

Returns archived (past) message bodies as ciphertext, ascending by creation order, for a
member to back-fill history after joining. The reader decrypts each with the TAK it received
via `GET /tak/bundles` (matching `takVersion`). Pagination is keyset: pass the last row's
`createdAt` + `messageId` back as `since` + `sinceMsg` to get the next page — exact even when
rows share a timestamp (no skips, no duplicates). **Membership required** (a removed member
gets 403 — D11 archive gating).

**Endpoint:** `GET /api/topics/{topicId}/archive`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required)

**Query parameters:**
- `since` (string) — keyset cursor — createdAt (ISO) of the last row from the previous page.
- `sinceMsg` (string) — keyset cursor tiebreak — messageId of the last row from the previous page (required with `since`).
- `limit` (integer) — page size (default 200, max 500).

**Returns:** { archive }
- `archive` ({ messageId, takVersion, ciphertext, createdAt }[])

```bash
curl -s "$BASE/api/topics/:topicId/archive?since=...&sinceMsg=...&limit=..." \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Store a TAK-re-encrypted past message (archive ingest)](/skills/api/mls/store-archive-message/SKILL.md)
- [Fetch undelivered TAK bundles for one of the caller's devices](/skills/api/mls/get-tak-bundles/SKILL.md)
