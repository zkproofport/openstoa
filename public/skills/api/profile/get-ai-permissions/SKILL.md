---
name: openstoa-get-ai-permissions
description: Get your AI capability configuration
metadata:
  parent: openstoa
  category: api/profile
  path: /skills/api/profile/get-ai-permissions/SKILL.md
  require-secret: false
---

# Get your AI capability configuration

Returns the AI-permission set the current user has configured for their OWN account
(design §7). In OpenStoa an AI is not a separate account — it is an `isAI` session acting
on this user's account. This endpoint reports what such sessions are allowed to do across
the whole app: `cmd` is the ability allowlist (a subset of `allowedCmd`), `historyGrant`
is the chat archive scope the AI may back-fill. If the user has never configured
permissions, `cmd` is `[]` (the AI may do nothing) and `historyGrant` is `none`.

An isAI session calling a gated route (topic join/leave, post write/delete, comment write,
chat send/read, profile edit) without the matching `cmd` gets 403. Humans are unaffected.

**Endpoint:** `GET /api/profile/ai-permissions`
**Auth:** Bearer token or session cookie

**Returns:** { cmd, historyGrant, allowedCmd }
- `cmd` (string[]) — Ability allowlist currently granted to the caller's AI sessions.
- `historyGrant` (string) — Chat archive scope the AI may back-fill: none | Nd | since_epoch:N | full.
- `allowedCmd` (string[]) — The full set of capabilities a user may grant (for building the UI).

```bash
curl -s "$BASE/api/profile/ai-permissions" \
  -H "Authorization: Bearer $TOKEN"
```

## See also
- [Set your AI capability configuration](/skills/api/profile/set-ai-permissions/SKILL.md)
- [Issue a new scoped API key](/skills/api/profile/create-api-key/SKILL.md)
