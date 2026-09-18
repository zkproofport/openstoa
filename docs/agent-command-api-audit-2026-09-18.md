# Agent command / REST / MCP audit — 2026-09-18

Inventory: 84 CLI leaves and matching MCP tools: 37 explicit command adapters plus 47 catalogue operations. Source: `packages/sdk/src/rest/operations.ts`, `packages/cli/src/cli.ts`, `packages/mcp/src/tools.ts`, and the actual REST handlers.

## What this audit proves

- Every catalogue operation has an independent expected method/path/query/body fixture used by SDK, command-core, CLI argument and MCP schema/dispatch tests. These are contract tests, not proof that every server permission/crypto branch ran live.
- Local CLI/MCP E2E execution is recorded separately in `packages/cli/src/__tests__/e2e/agent-workflows.e2e.test.ts` and `packages/mcp/src/__tests__/e2e/agent-workflows.e2e.test.ts`; consult their final run results for runtime evidence. Intended HTTP denials (disabled Ask, unsupported proof/ownership) are distinguished from successful operations.
- `capabilities` below are actual route guards, not inferred from capability names. Empty means no additional `requireAiCapability` guard recorded for that route; authentication, visibility and ownership still apply.
- API-key scope applies to AI sessions at server guards. Owner credential-management commands are exposed for real owner sessions and explicitly rejected by the server when an API key is used.

## CLI → MCP → HTTP mapping

