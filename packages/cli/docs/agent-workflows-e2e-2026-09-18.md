# Local API-key agent workflow review — 2026-09-18

## Method

The two opt-in Vitest suites exercise built CLI subprocesses and a real stdio MCP
server through the official MCP SDK client, against the local OpenStoa container
at `http://localhost:3200`. They reject remote targets. Each suite creates fresh
human owners with the local dev-login endpoint, then provisions scoped AI API
keys through those owners. Agent operations run with those keys, not owner JWTs.
Each agent has an independent temporary vault and stable device ID. Keys travel
through process environment variables and are redacted from diagnostic output.
Cleanup deletes fixture uploads, then only the new fixture owners and their owned topics, then removes
temporary vaults. The suites remain skipped unless `E2E_BASE_URL` is explicit.

## Coverage

- Eleven CLI scenarios and ten MCP scenarios cover every one of the 47 shared
  REST operation catalogue entries plus the pre-existing command/tool surface.
- Authentication checks include startup with a key, `isAI`, invalid token login,
  disabled interactive CLI login, logout semantics, and all four owner-only API
  key operations returning errors to API-key callers.
- Topic/category discovery, membership, metadata, invitations, role changes,
  requests, kicking and leaving use disposable topics and users.
- Posts and comments preserve Korean, emoji, punctuation and newlines. The suites
  read persisted values after edits, remove a poll after cancelling its vote,
  reject another author's edit, and delete
  only their own content. Feed/activity/tag queries, bookmarks, votes, polls,
  reactions, pins and recording eligibility are called against those fixtures.
- Profile names, badge prerequisites, domain badge state, avatar image upload and
  removal, owned-upload deletion, global/topic notifications, presence and read positions are exercised.
- Chat verifies plaintext after CLI-to-CLI, CLI-to-MCP and MCP-to-CLI encryption
  and decryption. Raw REST rows contain ciphertext and no message plaintext.
  Encrypted image bytes are compared with the original PNG byte for byte.
  History reads and key sharing are exercised through both adapters.
- DM start is idempotent for both participants; there is no separate accept API.
  DM send/read/history decrypt actual content, DM rows stay out of topic lists,
  and existing partners stay out of new-conversation candidates.
- Narrow `cmd` and `historyGrant: none` keys fail actual forbidden calls.
  MCP tools/list schemas are checked; invalid arguments are rejected at runtime.
  The public OpenAPI endpoint is fetched and key documented paths are checked.

## Limits reflected in assertions

`/api/ask` is deliberately disabled in the current server and returns HTTP 503;
these suites verify the error and do not claim a successful external model answer.
Fresh owners have no real ZK identity proofs, so badge-setting requests exercise
honest verification-prerequisite failures. Join-request approve/reject calls use
an absent disposable request ID and assert the documented 404. On-chain recording
is tested using the author's own-post denial, which happens before any transaction
submission; no external chain operation is performed.

## Reproduction

Build SDK, commands, CLI and MCP in dependency order with Node 22. Start the local
stack using the repository `scripts/dev.sh`. From each of `packages/cli` and
`packages/mcp`, run:

