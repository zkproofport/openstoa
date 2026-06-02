---
name: openstoa-get-record-status
description: Check whether the current user can record this post
metadata:
  parent: openstoa
  category: api/records
  path: /skills/api/records/get-record-status/SKILL.md
  require-secret: false
---

# Check whether the current user can record this post

Reports whether the calling user is currently allowed to record this post on-chain, and if not, the specific reason (already recorded, daily limit hit, post too new, etc.). Clients use this to disable / annotate the record action BEFORE the user taps, so we never hit them with a confirmation prompt followed by a 403 rejection.

**Endpoint:** `GET /api/posts/{postId}/record-status`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `postId` (string, required)

**Returns:** { allowed, reason }
- `allowed` (boolean)
- `reason` (string)

```bash
curl -s "$BASE/api/posts/:postId/record-status" \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Record a post on-chain](/skills/api/records/record-post/SKILL.md)
- [Get on-chain records for a post](/skills/api/records/get-post-records/SKILL.md)