| CLI | MCP | HTTP / transport | Access / behavior |
|---|---|---|---|
| `activity likes` | `openstoa_activity_likes` | GET /api/my/likes | Authenticated account; route authorization applies. |
| `activity posts` | `openstoa_activity_posts` | GET /api/my/posts | Authenticated account; route authorization applies. |
| `activity recorded` | `openstoa_activity_recorded` | GET /api/my/recorded | Authenticated account; route authorization applies. |
| `activity recorded-on-mine` | `openstoa_activity_recorded_on_mine` | GET /api/my/recorded-on-mine | Authenticated account; route authorization applies. |
| `apikey create` | `openstoa_apikey_create` | POST /api/profile/api-keys | OWNER SESSION ONLY. Server rejects API-key-authenticated credentials; raw key returned once. |
| `apikey list` | `openstoa_apikey_list` | GET /api/profile/api-keys | OWNER SESSION ONLY. No raw key in list. |
| `apikey revoke` | `openstoa_apikey_revoke` | DELETE /api/profile/api-keys/{keyId} | OWNER SESSION ONLY. Revokes immediately. |
| `apikey update` | `openstoa_apikey_update` | PATCH /api/profile/api-keys/{keyId} | OWNER SESSION ONLY. Both cmd and historyGrant required; replacement, not merge. |
| `ask` | `openstoa_ask` | POST /api/ask | Public endpoint; server visibility rules apply. DISABLED: HTTP 503. |
| `bookmarks` | `openstoa_bookmarks` | GET /api/bookmarks | Authenticated account; route authorization applies. |
| `categories` | `openstoa_categories_list` | GET /api/categories | Public read. |
| `chat history` | `openstoa_chat_history` | GET /api/topics/{topicId}/archive; MLS/TAK transport | /openstoa/chat/read and API-key historyGrant; locally decryptable archive only; unavailable keys omit rows. |
| `chat join` | `openstoa_chat_join` | GET /api/topics/{topicId}; conditional POST /api/topics/{topicId}/join; MLS transport | Existing members skip membership mutation; new members need /openstoa/topic/join; local keys retained. |
| `chat mark-read` | `openstoa_chat_mark_read` | PUT /api/topics/{topicId}/chat/read | Topic member. AI cmd: /openstoa/chat/read |
| `chat presence` | `openstoa_chat_presence` | GET /api/topics/{topicId}/chat/presence | Topic member. |
| `chat read` | `openstoa_chat_read` | GET /api/topics/{topicId}/chat; POST /api/topics/{topicId}/chat/delivered; MLS/TAK transport | /openstoa/chat/read; before is server message ID; since ISO; archive fallback is historyGrant-limited. |
| `chat read-state` | `openstoa_chat_read_state` | GET /api/topics/{topicId}/chat/read | Topic member. AI cmd: /openstoa/chat/read |
| `chat send` | `openstoa_chat_send` | POST /api/topics/{topicId}/chat; MLS/TAK transport | /openstoa/chat/send; member; only ciphertext reaches REST. |
| `chat send-media` | `openstoa_chat_send_media` | POST /api/topics/{topicId}/chat/media; POST /api/topics/{topicId}/chat; MLS/TAK transport | E2EE image upload then sealed message; membership and chat/send; local encryption. |
| `chat share-keys` | `openstoa_chat_share_keys` | MLS/TAK transport; private archive GET /api/topics/{topicId}/archive | Existing member devices and locally-held keys; private/secret archive traversal requires chat/read + historyGrant. Not a new-member invitation. |
| `comment add` | `openstoa_comment_add` | POST /api/posts/{postId}/comments | /openstoa/comment/write; member. |
| `comment delete` | `openstoa_comment_delete` | DELETE /api/comments/{commentId} | Author or topic owner/admin; route authorization applies. |
| `comment list` | `openstoa_comment_list` | GET /api/posts/{postId} | Reads comments from post-detail response; no GET /comments route. |
| `dm candidates` | `openstoa_dm_candidates` | GET /api/dm/candidates | Authenticated account; route authorization applies. AI cmd: /openstoa/chat/read |
| `dm history` | `openstoa_dm_history` | GET /api/topics/{topicId}/archive; MLS/TAK transport | Alias of chat history; same historyGrant/key limits. |
| `dm list` | `openstoa_dm_list` | GET /api/dm | /openstoa/chat/read; routing metadata only, no plaintext preview. |
| `dm read` | `openstoa_dm_read` | GET /api/topics/{topicId}/chat; MLS/TAK transport | Alias of chat read; same capability/history limits. |
| `dm send` | `openstoa_dm_send` | POST /api/topics/{topicId}/chat; MLS/TAK transport | Alias of chat send; topicId is DM channel ID. |
| `dm start` | `openstoa_dm_start` | POST /api/dm; MLS transport | /openstoa/chat/send; idempotent peer pair; MLS initialized locally. |
| `feed` | `openstoa_feed` | GET /api/feed | Guests see public topics; signed-in accounts also see joined topics. |
| `login` | `openstoa_login` | GET /api/auth/session; hidden --dev: POST /api/auth/dev-login | Validates a candidate token before adoption; --dev non-production only; Google login disabled. |
| `logout` | `openstoa_logout` | local session file only | Local credential removal; does not clear externally configured API keys or erase encryption keys. |
| `notifications get` | `openstoa_notifications_get` | GET /api/push/preferences | Authenticated account; route authorization applies. |
| `notifications set` | `openstoa_notifications_set` | PATCH /api/push/preferences | Authenticated account; route authorization applies. |
| `notifications set-topic` | `openstoa_notifications_set_topic` | PATCH /api/topics/{topicId}/push | Topic member. |
| `notifications topic` | `openstoa_notifications_topic` | GET /api/topics/{topicId}/push | Topic member. |
| `post bookmark` | `openstoa_post_bookmark` | POST /api/posts/{postId}/bookmark | Topic member. |
| `post bookmark-status` | `openstoa_post_bookmark_status` | GET /api/posts/{postId}/bookmark | Authenticated account; route authorization applies. |
| `post create` | `openstoa_post_create` | POST /api/topics/{topicId}/posts | /openstoa/post/write; member; media/poll JSON supported. |
| `post delete` | `openstoa_post_delete` | DELETE /api/posts/{postId} | /openstoa/post/delete; authorship/role and recorded-content policy. |
| `post get` | `openstoa_post_get` | GET /api/posts/{postId} | Public/private visibility; contains comments and poll. |
| `post list` | `openstoa_post_list` | GET /api/topics/{topicId}/posts | Public/private visibility policy; query pagination/search/sort supported. |
| `post pin` | `openstoa_post_pin` | POST /api/posts/{postId}/pin | Topic owner or admin. |
| `post poll-unvote` | `openstoa_post_poll_unvote` | DELETE /api/posts/{postId}/poll/vote | Authenticated account; route authorization applies. |
| `post poll-vote` | `openstoa_post_poll_vote` | POST /api/posts/{postId}/poll/vote | Topic member; poll must be open. |
| `post react` | `openstoa_post_react` | POST /api/posts/{postId}/reactions | Topic member. |
| `post reactions` | `openstoa_post_reactions` | GET /api/posts/{postId}/reactions | Public endpoint; server visibility rules apply. |
| `post record` | `openstoa_post_record` | POST /api/posts/{postId}/record | Topic member; not your own post; at least one hour old; daily limit. |
| `post record-status` | `openstoa_post_record_status` | GET /api/posts/{postId}/record-status | Authenticated account; route authorization applies. |
| `post records` | `openstoa_post_records` | GET /api/posts/{postId}/records | Public endpoint; server visibility rules apply. |
| `post update` | `openstoa_post_update` | PATCH /api/posts/{postId} | /openstoa/post/write; author; recorded content locked; poll:null removes unvoted poll. |
| `post vote` | `openstoa_post_vote` | POST /api/posts/{postId}/vote | Topic member. |
| `profile badges` | `openstoa_profile_badges` | GET /api/profile/badges | Authenticated account; route authorization applies. AI cmd: /openstoa/profile/read |
| `profile domain-badge` | `openstoa_profile_domain_badge` | GET /api/profile/domain-badge | Authenticated account; route authorization applies. AI cmd: /openstoa/profile/read |
| `profile get` | `openstoa_profile_get` | GET /api/auth/session | Authenticated credential. |
| `profile image` | `openstoa_profile_image` | GET /api/profile/image | Authenticated account; route authorization applies. |
| `profile remove-domain-badge` | `openstoa_profile_remove_domain_badge` | DELETE /api/profile/domain-badge | Authenticated account; route authorization applies. AI cmd: /openstoa/profile/edit |
| `profile remove-image` | `openstoa_profile_remove_image` | DELETE /api/profile/image | Authenticated account; route authorization applies. |
| `profile set-badge` | `openstoa_profile_set_badge` | PATCH /api/profile/badges | Authenticated account; route authorization applies. AI cmd: /openstoa/profile/edit |
| `profile set-domain-badge` | `openstoa_profile_set_domain_badge` | POST /api/profile/domain-badge | Authenticated account; route authorization applies. AI cmd: /openstoa/profile/edit |
| `profile set-image` | `openstoa_profile_set_image` | PUT /api/profile/image | Authenticated account; route authorization applies. |
| `profile set-nickname` | `openstoa_profile_set_nickname` | PUT /api/profile/nickname | /openstoa/profile/edit; updated token persisted when server rotates it. |
| `recorded` | `openstoa_recorded` | GET /api/recorded | Authenticated account; route authorization applies. |
| `stats` | `openstoa_stats` | GET /api/stats | Public endpoint; server visibility rules apply. |
| `tags` | `openstoa_tags` | GET /api/tags | Public endpoint; server visibility rules apply. |
| `topics approve` | `openstoa_topic_approve` | PATCH /api/topics/{topicId}/requests | Topic owner or admin. |
| `topics create` | `openstoa_topic_create` | POST /api/topics | Authenticated; categoryId required by server; creation proof/country/domain policy applies. |
| `topics delete` | `openstoa_topic_delete` | DELETE /api/topics/{topicId} | Topic owner/creator or site administrator; personal topics cannot be deleted here. |
| `topics get` | `openstoa_topic_get` | GET /api/topics/{topicId} | Public/private discovery; secret topic membership enforced. |
| `topics invite` | `openstoa_topic_invite` | POST /api/topics/{topicId}/invite | Any public-topic member; private/secret topics require owner or admin. |
| `topics invite-lookup` | `openstoa_topic_invite_lookup` | GET /api/topics/join/{inviteCode} | Authenticated account; route authorization applies. |
| `topics join` | `openstoa_topic_join` | POST /api/topics/{topicId}/join | /openstoa/topic/join when becoming member; proof/invite policy remains server-enforced; initializes MLS locally. |
| `topics join-invite` | `openstoa_topic_join_invite` | POST /api/topics/join/{inviteCode} | Authenticated account; route authorization applies. |
| `topics kick` | `openstoa_topic_kick` | DELETE /api/topics/{topicId}/members | Topic owner or admin; admins can only remove members. AI cmd: /openstoa/topic/leave |
| `topics leave` | `openstoa_topic_leave` | POST /api/topics/{topicId}/leave | /openstoa/topic/leave for AI; owner must transfer first; preserves left:false idempotency. |
| `topics list` | `openstoa_topics_list` | GET /api/topics | Public read; signed-in visibility rules. No post/read cmd guard in route. |
| `topics members` | `openstoa_topic_members` | GET /api/topics/{topicId}/members | Authenticated route policy; no separate capability guard. |
| `topics reject` | `openstoa_topic_reject` | PATCH /api/topics/{topicId}/requests | Topic owner or admin. |
| `topics requests` | `openstoa_topic_requests` | GET /api/topics/{topicId}/requests | Topic owner or admin. |
| `topics set-role` | `openstoa_topic_set_role` | PATCH /api/topics/{topicId}/members | Topic owner; cannot change your own role. |
| `topics update` | `openstoa_topic_update` | PATCH /api/topics/{topicId} | Topic creator/owner; supported fields only title,description,image. |
| `upload` | `openstoa_upload_image` | POST /api/upload | Authenticated multipart image upload; MIME/size constraints; returns URL exactly as server provides. |
| `upload-delete` | `openstoa_upload_delete` | DELETE /api/upload | Authenticated upload owner; foreign or invalid URLs are skipped. |
| `whoami` | `openstoa_whoami` | GET /api/auth/session | Authenticated credential. |

