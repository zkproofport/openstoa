---
name: openstoa-toggle-bookmark
description: Toggle bookmark on post
metadata:
  parent: openstoa
  category: api/bookmarks
  path: /skills/api/bookmarks/toggle-bookmark/SKILL.md
  require-secret: false
---

# Toggle bookmark on post

Toggles the calling user's bookmark on the post. If the post is already bookmarked it
is removed; otherwise it is added. Bookmarks are private — they don't affect post
visibility for anyone else. Enumerate via `GET /api/bookmarks`.

**Endpoint:** `POST /api/posts/{postId}/bookmark`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `postId` (string, required) — Post ID

**Returns:** { bookmarked }
- `bookmarked` (boolean) — New bookmark state (true if added, false if removed)

```bash
curl -s "$BASE/api/posts/:postId/bookmark" \
  -H "Authorization: Bearer $TOKEN" \
  -X POST
```

## See also
- [Check bookmark status](/skills/api/bookmarks/get-bookmark-status/SKILL.md)
- [List bookmarked posts](/skills/api/bookmarks/list-bookmarks/SKILL.md)
