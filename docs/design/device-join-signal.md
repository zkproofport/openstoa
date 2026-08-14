# How the server learns when a device joined a topic

Status: **decided; steps 1-2 built** (D-1 / task #73). Step 3 waits on R-1 (#52) closing. Written before implementation
because getting it wrong makes a purge delete something a device was owed.

## The problem

Two holes share one missing fact.

**Delivery obligation (R-1).** `chat_messages.ciphertext` is a delivery queue: the
server drops a message's live copy once every device that was in the group at send
time has fetched it. Today a device's obligation window starts at its **first ack**,
because that is the only evidence the server has that the device exists — the ratchet
tree is client-side and the server runs no MLS crypto (C1/SI-1). So a member device
that is added and then does not open the topic is not owed the messages sent
meanwhile. It can still read them from `chat_archive`, so this is a degradation and
not a loss, but on `private`/`secret` the archive row needs a per-epoch TAK, which
depends on that device having received a bundle.

**Inactive-leaf pruning.** A device that abandons a leaf (browser data cleared, app
deleted) never acks again. R-1 does the half a server can do — a stale device stops
*blocking* a purge — but evicting the leaf needs a Remove Commit, which only a client
can issue. Deciding "this leaf is abandoned" needs the same pair of facts: when it
joined, and when it was last alive.

## What was measured

Not reasoned about — run against the repo's own MLS core (`groupClient.ts`, ts-mls):

| Fact | Result |
|---|---|
| Wire format of a device's join (External Commit) | **1 = PublicMessage** — content is **not** encrypted |
| Content type | 3 = Commit |
| Joiner's leaf HPKE public key present verbatim in the commit bytes | **yes**, at offset 77 of 539 |
| Wire format of an ordinary Commit (e.g. Remove) | 2 = PrivateMessage — content encrypted |

And, from the source:

- `groupClient.joinTopicGroup` encodes the join as `wireformat: 'mls_public_message'`.
- **No human client publishes a KeyPackage.** The directory (`device_key_packages`)
  is used only by AI bot members (`aiMember.ts`, `isLastResort: true`), and
  `botSelfJoin` also joins by External Commit. Every join today is an External Commit.
- `leafDeviceId(hpkePublicKey) = base64(hpkePublicKey)` — the id already used by the
  TAK bundle routes and by `chat_delivery_cursors`.

## The decision

**Derive the join from the External Commit the server already stores** in
`mls_commits.commit`: parse the PublicMessage framing it already parses for epoch-CAS,
walk to the joiner's LeafNode, and take its HPKE public key as the device id. Record
`(topic_id, device_id, joined_at, joined_epoch)`.

Why this one:

- **No crypto.** The bytes are in the clear; this is structural parsing, the same
  class of work `framing.ts` already does for SI-2. C1 is preserved.
- **Nothing to trust.** The commit *is* the act of joining. Another member cannot
  fabricate a device's join without actually adding that device — unlike a
  client-reported join, which R-1 already had to defend against for device ids
  (`chat_delivery_cursors.user_id` binds an id to its first claimant for that reason).
- **No new client code**, so it cannot be defeated by an old client that never learned
  to report.
- **It is the same identifier** the delivery cursor already keys on, so the join row
  and the ack row are the same device rather than two rows, one of which would block
  purging forever.

## What was rejected, and why

**Parse Add proposals out of ordinary Commits.** Impossible without crypto: ts-mls
emits handshakes as PrivateMessage, so the proposal list is encrypted. Measured above.

**Match the Welcome's `KeyPackageRef` against the stored KeyPackages.** The refs are in
the clear, but matching one requires computing `RefHash` with the ciphersuite's hash —
crypto over public bytes, ciphersuite-dependent, and fragile. It also only covers
Add-by-Welcome, which no current path uses.

**Record the topic when a KeyPackage is consumed.** Attractive — the topic is already
in the consume route's URL — but it misses every human device, because humans never
publish a KeyPackage. It would also miss AI last-resort packages, which are returned
without being marked consumed.

**Have the client report its own join time.** Simplest, and the weakest: it is a claim,
it needs new code in three clients, and a member could assert a join that did not
happen. (Its failure mode is at least benign — an over-stated obligation delays a purge
rather than losing a message — which is why it stays the fallback if parsing proves
unstable.)

## The condition under which this breaks

If a path is ever added that joins a device by **Add + Welcome** instead of External
Commit, this signal silently misses those devices — they would be owed nothing until
their first ack, i.e. exactly today's behaviour, so the failure is a return to the
status quo rather than data loss. The parse also depends on the LeafNode's position in
the PublicMessage → FramedContent → Commit → UpdatePath chain, which is a wire-format
dependency on ts-mls. Both must be pinned by a test that generates a **real** commit
with the same library and asserts the extracted device id equals
`leafDeviceId(leaf.hpkePublicKey)` — the same empirical approach `framing.ts` documents.

## What the parse also yields, measured after the decision

The same cleartext holds the leaf's **credential** — `<userId>:<deviceId>` — at
offset 144 of a 539-byte join commit. So the record carries the account as well as
the device, which is what an eviction path needs and what the delivery cursor's
binding could not supply for a device that has never read chat. Two limits, both
load-bearing:

- A credential that does not name an account (an agent leaf minted as a bare
  `sdk-<uuid>`) yields the raw identity and a **null** account. Null therefore
  means "nobody could name this leaf", never "not looked up yet" — a caller that
  guessed an owner here would evict an innocent member.
- A device that clears storage and **re-joins mints a new leaf key**, so it takes a
  new row rather than colliding on the primary key. Measured, because a collision
  inside a fire-and-forget insert fails silently and the re-join would go unrecorded.

## The topic's creator has no join commit — decided

`createTopicGroup` calls `createGroup`, not a commit: the creator's leaf is in the
group from genesis. So **the creator is structurally absent from `mls_device_joins`**,
and always will be. Found by `archive-retention` while checking something else.

This has to be decided rather than noted, because step 3 hands the obligation window
to this table and **both readings of an absent row are wrong**:

- *absent means not owed* — the creator silently stops being owed messages in their
  own topic, and their live copies are purged out from under them;
- *absent means blocked* — every topic has a creator, so no topic could ever purge
  anything and the feature is dead on arrival.

**Decision: the join row REFINES the obligation window, it does not define it.**
Step 3 computes a device's window start as

    COALESCE(join.joined_at, cursor.first_seen_at)

so a device with a join row is owed messages from the moment it joined, and a device
without one falls back to the moment it first acknowledged — which is exactly R-1's
behaviour today. Three reasons this is the right shape rather than a patch:

1. **Absence carries no meaning.** Neither bad default is ever consulted, so the
   question that made this a decision does not arise at the SQL level.
2. **The failure mode is the status quo.** Any device the parse misses — the
   creator, a device added by a path this design has not met, a commit the parser
   refuses — degrades to first-ack discovery. Nothing is lost that is not already
   being lost today.
3. **It needs no second parse.** Extracting the creator's leaf from the genesis
   `GroupInfo` is possible in principle (our config carries the ratchet-tree
   extension) but it is a different wire format, a second empirical dependency on
   ts-mls, and it would buy only the creator.

**And the creator must not become the device that pins every message.** They are the
one member guaranteed to hold every epoch from the beginning, so an obligation window
starting at genesis would make them owed *everything* forever. Under the rule above
they are not: their window starts at their first acknowledgement, and the staleness
floor and the grace cap apply to them exactly as to anybody else.

## The library-bump guard — how to verify it, and why the outcome is not obvious

Owned here (the our-code half — no `wireAsPublicMessage`, no Add proposal — is a
static assertion over the three twinned `groupClient.ts` copies and is owned by
`archive-retention`, so neither test's green covers the other's failure).

The reasoning this parser rests on is currently sound for three independent
reasons, and they can fail independently:

1. `ts-mls` `createCommit` defaults to `mls_private_message`, so a member's commit
   is encrypted (`createCommit.js:28`).
2. A member cannot create an External Commit even deliberately — the library throws
   `Cannot create externalCommit as a member` (`createCommit.js:33`).
3. This codebase has no Add-path join at all: zero `proposalType: 'add'` across
   `src/lib/mls`, `packages/sdk/src/mls` and `packages/mobile/src/crypto`, and even
   the AI member self-joins.

**The test to write when a machine is available:** force an Add-path commit into
readable framing (`createCommit` with an Add proposal and `wireAsPublicMessage:
true`) and feed it to `parseJoinerLeaf`.

**Do not assume it refuses.** Two outcomes, and they mean different things:

- **It returns null** — the parser is structurally incapable of reading an
  Add-path commit, the poster-is-the-joiner property holds by construction, and
  the test simply pins that.
- **It returns a leaf** — then the leaf it found is the COMMITTER's UpdatePath
  leaf, not the joiner's, because an Add proposal carries the new member's
  KeyPackage while the path carries the committer's own new key. That would mean
  a poster-derived account binding attaches the ADDER to the ADDED device: a
  confident wrong answer, and the thing an eviction path would act on. In that
  case the binding needs a discriminator (does the commit carry an Add proposal
  at all?) before it can ship, and the test asserts the discriminator rather than
  the refusal.

Writing the assertion before running it would enshrine whichever of those I
guessed. It is a measurement, not a formality.

**The fixture CONSTRUCTS a scenario the product does not have** — our code cannot
produce an Add-path commit — so it will read as dead code to the next person. The
test must say so, or it gets deleted in a cleanup and takes the guard with it.

## Build order

1. ~~Extend the framing parser to return the joiner's leaf key for a PublicMessage
   Commit, with the real-commit test above.~~ **Done** — `parseJoinerLeaf` /
   `parseJoinerLeafKey` in `src/lib/mls/framing.ts`, 12 tests against real commits.
2. ~~Record `(topic, device, joined_at, joined_epoch)` on the commit route.~~
   **Done** — `mls_device_joins` + `src/lib/mls/deviceJoins.ts`, recorded
   fire-and-forget from an ACCEPTED commit only. The epoch stored is the one that
   ADMITS the device, not the one the commit asserted: the other way places the
   join an epoch early, inside a window it cannot read. The statement's behaviour
   against real Postgres is UNRUN (the local database is down — host disk full).
3. Point R-1's obligation window at `COALESCE(joined_at, first_seen_at)` — one
   predicate in `chatDeliveryPurge.ts`, whose boundary tests already exist. See the
   creator decision above for why it is a COALESCE and not a replacement.
4. Expose "leaves that joined and went quiet" so a client can drive the Remove Commit.
   Pruning itself stays a client action; the server only supplies the two dates.