## Every REST handler: mapped or intentionally outside the generic command surface

Exclusion is a client-surface decision, **not** a claim that the REST server rejects API keys. In particular, `DELETE /api/account` currently authenticates with `getSession` and has no owner-session-only API-key guard; it remains an account-lifecycle API intentionally absent from CLI/MCP.

| HTTP handler | Classification / consumer |
|---|---|
| `DELETE /api/account` | Account deletion lifecycle; intentionally not exposed in CLI/MCP. Server currently uses session authentication, not an API-key owner-only guard. |
| `POST /api/ask` | CLI/MCP: `ask` |
| `POST /api/ask/stream` | Disabled AI streaming service; non-stream Ask command documents HTTP 503. |
| `POST /api/auth/challenge` | Advanced SDK auth helper / external proof bootstrap; no standalone CLI/MCP tool. Interactive AI prover login is disabled; use issued API keys. |
| `POST /api/auth/dev-login` | CLI/MCP: `login` |
| `GET /api/auth/device/challenge` | Device-key / account-recovery transport; local crypto/WebAuthn custody workflow, intentionally not a raw generic agent command. |
| `POST /api/auth/device/challenge` | Device-key / account-recovery transport; local crypto/WebAuthn custody workflow, intentionally not a raw generic agent command. |
| `POST /api/auth/logout` | Browser/mobile login, cookie or proof-poll workflow; not a generic API-key agent command. |
| `GET /api/auth/poll/{requestId}` | Browser/mobile login, cookie or proof-poll workflow; not a generic API-key agent command. |
| `POST /api/auth/proof-request` | Browser/mobile login, cookie or proof-poll workflow; not a generic API-key agent command. |
| `POST /api/auth/refresh` | Advanced SDK auth helper / external proof bootstrap; no standalone CLI/MCP tool. Interactive AI prover login is disabled; use issued API keys. |
| `GET /api/auth/session` | CLI/MCP: `login`, `whoami`, `profile get` |
| `GET /api/auth/token-login` | Browser/mobile login, cookie or proof-poll workflow; not a generic API-key agent command. |
| `POST /api/auth/verify/ai` | Advanced SDK auth helper / external proof bootstrap; no standalone CLI/MCP tool. Interactive AI prover login is disabled; use issued API keys. |
| `POST /api/beta-signup` | Human beta-signup web form; not an agent business command. |
| `GET /api/bookmarks` | CLI/MCP: `bookmarks` |
| `POST /api/categories` | Site-administration operation; intentionally not a generic agent command. |
| `GET /api/categories` | CLI/MCP: `categories` |
| `DELETE /api/comments/{commentId}` | CLI/MCP: `comment delete` |
| `POST /api/diag/e2ee` | Test/diagnostic/health endpoint; not a generic agent business command. |
| `GET /api/dm/candidates` | CLI/MCP: `dm candidates` |
| `GET /api/dm` | CLI/MCP: `dm list` |
| `POST /api/dm` | CLI/MCP: `dm start` |
| `GET /api/docs/openapi.json` | Machine-readable API/proof documentation; accessed by URL rather than a business command. |
| `GET /api/docs/proof-guide/{proofType}` | Machine-readable API/proof documentation; accessed by URL rather than a business command. |
| `GET /api/feed` | CLI/MCP: `feed` |
| `GET /api/health` | Test/diagnostic/health endpoint; not a generic agent business command. |
| `GET /api/keys/backup` | Device-key / account-recovery transport; local crypto/WebAuthn custody workflow, intentionally not a raw generic agent command. |
| `POST /api/keys/backup` | Device-key / account-recovery transport; local crypto/WebAuthn custody workflow, intentionally not a raw generic agent command. |
| `DELETE /api/keys/backup` | Device-key / account-recovery transport; local crypto/WebAuthn custody workflow, intentionally not a raw generic agent command. |
| `GET /api/keys/tak-backup` | Device-key / account-recovery transport; local crypto/WebAuthn custody workflow, intentionally not a raw generic agent command. |
| `POST /api/keys/tak-backup` | Device-key / account-recovery transport; local crypto/WebAuthn custody workflow, intentionally not a raw generic agent command. |
| `GET /api/me/events` | SSE live-event transport for app sessions; CLI/MCP expose explicit reads, not a persistent subscription command. |
| `GET /api/media/{key}` | Link-preview/media-serving utility; consumers use returned URLs. |
| `GET /api/my/likes` | CLI/MCP: `activity likes` |
| `GET /api/my/posts` | CLI/MCP: `activity posts` |
| `GET /api/my/recorded` | CLI/MCP: `activity recorded` |
| `GET /api/my/recorded-on-mine` | CLI/MCP: `activity recorded-on-mine` |
| `GET /api/og/image` | Link-preview/media-serving utility; consumers use returned URLs. |
| `GET /api/og` | Link-preview/media-serving utility; consumers use returned URLs. |
| `GET /api/posts/{postId}/bookmark` | CLI/MCP: `post bookmark-status` |
| `POST /api/posts/{postId}/bookmark` | CLI/MCP: `post bookmark` |
| `POST /api/posts/{postId}/comments` | CLI/MCP: `comment add` |
| `POST /api/posts/{postId}/pin` | CLI/MCP: `post pin` |
| `POST /api/posts/{postId}/poll/vote` | CLI/MCP: `post poll-vote` |
| `DELETE /api/posts/{postId}/poll/vote` | CLI/MCP: `post poll-unvote` |
| `GET /api/posts/{postId}/reactions` | CLI/MCP: `post reactions` |
| `POST /api/posts/{postId}/reactions` | CLI/MCP: `post react` |
| `POST /api/posts/{postId}/record` | CLI/MCP: `post record` |
| `GET /api/posts/{postId}/record-status` | CLI/MCP: `post record-status` |
| `GET /api/posts/{postId}/records` | CLI/MCP: `post records` |
| `GET /api/posts/{postId}` | CLI/MCP: `post get`, `comment list` |
| `DELETE /api/posts/{postId}` | CLI/MCP: `post delete` |
| `PATCH /api/posts/{postId}` | CLI/MCP: `post update` |
| `POST /api/posts/{postId}/vote` | CLI/MCP: `post vote` |
| `GET /api/profile/ai-permissions` | Retired account-level capability API; scope is managed on owner-issued API keys. |
| `PUT /api/profile/ai-permissions` | Retired account-level capability API; scope is managed on owner-issued API keys. |
| `PATCH /api/profile/api-keys/{keyId}` | CLI/MCP: `apikey update` |
| `DELETE /api/profile/api-keys/{keyId}` | CLI/MCP: `apikey revoke` |
| `POST /api/profile/api-keys` | CLI/MCP: `apikey create` |
| `GET /api/profile/api-keys` | CLI/MCP: `apikey list` |
| `GET /api/profile/badges` | CLI/MCP: `profile badges` |
| `PATCH /api/profile/badges` | CLI/MCP: `profile set-badge` |
| `GET /api/profile/domain-badge` | CLI/MCP: `profile domain-badge` |
| `POST /api/profile/domain-badge` | CLI/MCP: `profile set-domain-badge` |
| `DELETE /api/profile/domain-badge` | CLI/MCP: `profile remove-domain-badge` |
| `GET /api/profile/image` | CLI/MCP: `profile image` |
| `PUT /api/profile/image` | CLI/MCP: `profile set-image` |
| `DELETE /api/profile/image` | CLI/MCP: `profile remove-image` |
| `PUT /api/profile/nickname` | CLI/MCP: `profile set-nickname` |
| `GET /api/push/preferences` | CLI/MCP: `notifications get` |
| `PATCH /api/push/preferences` | CLI/MCP: `notifications set` |
| `POST /api/push/register` | Mobile OS device push registration; not an agent operation (preferences are exposed). |
| `DELETE /api/push/register` | Mobile OS device push registration; not an agent operation (preferences are exposed). |
| `GET /api/recorded` | CLI/MCP: `recorded` |
| `GET /api/stats` | CLI/MCP: `stats` |
| `GET /api/tags` | CLI/MCP: `tags` |
| `DELETE /api/test/clear-verification-cache` | Test/diagnostic/health endpoint; not a generic agent business command. |
| `GET /api/topics/{topicId}/archive/root` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `PUT /api/topics/{topicId}/archive/root` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `POST /api/topics/{topicId}/archive` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `GET /api/topics/{topicId}/archive` | CLI/MCP: `chat history`, `chat share-keys`, `dm history` |
| `POST /api/topics/{topicId}/blind` | Site-administration operation; intentionally not a generic agent command. |
| `POST /api/topics/{topicId}/chat/delivered` | CLI/MCP: `chat read` |
| `POST /api/topics/{topicId}/chat/media` | CLI/MCP: `chat send-media` |
| `GET /api/topics/{topicId}/chat/media` | SDK encrypted attachment/delivery transport; high-level chat send-media/read owns byte/identity handling. |
| `PATCH /api/topics/{topicId}/chat/media` | SDK encrypted attachment/delivery transport; high-level chat send-media/read owns byte/identity handling. |
| `DELETE /api/topics/{topicId}/chat/media` | SDK encrypted attachment/delivery transport; high-level chat send-media/read owns byte/identity handling. |
| `GET /api/topics/{topicId}/chat/presence` | CLI/MCP: `chat presence` |
| `PUT /api/topics/{topicId}/chat/read` | CLI/MCP: `chat mark-read` |
| `GET /api/topics/{topicId}/chat/read` | CLI/MCP: `chat read-state` |
| `GET /api/topics/{topicId}/chat` | CLI/MCP: `chat read`, `dm read` |
| `POST /api/topics/{topicId}/chat` | CLI/MCP: `chat send`, `chat send-media`, `dm send` |
| `GET /api/topics/{topicId}/chat/subscribe` | SSE live-event transport for app sessions; CLI/MCP expose explicit reads, not a persistent subscription command. |
| `POST /api/topics/{topicId}/invite` | CLI/MCP: `topics invite` |
| `POST /api/topics/{topicId}/join` | CLI/MCP: `topics join`, `chat join` |
| `POST /api/topics/{topicId}/keys/grant` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `GET /api/topics/{topicId}/keys/request` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `POST /api/topics/{topicId}/keys/request` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `POST /api/topics/{topicId}/leave` | CLI/MCP: `topics leave` |
| `GET /api/topics/{topicId}/members` | CLI/MCP: `topics members` |
| `PATCH /api/topics/{topicId}/members` | CLI/MCP: `topics set-role` |
| `DELETE /api/topics/{topicId}/members` | CLI/MCP: `topics kick` |
| `POST /api/topics/{topicId}/mls/commit` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `GET /api/topics/{topicId}/mls/commit` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `GET /api/topics/{topicId}/mls/group-info` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `POST /api/topics/{topicId}/mls/group-info` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `POST /api/topics/{topicId}/mls/key-packages` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `GET /api/topics/{topicId}/mls/key-packages` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `GET /api/topics/{topicId}/posts` | CLI/MCP: `post list` |
| `POST /api/topics/{topicId}/posts` | CLI/MCP: `post create` |
| `GET /api/topics/{topicId}/push` | CLI/MCP: `notifications topic` |
| `PATCH /api/topics/{topicId}/push` | CLI/MCP: `notifications set-topic` |
| `GET /api/topics/{topicId}/requests` | CLI/MCP: `topics requests` |
| `PATCH /api/topics/{topicId}/requests` | CLI/MCP: `topics approve`, `topics reject` |
| `GET /api/topics/{topicId}` | CLI/MCP: `topics get`; SDK membership check for `chat join/send/send-media/read/history/share-keys`, `dm send/read/history` |
| `PATCH /api/topics/{topicId}` | CLI/MCP: `topics update` |
| `DELETE /api/topics/{topicId}` | CLI/MCP: `topics delete` |
| `POST /api/topics/{topicId}/tak/bundles` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `GET /api/topics/{topicId}/tak/bundles` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `DELETE /api/topics/{topicId}/tak/bundles` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `GET /api/topics/{topicId}/tak/holder` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `POST /api/topics/{topicId}/tak/holder` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `DELETE /api/topics/{topicId}/tak/holder` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `PATCH /api/topics/{topicId}/tak/holder` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `GET /api/topics/{topicId}/tak/root-fingerprint` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `PUT /api/topics/{topicId}/tak/root-fingerprint` | Internal MLS/TAK/key-sharing transport used by SDK chat workflows; not a raw generic agent command. |
| `GET /api/topics/join/{inviteCode}` | CLI/MCP: `topics invite-lookup` |
| `POST /api/topics/join/{inviteCode}` | CLI/MCP: `topics join-invite` |
| `GET /api/topics` | CLI/MCP: `topics list` |
| `POST /api/topics` | CLI/MCP: `topics create` |
| `POST /api/upload` | CLI/MCP: `upload` |
| `DELETE /api/upload` | CLI/MCP: `upload-delete` |

## Remaining practical limits

- The interactive Google device-flow login and Ask service are intentionally disabled. The former unit test is skipped with that explicit reason; Ask is tested as an expected 503, not claimed as working AI inference.
- Real third-party KYC/workspace proofs, WebAuthn recovery, OS push delivery, site-admin moderation and externally funded chain recording are not claimed from unit-level adapter parity. Server refusal branches can be verified without those external prerequisites.
- Chat archive results require both server history authorization and available local keys. Reading a room never reconstructs missing keys or widens the issued API-key history grant.
- Generic REST JSON is preserved. User-authored text, media and API field names are not translated; the human web/docs surfaces provide localized explanation.
- Existing title/image/social metadata localization is separate from this agent API contract audit.