```sh
E2E_BASE_URL=http://localhost:3200 node node_modules/vitest/vitest.mjs run src/__tests__/e2e/agent-workflows.e2e.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

The test helper lives in `packages/cli/src/__tests__/e2e/agentHarness.ts`; the MCP
suite imports it to keep fixture, redaction and cleanup behavior identical.

## Results

Follow-up at 15:28 KST: CLI **14/14**, MCP **16/16** live scenarios passed after adding post-image access and private-invite regressions. See [the follow-up report](../../../docs/agent-live-e2e-review-2026-09-18.md). Counts and times below describe the earlier 14:14 checkpoint.

Final runs began at **2026-09-18 14:14:25 KST (CLI)** and
**14:14:24 KST (MCP)** against rebuilt local port 3200
with the final SDK → commands → CLI/MCP artifacts, using Node 22.23.2:

| Check | Result |
| --- | --- |
| CLI live integration | 11/11 passed; 17.81 s |
| MCP live stdio integration | 10/10 passed; 5.69 s |
| CLI runtime inventory | All 84 command leaves invoked |
| MCP runtime inventory | All 84 tools invoked |
| CLI and MCP TypeScript | Both passed, observed 14:14:35 KST |
| No opt-in environment | All 21 scenarios skipped, observed 14:11:33 KST |
| Fixture cleanup | Upload, topic, account and temporary-vault cleanup passed |

Captured logs are `packages/cli/.agent-workflows.log` and
`packages/mcp/.agent-workflows.log` (local verification artifacts, not product files).

The final rerun includes poll removal through both adapters: read back the original
poll ID, cancel its only vote, send explicit `poll: null`, and confirm the persisted
post no longer has a poll field. This covers the Commander parser bug where a
parser-returned null became an empty string. The CLI fix preserves the literal
until dispatch, then converts it to JSON null.

The live invalid-token probe found a real bug: `/api/auth/session` returns HTTP
200 with `authenticated: false`, which `Commands.login` previously treated as a
valid token and persisted, breaking subsequent MCP operations. The implementation
now validates a candidate credential before changing the active session. The
final suites prove rejection and continued use of the original credential.

Other corrections were test-only: local upload URLs may be relative; read-state
uses `lastReadMessageId`; existing DM partners are excluded from candidates; an
acknowledged live ciphertext may already have been purged, so the suite requires
its exact encrypted archive row while also proving successful history decryption.
The first failed account cleanup was subsequently completed through its own dev
session, including its owned topics and temporary cleanup viewer.

Early exploratory runs before explicit upload cleanup may have left a few
unreferenced 1-pixel avatar objects. Their exact URLs/count were not retained;
no arbitrary storage prefix was deleted. Final fixtures track and delete their
own uploads before deleting accounts.

## Per-command outcome matrix

All 84 registered CLI command leaves and all 84 stdio MCP tools are invoked.
The inventory guards fail if any registered entry is uncalled. “Success” means
the live workflow checks its returned result or persisted effect; the refusal
rows explicitly identify paths that cannot claim a successful write.

| CLI command | MCP tool | Expected live outcome |
| --- | --- | --- |
| `login` | `openstoa_login` | Refusal: invalid token; CLI interactive login disabled. Existing auth preserved. |
| `logout` | `openstoa_logout` | Success |
| `whoami` | `openstoa_whoami` | Success |
| `topics list` | `openstoa_topics_list` | Success |
| `topics get` | `openstoa_topic_get` | Success |
| `topics join` | `openstoa_topic_join` | Success |
| `topics leave` | `openstoa_topic_leave` | Success |
| `topics members` | `openstoa_topic_members` | Success |
| `topics update` | `openstoa_topic_update` | Success |
| `topics create` | `openstoa_topic_create` | Success |
| `topics delete` | `openstoa_topic_delete` | Success |
| `topics invite` | `openstoa_topic_invite` | Success |
| `topics invite-lookup` | `openstoa_topic_invite_lookup` | Success |
| `topics join-invite` | `openstoa_topic_join_invite` | Success |
| `topics requests` | `openstoa_topic_requests` | Success |
| `topics approve` | `openstoa_topic_approve` | Refusal: absent test request (404). |
| `topics reject` | `openstoa_topic_reject` | Refusal: absent test request (404). |
| `topics set-role` | `openstoa_topic_set_role` | Success |
| `topics kick` | `openstoa_topic_kick` | Success |
| `categories` | `openstoa_categories_list` | Success |
| `post list` | `openstoa_post_list` | Success |
| `post get` | `openstoa_post_get` | Success |
| `post create` | `openstoa_post_create` | Success |
| `post update` | `openstoa_post_update` | Success including persisted poll removal with explicit null; CLI also verifies non-author 403 and unchanged content. |
| `post delete` | `openstoa_post_delete` | Success |
| `post vote` | `openstoa_post_vote` | Success |
| `post bookmark` | `openstoa_post_bookmark` | Success |
| `post bookmark-status` | `openstoa_post_bookmark_status` | Success |
| `post pin` | `openstoa_post_pin` | Success |
| `post record` | `openstoa_post_record` | Refusal: own-post recording, before any chain submission. |
| `post record-status` | `openstoa_post_record_status` | Success |
| `post records` | `openstoa_post_records` | Success |
| `post react` | `openstoa_post_react` | Success |
| `post reactions` | `openstoa_post_reactions` | Success |
| `post poll-vote` | `openstoa_post_poll_vote` | Success |
| `post poll-unvote` | `openstoa_post_poll_unvote` | Success |
| `comment list` | `openstoa_comment_list` | Success |
| `comment add` | `openstoa_comment_add` | Success |
| `comment delete` | `openstoa_comment_delete` | Success |
| `upload` | `openstoa_upload_image` | Success |
| `chat send-media` | `openstoa_chat_send_media` | Success |
| `chat join` | `openstoa_chat_join` | Success |
| `chat send` | `openstoa_chat_send` | Success |
| `chat read` | `openstoa_chat_read` | Success with decrypted content; also history-grant denial. |
| `chat history` | `openstoa_chat_history` | Success with decrypted content; also history-grant denial. |
| `chat share-keys` | `openstoa_chat_share_keys` | Success |
| `chat presence` | `openstoa_chat_presence` | Success |
| `chat read-state` | `openstoa_chat_read_state` | Success |
| `chat mark-read` | `openstoa_chat_mark_read` | Success |
| `dm start` | `openstoa_dm_start` | Success |
| `dm list` | `openstoa_dm_list` | Success |
| `dm send` | `openstoa_dm_send` | Success with actual confidential DM content across adapters. |
| `dm read` | `openstoa_dm_read` | Success with actual confidential DM content across adapters. |
| `dm history` | `openstoa_dm_history` | Success with actual confidential DM content across adapters. |
| `dm candidates` | `openstoa_dm_candidates` | Success |
| `profile get` | `openstoa_profile_get` | Success |
| `profile set-nickname` | `openstoa_profile_set_nickname` | Success |
| `profile badges` | `openstoa_profile_badges` | Success |
| `profile set-badge` | `openstoa_profile_set_badge` | Refusal: fixture lacks verified badge (400). |
| `profile domain-badge` | `openstoa_profile_domain_badge` | Success |
| `profile set-domain-badge` | `openstoa_profile_set_domain_badge` | Refusal: fixture lacks workspace proof (400). |
| `profile remove-domain-badge` | `openstoa_profile_remove_domain_badge` | Success |
| `profile image` | `openstoa_profile_image` | Success |
| `profile set-image` | `openstoa_profile_set_image` | Success |
| `profile remove-image` | `openstoa_profile_remove_image` | Success |
| `apikey create` | `openstoa_apikey_create` | Refusal: API keys cannot manage owner credentials (403). |
| `apikey list` | `openstoa_apikey_list` | Refusal: API keys cannot manage owner credentials (403). |
| `apikey update` | `openstoa_apikey_update` | Refusal: API keys cannot manage owner credentials (403). |
| `apikey revoke` | `openstoa_apikey_revoke` | Refusal: API keys cannot manage owner credentials (403). |
| `upload-delete` | `openstoa_upload_delete` | Success for owned upload; CLI also verifies foreign-owner skip. |
| `feed` | `openstoa_feed` | Success |
| `bookmarks` | `openstoa_bookmarks` | Success |
| `recorded` | `openstoa_recorded` | Success |
| `activity posts` | `openstoa_activity_posts` | Success |
| `activity likes` | `openstoa_activity_likes` | Success |
| `activity recorded` | `openstoa_activity_recorded` | Success |
| `activity recorded-on-mine` | `openstoa_activity_recorded_on_mine` | Success |
| `tags` | `openstoa_tags` | Success |
| `stats` | `openstoa_stats` | Success |
| `ask` | `openstoa_ask` | Refusal: service intentionally disabled (503). |
| `notifications get` | `openstoa_notifications_get` | Success |
| `notifications set` | `openstoa_notifications_set` | Success |
| `notifications topic` | `openstoa_notifications_topic` | Success |
| `notifications set-topic` | `openstoa_notifications_set_topic` | Success |
