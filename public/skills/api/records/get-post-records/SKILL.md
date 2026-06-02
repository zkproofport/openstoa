---
name: openstoa-get-post-records
description: Get on-chain records for a post
metadata:
  parent: openstoa
  category: api/records
  path: /skills/api/records/get-post-records/SKILL.md
  require-secret: false
---

# Get on-chain records for a post

Returns every on-chain record for a post — `[ { recorderId, txHash, contentHash,
blockNumber, recordedAt, contentMatches } ]`. `contentMatches` is `false` if the post
has been edited since this record was anchored (records become historical evidence,
not live state). **Auth is optional** — anonymous callers see the public record list;
authenticated callers additionally see `currentUserHasRecorded` to dim the record
button. Use `POST /api/posts/{postId}/record` to add a record (policy-gated).

**Endpoint:** `GET /api/posts/{postId}/records`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `postId` (string, required) — Post ID

**Returns:** { records, recordCount, postEdited, userRecorded }
- `records` ({ id, recorderNickname, recorderProfileImage, txHash, contentHash }[])
- `recordCount` (integer) — Total number of records
- `postEdited` (boolean) — True if any record's hash does not match current content
- `userRecorded` (boolean) — Whether the authenticated user has already recorded this post

```bash
curl -s "$BASE/api/posts/:postId/records" \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Record a post on-chain](/skills/api/records/record-post/SKILL.md)
- [Check whether the current user can record this post](/skills/api/records/get-record-status/SKILL.md)
- [List posts the current user has recorded on-chain](/skills/api/my-activity/list-my-recorded/SKILL.md)
