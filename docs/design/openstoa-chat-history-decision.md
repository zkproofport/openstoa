# Chat history for members who join later — decision

**Status:** decided, 2026-08-14
**Supersedes:** the archive-availability tiering in `openstoa-e2ee-chat-design.md` §SI-6 / SI-6b
**Decision:** how a later joiner gets history now depends on the tier, and in no tier does it depend on another member being online.

---

## What went wrong

A member joined a public topic and its history never opened. Not slowly — never. Server logs for topic `43cf3b96`:

```
12:33–12:36   messages sent, archive rows written, POST /tak/bundles ×4
14:24:45      POST /mls/commit 201          ← the new device joins the group
14:24:46      DELETE /tak/holder            ← it holds no root, so it releases the lease
14:24:47…     root-fingerprint / bundles / archive, polled every few seconds
              POST /tak/bundles → none
```

Nobody handed the new device the key. Handing it over requires a member who *has* the key to be online **and** to have that chat room open; the session that distributed at 12:35 had closed. Re-entering does not create a distributor, so the spinner ran forever.

Two things were wrong at once:

1. **The implementation was narrower than the design.** SI-6 accepts breakage when every holder is *gone*. "Gone" is not "looking at another screen", and distribution only ran from an open chat room.
2. **The design's own limit is worse than it sounds.** Even with distribution widened, history would still depend on somebody else being awake at the right moment — a property no reader can predict, while the UI claimed "arriving shortly" for a state that could last forever.

The fix is not to widen the holder mechanism. It is to stop making one member's availability a precondition, tier by tier.

## What other messengers actually do

Checked rather than recalled, because an earlier draft asserted both from memory and was half wrong.

