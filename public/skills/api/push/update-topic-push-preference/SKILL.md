---
name: openstoa-update-topic-push-preference
description: Mute or unmute one topic
metadata:
  parent: openstoa
  category: api/push
  path: /skills/api/push/update-topic-push-preference/SKILL.md
  require-secret: false
---

# Mute or unmute one topic

Mutes (`muted: true`) or unmutes (`muted: false`) push notifications for THIS topic only —
the per-chat-room control. Muting does not affect any other topic and does not leave the
topic: messages still arrive in-app, only the device notification is suppressed.

**Membership required** — a non-member gets 403.

Idempotent in both directions: muting an already-muted topic (or unmuting one that was never
muted) is a no-op that still returns the correct final state, with `changed: false` so a
client can tell a real transition from a redundant tap. Two racing toggles therefore converge
instead of duplicating rows or erroring.

The account-wide switch wins: while `/api/push/preferences` has `enabled: false`, unmuting a
topic here does NOT start notifications — `willNotify` stays `false` until the global switch
is turned back on.

**Endpoint:** `PATCH /api/topics/{topicId}/push`
**Auth:** Bearer token or session cookie

**Path parameters:**
- `topicId` (string, required) — The topic (chat room) to mute or unmute. Must be a UUID; anything else is 400.

**Body (application/json):**
- `muted` (boolean, required) — Send `true` to silence this topic's notifications, `false` to restore them. Must be a real JSON boolean — the strings "true"/"false", 0/1, and null are rejected with 400.

**Returns:** { topicId, muted, changed, globalEnabled, willNotify }
- `topicId` (string) — Echo of the topic that was updated.
- `muted` (boolean) — The stored state after the call — equal to the requested value.
- `changed` (boolean) — `true` when this call actually flipped the state; `false` when it was already in the requested state (idempotent no-op).
- `globalEnabled` (boolean) — The account-wide switch, repeated so a client can warn that un-muting alone will not produce notifications while it is `false`.
- `willNotify` (boolean) — The resolved outcome after the update — `globalEnabled && !muted`.

```bash
curl -s "$BASE/api/topics/:topicId/push" \
  -H "Authorization: Bearer $TOKEN" \
  -X PATCH \
  -H "Content-Type: application/json" \
  -d '{"muted": false}'
```

## See also
- [Read your notification setting for one topic](/skills/api/push/get-topic-push-preference/SKILL.md)
- [Turn push notifications on or off globally](/skills/api/push/update-push-preferences/SKILL.md)
- [Read your push notification preferences](/skills/api/push/get-push-preferences/SKILL.md)
