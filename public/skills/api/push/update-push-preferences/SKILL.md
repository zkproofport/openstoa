---
name: openstoa-update-push-preferences
description: Turn push notifications on or off globally
metadata:
  parent: openstoa
  category: api/push
  path: /skills/api/push/update-push-preferences/SKILL.md
  require-secret: false
---

# Turn push notifications on or off globally

Sets the caller's GLOBAL notification switch. This is the in-app equivalent of the OS-level
notification toggle and is deliberately independent of it: turning this off suppresses every
push server-side even while the operating system still permits them, and turning it on does
NOT grant OS permission (a client whose OS permission is denied must send the user to system
settings — it cannot be fixed from here).

`enabled: false` beats every per-topic setting: no topic notifies, muted or not. Un-muting a
topic while globally off therefore changes nothing visible until this is set back to `true`;
per-topic mutes are preserved across the round trip rather than reset.

Idempotent — sending the same value twice is a no-op that returns the same body, so a
double-tap or two racing clients converge instead of erroring.

**Endpoint:** `PATCH /api/push/preferences`
**Auth:** Bearer token or session cookie

**Body (application/json):**
- `enabled` (boolean, required) — Send `true` to allow push notifications for this account, `false` to suppress all of them. Must be a real JSON boolean — the strings "true"/"false", 0/1, and null are rejected with 400 so an ambiguous value can never be read as "off".

**Returns:** { enabled, mutedTopicIds }
- `enabled` (boolean) — The stored global switch after the update (echoed from the database, not from the request).
- `mutedTopicIds` (string[]) — Per-topic mutes, unchanged by this call — returned so a client can refresh its whole preference view in one round trip.

```bash
curl -s "$BASE/api/push/preferences" \
  -H "Authorization: Bearer $TOKEN" \
  -X PATCH \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

## See also
- [Read your push notification preferences](/skills/api/push/get-push-preferences/SKILL.md)
- [Mute or unmute one topic](/skills/api/push/update-topic-push-preference/SKILL.md)