- **Signal** gives new group members no previous messages at all. New participants cannot decrypt them, and the feature request to change it has been open for years.
  ([Signal Support](https://support.signal.org/hc/en-us/articles/360007319331-Group-chats), [feature request](https://community.signalusers.org/t/message-history-for-new-group-chat-members/3679))
- **WhatsApp** did the same until **20 February 2026**, when "Group Message History" shipped: the person adding someone may share the **last 25–100 messages**, still end-to-end encrypted, with a notification to the whole group and an admin switch to disable it.
  ([WhatsApp blog](https://blog.whatsapp.com/introducing-group-message-history-a-more-private-way-to-catch-up-in-group-chats), [GSMArena](https://m.gsmarena.com/whatsapp_introduces_new_group_message_history_feature-news-71641.php))

Neither of them makes history depend on who happens to be online. That is the part we were getting wrong, independent of how much history we choose to share.

## The decision

| Tier | History for a later joiner | How the key reaches them | Can the server read chat |
|---|---|---|---|
| `public` | **All of it** | the archive root is **held by the server** | **Yes** |
| `private` | **The last N messages, if the inviter shares them** | the epoch TAKs covering those N travel **in the invite link fragment** | No |
| `secret` | **The last N messages, if the inviter shares them** | same as `private` | No |
| DM | n/a — there is no later joiner | one topic root, handed over when the request is accepted | No |

And, in **every** tier: **your own other devices get your own history**, restored from your personal backup. That path needs nobody else online — it decrypts your keychain with your `master_key` — and it is the half of the original design worth keeping (§6.4.1 "다른 멤버 온라인 불필요").

### Why each tier lands where it does

**`public` — the server holds the key.** Anyone may join a public topic, so its history is not secret from the public; it is secret only from the operator. Paying for that with "history is unreadable unless someone else is online" is a bad trade. The archive stays sealed exactly as it is today — what changes is that a copy of the root lives on the server, so a later joiner reads history the moment they arrive.

This is the one tier where the product must stop claiming the server cannot read chat. The banner has to say something true here.

**`private` and `secret` — the same rule.** Chat is members-only in every tier: `GET /api/topics/{id}/chat` answers 403 to a non-member regardless of visibility. So a private topic's *conversation* is not public even though its *posts* are, and a member who is removed should stop being able to read it. That is what per-epoch keys buy, and it is why these two tiers share one rule rather than `private` taking the simpler topic-root route.

The key travels in the invite link. A URL fragment (`…/join/abc123#k=…`) is **never sent to the server** by a browser, so the inviter's client puts the epoch keys after the `#` and the server stores only the token. The invitee reads their window at once — no holder online, server still unable to read anything.

Two honest costs:
- **Whatever carries the link sees the key.** Send an invite over KakaoTalk and Kakao sees that string, fragment included. The server does not; the messenger does.
- **A leaked link is a leaked window.** Bounded to N messages, which is what stops a leak from being the whole archive — and why invite tokens are single-use, expiring, and the expiry is the admin's to set.

**The bounded window, WhatsApp's shape.** Neither tier hands over a key to everything: per-epoch TAKs exist precisely so that removal removes access, and one shared root would undo that (design SI-6b — a standing custodian is member-held escrow).

What makes a bounded window work is that the keys are per EPOCH, not per message. The last N messages span however many epochs the room happened to advance through, usually one; so "the last N messages" is a handful of keys, which fits in a link, and the link cannot grow without limit the way a whole-history payload would.

Following WhatsApp rather than inventing something:

- the **inviter chooses** to include history — it is not automatic
- the window is **bounded**: default `INVITE_HISTORY_DEFAULT` messages, never more than `INVITE_HISTORY_MAX`
- the **topic is notified** that history was shared, and by whom — the group finds out, the same way WhatsApp posts it
- an **admin switch** can forbid history sharing for the topic entirely
- shared messages are **visually distinct** from ones that arrived live

Without that opt-in, a member sees the conversation from the moment they join.

**DM — one root, no epochs.** Two people, both present from the start: nobody joins later and nobody can be removed, so the two things per-epoch keys buy are both worth nothing here. A DM keeps one topic root, handed over when the request is accepted, and the only reason it has an archive at all is so the conversation follows the reader to their own other devices.

So the epoch machinery serves `private` and `secret`; `public` and DM each need a single root.

## What changes in the code

**Removed — the holder mechanism, in all tiers:**

- the archive-holder lease and its succession (`archive_holders`)
- distributing the archive root to other members' leaves for the purpose of history
- the waiting UI everywhere: the spinner, "your history is on its way", the locked-row placeholders. No tier waits on another member any more, so nothing should say it is waiting

**Added:**

- `topic_archive_roots` — the server-held root, **`public` topics only**
- the invite link carries the root in its fragment for `private` (and the client must never send that fragment to the server)
- creating a `private` invite requires the creator to actually hold the root — an invite with nothing to hand over is a broken link

**Kept:**

- the archive rows themselves (`archiveOnSend`) — they are the ciphertext your own key opens
- the personal TAK keychain backup (`tak_key_backups`, wrapped under `master_key`) and passkey recovery, in every tier
- per-epoch TAKs, for `private` and `secret`

**Changed:**

- a row this device cannot open is simply **not rendered** — no placeholder, no apology. The server cannot know which epoch keys a given client was granted, so it keeps returning what it has and the client shows what it can read. A `secret` member who was given the last 50 messages sees 50 messages and then the live conversation; one who was given none starts at their arrival. Either way the room reads as a conversation rather than as a wall of locks
- the chat banner is per tier: `public` says the service can read the room; `private`, `secret` and DM say the server cannot

## Removal has to actually remove

Per-epoch keys are the reason `private` and `secret` are not the simpler tier: they are what makes removing a member remove their access to what comes next. That only holds if removal advances the MLS epoch — and today it does not.

`DELETE /api/topics/{id}/members` does exactly two things:

```ts
await db.delete(topicMembers).where(...);            // the row
await broadcastMembershipSystemEvent(..., 'leave');  // the system message
```

No Remove Commit, so no new epoch, so the removed member can still derive the same epoch key. The only thing stopping them is the server refusing `/chat` and `/archive` to a non-member. That is a real barrier and an immediate one — but it is server-side access control, not cryptography, and the tier's whole justification was the cryptography.

The commit itself is already written and unused: `groupClient.removeMember(state, leafIndex)` produces exactly the Remove Commit needed, and its own comment says what it is for. Nothing was missing except the call.

**Kicking** works cleanly, because the person doing it is at the keyboard. The admin's client builds the Remove Commit and POSTs it to `/mls/commit`; the epoch advances immediately, and every remaining member picks it up on their next sync. The server moves the bytes and reads none of them.

**Leaving** cannot be self-contained. MLS does not let a member commit their own removal — the commit would have to be processed by the state it removes. So a leaver publishes the Remove *proposal* and the next member to commit anything carries it through, which means the epoch advances late.

| | MLS commit | Epoch advances | Server-side access |
|---|---|---|---|
| Kicked by an admin | the admin's client, immediately | **at once** | cut at once |
| Left voluntarily | proposal now, committed by whoever commits next | **delayed** | cut at once |

The delay is tolerable precisely where it happens: someone who chose to leave is not the threat model. The case that matters — a member being removed against their will — is the one that is immediate.

### Three doors out, and all three currently skip MLS

| Door | Server does | MLS today | UI today |
|---|---|---|---|
| Admin kicks a member | deletes the row | **nothing** | web ✅, mobile ✅ |
| Member leaves a topic | route exists | **nothing** | **web has none** |
| Member deletes their account | deletes every membership row | **nothing** | web ✅, mobile ✅ |

Account deletion is the widest of the three, because it is every topic at once:

```ts
await db.delete(topicMembers).where(eq(topicMembers.userId, userId));
```

The rows go; the group memberships do not. A deleted account can still derive the epoch key of every topic it belonged to, and if the person signs in again — `users.id` is the nullifier, so they come back as the same account — the keys are still sitting on that device.

**Account deletion is a soft delete.** The row survives with its nickname replaced by `[Withdrawn User]_<random>` and `deletedAt` set, because posts and comments reference it and hard-deleting would tear holes in other people's threads. Memberships and bookmarks are hard-deleted; owning a topic blocks deletion until ownership is transferred.

So deletion has to do three things it does not do now:

1. **Publish a Remove proposal in every joined topic**, so each group's epoch advances when someone next commits there
2. **Destroy the local keys** — the TAK keychain and MLS state on that device. Otherwise "I deleted my account" leaves the conversation readable on the machine it was read on, which is the one place the person expected it gone
3. **Leave the ciphertext alone.** `chat_messages` is not touched, matching what already happens to posts: the words stay, the identity does not. The rows show `[Withdrawn User]` to members and remain unreadable to the server

And one open question that deletion raises on its own: signing in again returns the same nullifier and therefore the same row, still named `[Withdrawn User]_…`. Whether a returning account keeps that name or is issued a fresh one is a product call, not a cryptographic one.



## Decrypting history: by the page, not all of it

Not previously decided, and therefore implemented by accident — the client walks the archive cursor **to completion** and decrypts **every row**, on **every poll tick**:

```ts
// getArchive today
for (;;) {
  fetch(`/archive?limit=500${cursor}`)
  if (page.length < 500) break;
}
```

A room with ten thousand messages downloads and decrypts ten thousand rows to show the fifty on screen, and does it again seconds later. Chat messages themselves are paged (`?limit=50`, `?before=`); only the archive is not, so the two disagree about how much work opening a room is.

**The rule:** decrypt what is on screen, and only when the keys have changed.

| | Today | Rule |
|---|---|---|
| Opening a room | whole archive | the rows behind the visible page |
| Scrolling up | already downloaded | that page's rows, on demand |
| Re-entering | whole archive again | painted from cache; nothing refetched |
| Poll tick | whole archive again | **nothing** unless a new key arrived |

The last row is the one that matters. A poll tick with no new key produces exactly the result it produced last time, so re-deriving it is pure waste — and it is the reason a quiet room still burns a request every few seconds today.

**Two caches, both already present in some form:**

- **plaintext by message id**, for the session. `paintCache` does this for the rendered list already; the archive path needs the same so re-entering a room is instant rather than a re-decrypt
- **keys**, in the local store — already persistent, so nothing needs re-deriving across restarts

**What the interface needs.** The cursor the route exposes is ascending from a point, which suits "catch up from where I was" and not "give me the newest fifty". The client knows exactly which message ids it is showing, so the archive should be fetchable **by id** for the page in hand — bounded by the page size, and the same shape as the question actually being asked.

## Tier model, whole

| | Join | Post list & detail | Post / chat | Chat history for a later joiner | Server can read chat |
|---|---|---|---|---|---|
| `public` | anyone | anyone | members | all | **yes** |
| `private` | invite token only | anyone signed in | members | a bounded window, if the inviter shares it | no |
| `secret` | invite token only | members | members | a bounded window, if the inviter shares it | no |
| DM | on accept | — | the two of them | n/a | no |

Two corrections to an earlier version of this table, both of which had it
disagreeing with §"The decision" above and with `chatTierPolicy.ts`:

- **History for `private` and `secret` is the same bounded window**, not "all"
  and "none". The window is what per-epoch keys buy, and both tiers use them —
  that is the whole reason `private` is not the simpler topic-root tier.
- **`private` post reads need a signed-in account**, not literally anyone: a
  guest gets 401. Signing in is the price of reading; membership is the price of
  the conversation.

## Numbers

The bound is counted in **epochs**, not messages. Counting messages was the first attempt — it is WhatsApp's unit — and it fails twice over here:

**It does not bound the link.** One key is 32 bytes, 43 base64 characters, and there is one key per epoch. "The last 50 messages" is one key in a quiet room and fifty in a room people keep joining: same promise, fifty times the link. A URL fragment gives out around 2 000 characters, so the message count cannot be the thing that keeps a link openable.

**It cannot be honoured.** Handing over an epoch's key opens **every** message in that epoch. Share "the last 50" out of an epoch holding five thousand and all five thousand are readable. The smallest unit this system can actually disclose is an epoch, so it is the only unit a promise can be made in.

| | Value | Why |
|---|---|---|
| `INVITE_HISTORY_EPOCHS_DEFAULT` | 3 epochs | Enough to pick up a thread in a room that has not churned |
| `INVITE_HISTORY_EPOCHS_MAX` | 20 epochs | ≈ 880 characters of fragment, comfortably inside any client |

The interface still speaks in messages, because that is what a person understands: the inviter picks how far back, and the screen shows what that actually came to — "the last 342 messages, since 12 August" — computed from the epochs being shared. A number we can honour, phrased in the unit the reader thinks in.

Neither number is a security boundary — a member could always paste the text — so they are chosen for how much context a new arrival needs, and to keep the invite link openable.

## What a "device" is

Not a machine. A **key store** — and the distinction decides who a message gets delivered to, who has to be removed to remove a person, and when a stored message may be dropped.

The identity is a random value we generate on the client and keep locally:

| | Generated | Kept in |
|---|---|---|
| Web | `crypto.randomUUID()` → `web-<uuid>` | `localStorage`, then `mls.identity` in the encrypted store |
| Mini-app | 8 random bytes → `mobile-<hex>` | host secure store (Keychain / Android Keystore) |

Nothing is read from the machine. **No MAC address, no `identifierForVendor`, no `ANDROID_ID`, no app id.** MAC addresses are unavailable to browsers and have been fake on both mobile platforms for years, so that door is shut anyway — but the vendor ids are available, and they are refused deliberately. They are stable per device *across accounts*, so two anonymous accounts used on one phone would be linkable by anyone reading the leaf. Building anonymity on a nullifier and then stapling a hardware id to it gives the whole thing away. A random per-install value tells the server nothing about the machine, and that is the point.

Consequences, which hold identically on every platform — this is a property of key stores, not of operating systems:

- **Chrome and Safari on one laptop are two leaves.** So are Chrome and Edge on Windows, and Safari and the app on one iPhone, and Chrome and the app on one Android phone. Neither side can read the other's private keys, so sharing a leaf between them is not merely undesirable, it is impossible.
- **Clearing site data abandons a leaf.** The browser comes back as a new one and reads its history through the archive — the same shape as unlinking and relinking Signal Desktop.
- Identity is stable across restarts on both clients. `mlsSession.ts` persists `mls.identity` on first use and reuses it thereafter, so the per-launch value in `mobileTransport.ts` is only a first-run seed. (An earlier reading of that file concluded a new leaf was minted on every app launch. It is not; the comment there is stale, the code is fine.)

An abandoned leaf is the thing to watch. It stays in the tree, never acknowledges anything again, and therefore blocks any rule of the form "once every member device has it" — see the retention section below. Evicting one needs a Remove Commit, which is the same machinery kick and leave are getting.

## Retention: the copy that should not survive delivery

Every other messenger checked here treats the server as a post box, not a warehouse. **WhatsApp** keeps an undelivered message encrypted for up to 30 days and deletes it on delivery; **Signal** queues per device, ephemerally, and drops it once delivered and decrypted; **Google Messages** queues for delivery and deletes after, keeping only media for 60 days. None of them retains delivered message ciphertext, which is precisely why none of them could show history to a later joiner without inventing a separate mechanism for it.
([WhatsApp](https://www.whatsapp.com/legal/privacy-policy), [Google Messages](https://support.google.com/messages/answer/9592174), [RCS for Business data security](https://developers.google.com/business-communications/rcs-business-messaging/terms-and-policies/data-security))

MLS itself asks for none of this. RFC 9750 gives the Delivery Service delivery duties — fan-out, Welcome, KeyPackage directory, and *buffering* of messages that arrive out of order, with "how many and how long" left as a per-deployment parameter. A permanent archive is not in the standard; the architecture even allows the DS to be abstracted away entirely in a peer-to-peer deployment. Our archive is a layer we chose to add, and it should be governed as one.
([RFC 9750](https://www.rfc-editor.org/rfc/rfc9750.pdf))

We hold two copies, and they should not share a fate:

| | What it is | On delivery |
|---|---|---|
| `chat_messages.ciphertext` | the delivery queue | **drop it** |
| `chat_archive.ciphertext` | the history layer | keep, under a retention policy |

Dropping the first costs nothing that is not already lost. A member added later gets no past-epoch secrets from MLS, so those rows were never readable by them in the first place; history reaches them through the archive, which is the entire reason the archive exists. A session where a topic's only device sent three messages and a second device joined afterwards demonstrated exactly this — the second device read them from the archive, because it could not have read them any other way.

Which makes the guard, not the rule, the part to get right:

> drop only when **delivered to every leaf present at send time** *and* **the archive row exists**

`archiveOnSend` is fire-and-forget and can fail. In a one-member topic the delivery half is true the moment the message is sent, so the archive check is the only thing between a failed upload and a message that is simply gone.

The archive needs a bound of its own. It is currently kept forever with no purge anywhere, which was not the intent — the plan called for retention (`openstoa-e2ee-chat-dev-plan.md` §Phase 3) and it was never built. It matters most for `public`, the one tier where the server holds the key: unbounded retention there means operator-readable data accumulating with no end date. The choice belongs to the topic admin at creation, and the tier explanation has to say plainly what a shorter window costs — a later joiner sees less.

## Media is not encrypted

Stated here because the tier banner is about to make a promise this breaks.

An image sent to chat is uploaded to `/api/upload` **as plaintext**. The server receives the raw bytes and demonstrably reads them — it decodes and re-encodes HEIC to JPEG — then stores the result in R2 behind a **public URL** that needs no authentication, and logs that URL next to the uploader's id. Only the URL *string* is sealed into the message.

So the picture in a `secret` room, or in a DM, is not end-to-end encrypted, in any tier. It is also never deleted: not when the message is deleted, not when the topic is.

The fix reuses what is already there rather than adding a scheme: encrypt the file on the client under a per-message key derived from the TAK — the same derivation the archive uses — upload the **ciphertext** blob, and carry the object id and key inside the sealed message body. The server then holds opaque bytes, deleting a message can delete its object, and R2 being public stops mattering.

Until that lands, the per-tier banner must either wait or say explicitly that it does not cover media. Video is not supported at all today — both clients offer images only and the upload route rejects any non-image content type — and it should not be added before this is fixed.

## How the keys reach a private or secret invite

The tier table says the archive key "travels in the invite link fragment". This is what that means and what it rests on.

A URL fragment — everything after `#` — is never sent to the server. Not in the request line, not in `Referer`, not in a log. So an invite link can carry the epoch keys for a bounded slice of history while the server issues the token beside them and never learns what went with it. That is the whole mechanism, and it is why these tiers can hand over their past without the operator being able to read a word of it.

What the fragment is NOT safe from is worth writing down beside it, because the link is as sensitive as the messages it opens: it lands in the recipient's browser history, and in whatever channel it was pasted into. Two things follow. The token beside it is single-use and expires, so the *join* half is revocable. And `stripInviteHistory()` exists for every place a link is displayed, logged or copied, because **the token can be revoked and the keys cannot** — a link in a screenshot or a support ticket should be reducible to the half that can be taken back.

The unit is the epoch, as everywhere else here: an epoch key opens every message in that epoch and nothing outside it, so it is the smallest thing this can honestly disclose. `INVITE_HISTORY_EPOCHS_MAX` (20) keeps the fragment near 900 characters, and the codec refuses to build a longer one rather than truncating — a silently cut link would leave the recipient with a keychain full of holes and nothing saying why.

Two rules in the codec are load-bearing and neither is obvious:

**A key must be exactly one key long.** "Looks like base64" is not enough, because a link cut short by a messaging app leaves a *prefix* of a key, and a prefix is still valid base64. Without a length check the truncated value is written into the keychain, opens nothing, and is indistinguishable from a key that was never shared. A test that cuts a real fragment mid-key found this before it shipped.

**A key that arrives in a link never REPLACES one already held.** The held key was derived from the group's own secret and is therefore right; the one in the URL came through a channel we do not control. Letting the arrival win is how a bad link turns readable history unreadable.

An inviter can only offer epochs they hold, which means a member who joined last week cannot hand over the month before it. That ceiling is a property of the keychain rather than a rule anyone enforces — the nicest kind, since there is nothing to get wrong.

`importInviteHistory` returns how many keys were NEW, because that is what the caller can honestly say. Opening the same link twice is not an error and shares nothing further, and "3 more epochs" on the second tap would be a lie that reads as the first tap having failed.

## Three copies, not two

Every shared rule in this design exists in more than one place, and each pair is bound by a test asserting the files are byte-identical: `src/lib/**` (web/server) and `packages/mobile/src/**` (mini-app).

The SDK was the copy nobody bound. Its MLS/TAK stack fell 667 lines and 17 methods behind — no media functions, no server-root resolution, no invite-history export — without a single red test, which is why an agent reading a chat received `openstoa:media:v1:{…}` where a person saw a photo. Agents are the point of this product; a member who cannot read what the room reads is a guest with a broken client.

So a shared rule now means **three** copies — web, mini-app, SDK — and the binding test names the missing methods rather than diffing bytes, because a 667-line diff is unreadable and a missing-method list is a task list.

The seam that must NOT be bound is the transport adapter: `webTransport.ts` (cookies) against `rest/transports.ts` (Bearer). That pair is correctly different, and confusing "shared rule" with "everything in the folder" would make the binding meaningless.

## Three ways this design kept breaking

Recorded because each cost real time and each recurred.

**A rule enforced in one place and silently absent in another.** The SDK drift above is the largest instance, but the same shape produced every twin test in this codebase. The fix is always the same: bind it with a test, and let the test name the work.

**A path written as a literal.** Moving `chat/{topicId}/…` to `topics/{topicId}/chat/…` broke code that BUILDS keys, code that MATCHES them, and code that BOUNDS them — and only the first kind is visible in a grep for the old string. Two authorization checks became permanently false (an uploader could no longer claim or delete their own attachment, so pictures vanished from live conversations an hour later), and a collector skipped every legacy row on every pass while reporting success. A literal is only safe where the assertion is "rejected".

**A mock looser than the server.** Three times: a stub returning a fixed object key instead of deriving it, an in-memory delivery service with no `/archive/root` route, and route tests with no storage at all. Each made a client look correct against something the real server refuses. Mocks should model the server's *refusals*, not just its successes.

**A fourth, added later: a test that was green without running.** Three variants surfaced in a single morning. The default vitest config excludes `**/__tests__/e2e/**`, so handing it an e2e path runs nothing and still prints a pass. `hasDb()` gates on `E2E_STAGING_DB_URL` while the setup example documented only `DATABASE_URL`, so DB-backed cases skipped silently for seven weeks — including two that failed the first time they ever executed. And a `describe.skip` carried a reason ("private topics cannot be created, `POST /api/topics` returns 400") that had stopped being true, putting 47 tests to sleep; the same sentence had spread to two more files, and in one of them it had bent the code, seeding a fixture with a raw `INSERT` that produced a topic shape the real endpoint cannot create. A skipped case and a passing case are indistinguishable in a summary line, which is what makes this class expensive: nothing looks wrong.

## What the delivery queue still cannot reclaim

Two limits survive R-1, and both are recorded rather than hidden because each is the kind of thing a future reader will otherwise rediscover as a bug.

**A device is discovered at its first acknowledgement, not at its join.** This is the older of the two, and D-1 exists to close it: an accepted External Commit is a PublicMessage, so the joining leaf can be read out of bytes the server already stores, and `mls_device_joins` records it. Until that table is consulted by the purge itself, a member device added to a group that never opens the topic is not counted as owed the messages sent meanwhile — the other devices acknowledge them and the live copies go. Nothing is lost; that device reads from the archive. On `private`/`secret` the archive row opens with a per-epoch TAK, so it depends on that device having a bundle or grant for those epochs, which is a degradation rather than a loss.

**A millisecond of resolution the API cannot express.** `chat_messages.created_at` is `timestamptz` at microsecond resolution; the `createdAt` a client receives has been through JSON at millisecond resolution. A client that acknowledges `through` = the value it was given sends a timestamp up to 999µs *before* the true column value, and `delivered_through < created_at` still counts that device as owing the message. No client can do better, because the API never exposes the precision it would need. The effect is bounded and one-directional: in an otherwise idle room the single newest acknowledged message stays pinned until a strictly later message arrives, or the 30-day cap fires. It fails safe — nothing is purged early, storage is reclaimed late — which is why the guard was left alone and only the test was taught to acknowledge a millisecond past its target. The real fix is to stop storing precision the API cannot return: truncate `created_at` to milliseconds on write, so the value a client echoes back is exactly the value stored.

## The gate has no key on two surfaces

Encrypting chat media solved the tier promise. Gating *post* and *profile* images — so the bucket can stop being world-readable — introduced a different problem, and it is invisible while the bucket is still public.

`GET /api/media/{key}` decides authorization from the session. Two surfaces cannot present one.

The **mini-app** authenticates with a bearer token and explicitly sets `credentials: 'omit'`, for a reason worth preserving: a stale iOS cookie outlived logout and made signed-out users look authenticated. Every remote image renders as `<Image source={{ uri }}>` with no headers, so a gated read arrives with neither cookie nor token.

The **web** runs on two hostnames that both serve users, and the session cookie is set without a `Domain`, making it host-only. `R2_PUBLIC_URL` is a single value, so whichever host it names, users on the other one load images cross-site with no cookie.

The same fact defeats the obvious infrastructure answer. Repointing the media hostname at a proxy does not help: a host-only cookie is never sent to a different registrable domain, and a proxy cannot inject a credential the browser already declined to attach. The alternatives — passing the token as an image header, serving root-relative URLs, or signing the URL per viewer — differ in which of the two surfaces they fix, and only the last covers both plus a plain `<img>`. See `gated-image-credentials.md`.
