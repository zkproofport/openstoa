---
name: openstoa-delete-uploaded-images
description: Delete uploaded images (draft cleanup)
metadata:
  parent: openstoa
  category: api/upload
  path: /skills/api/upload/delete-uploaded-images/SKILL.md
  require-secret: false
---

# Delete uploaded images (draft cleanup)

Deletes one or more uploaded R2 images. Used by the mobile compose screen on **Reset** / cancel-with-staged-images so files uploaded for an abandoned draft don't pile up in R2. Each URL is authorised by matching the `/{env}/{folder}/{userId}/` prefix against the caller's session — users can only delete their own uploads. URLs that don't resolve to an R2 object (external CDNs, base64 data URIs) are silently skipped.

**Endpoint:** `DELETE /api/upload`
**Auth:** Bearer token or session cookie

**Body (application/json):**
- `urls` (string[], required) — Image URLs returned by POST /api/upload

**Returns:** { attempted, deleted, skipped }
- `attempted` (integer)
- `deleted` (integer)
- `skipped` (integer)

```bash
curl -s "$BASE/api/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -X DELETE
```

## See also
- [Upload image file](/skills/api/upload/upload-image/SKILL.md)
