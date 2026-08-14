/**
 * THREE copies of the MLS/TAK crypto, bound to each other.
 *
 * `src/lib/mls/*` (web), `packages/mobile/src/crypto/*` (mini-app) and
 * `packages/sdk/src/mls/*` (the agent SDK) are the same code. The first two have
 * been kept identical by hand; the third was not bound to anything, and drifted
 * **667 lines and 14 methods** behind without a single red test — `openMedia`,
 * `sealMedia`, the whole public-root path (`getServerRoot`, `putServerRoot`,
 * `archiveRootState`, `publicRootFingerprint`, `getRootFingerprint`,
 * `setRootFingerprint`, `forgetUnsettledRoot`,
 * `distributePublicRootWhenGroupChanged`), the invite-history transfer
 * (`exportInviteHistory`, `importInviteHistory`), `backfillMissingArchive` and
 * `diagnoseKeychain`.
 *
 * What that cost: an AI member holding a topic's epoch TAK still cannot read an
 * attachment, because its client has no `openMedia` to decrypt with — it
 * receives the literal envelope `openstoa:media:v1:{…}` where a person sees a
 * photo. OpenStoa exists to host agents alongside humans (CLAUDE.md); an agent
 * that cannot read what a person in the same room reads is not a member of it.
 *
 * THE POINT OF THIS FILE IS THE BINDING, NOT THE PORT. The port is a one-off;
 * the binding is what makes this the last time. Written FIRST, deliberately red,
 * so the failure is a fact on the record before any content moves.
 *
 * Adding a shared rule now means THREE copies. Bind all three or the odd one out
 * is the next `openMedia`.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   contract          → 'all three copies are byte-identical' per file; and a
 *                       named-method diff so a failure says WHICH methods are
 *                       missing rather than "files differ" over 667 lines
 *   result integrity  → 'the import specifiers match', so byte-identity is a
 *                       reachable target rather than a wish — the three copies
 *                       resolve the same sibling names
 *   boundary          → each of the three pairings asserted separately, so a
 *                       failure names the copy that drifted
 *   hostile / UTF-8 / large / authz / race → N/A: this file reads three source
 *                       files off disk and compares bytes.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

/** The files that must be identical, and where each copy lives. */
const TWINNED = [
  {
    name: 'takSession.ts',
    web: 'src/lib/mls/takSession.ts',
    mobile: 'packages/mobile/src/crypto/takSession.ts',
    sdk: 'packages/sdk/src/mls/takSession.ts',
  },
  {
    name: 'takClient.ts',
    web: 'src/lib/mls/takClient.ts',
    mobile: 'packages/mobile/src/crypto/takClient.ts',
    sdk: 'packages/sdk/src/mls/takClient.ts',
  },
  {
    /*
     * The attachment envelope AND the object-key builder. Bound here because
     * M-3 moved that key shape once already: a fourth hand-written copy in the
     * SDK is how `topics/{topicId}/chat/…` becomes two different strings, and
     * the one that stops matching is whichever nobody tested that day.
     */
    name: 'chatMedia.ts',
    web: 'src/lib/chatMedia.ts',
    mobile: 'packages/mobile/src/lib/chatMedia.ts',
    sdk: 'packages/sdk/src/chatMedia.ts',
  },
  {
    /*
     * Who a leaf belongs to. Bound because the SDK did not have this file AT
     * ALL, so an agent's leaf was minted as a bare `sdk-<uuid>` with no
     * `<userId>:` part — and `userIdOfLeaf` returns null for that BY DESIGN,
     * since a leaf nobody can name belongs to somebody and guessing would evict
     * an innocent member.
     *
     * The consequence was not theoretical. `reconcileMembership` — the only
     * kick path any product surface calls — counts an unattributable leaf and
     * deliberately leaves it in the tree, so removing an AI member deleted its
     * membership row and left it deriving every future epoch key.
     */
    name: 'leafIdentity.ts',
    web: 'src/lib/mls/leafIdentity.ts',
    mobile: 'packages/mobile/src/crypto/leafIdentity.ts',
    sdk: 'packages/sdk/src/mls/leafIdentity.ts',
  },
  {
    /*
     * The device master_key and the at-rest store built on it. The SDK copy was
     * 61 lines behind: no `RETIRED_KEY_STORE_KEY`, no `loadRetiredMasterKey`,
     * and `EncryptingKVStore.lazy` without its `rootStore` argument, so no
     * read-time fallback and no opportunistic re-seal.
     *
     * What that costs the moment an SDK agent can recover: everything local —
     * MLS group state, cached plaintexts, TAK keys — is sealed under
     * HKDF(master_key), and `EncryptingKVStore.get` reports an unopenable value
     * as ABSENT. Swapping the key therefore does not error; it makes the device
     * silently forget its own group state and archive keys. The web copy fixed
     * exactly this for people. Binding is what stops the SDK rediscovering it.
     */
    name: 'keyManager.ts',
    web: 'src/lib/mls/keyManager.ts',
    mobile: 'packages/mobile/src/crypto/keyManager.ts',
    sdk: 'packages/sdk/src/mls/keyManager.ts',
  },
  {
    /*
     * Identical in all three trees TODAY — by luck, not by a test, which is
     * precisely the state `takSession` was in before it fell 667 lines behind.
     * An unbound file that happens to match is one edit away from the drift
     * this file exists to prevent, and binding a file that already matches
     * costs nothing but the line below.
     */
    name: 'keyBackup.ts',
    web: 'src/lib/mls/keyBackup.ts',
    mobile: 'packages/mobile/src/crypto/keyBackup.ts',
    sdk: 'packages/sdk/src/mls/keyBackup.ts',
  },
  {
    /* Identical in all three today. Bound for the same reason as keyBackup. */
    name: 'aiMember.ts',
    web: 'src/lib/mls/aiMember.ts',
    mobile: 'packages/mobile/src/crypto/aiMember.ts',
    sdk: 'packages/sdk/src/mls/aiMember.ts',
  },
] as const;

/**
 * Files bound web ↔ SDK only, because the mini-app copy is a real platform
 * variant rather than a drifted twin.
 *
 * This is the "declare" half of the answer, and it is deliberately narrow: the
 * mini-app is exempt from BYTE-identity and is NOT exempt from having the same
 * method surface. That second assertion is the one that bites — it is exactly
 * what caught the SDK missing `openMedia` and `removeMembers`. A mini-app copy
 * that quietly loses `reconcileMembership` still goes red here.
 *
 * Naming the reason is the point. An unbound copy with no note is what produced
 * this whole class of bug: the next person cannot tell "deliberately different"
 * from "nobody looked".
 */
const WEB_SDK_ONLY = [
  {
    /*
     * The group operations. The SDK was missing `leafIdentities`,
     * `findLeafIndicesByUser` and `removeMembers` — the three the removal path
     * is built out of — and carried an OLDER `findLeafIndexByIdentity` that
     * matched credentials inline instead of going through `leafIdentities`.
     */
    name: 'groupClient.ts',
    web: 'src/lib/mls/groupClient.ts',
    mobile: 'packages/mobile/src/crypto/groupClient.ts',
    sdk: 'packages/sdk/src/mls/groupClient.ts',
    /*
     * Two mobile-runtime workarounds, both documented in the mini-app copy's
     * own header, and both structural rather than cosmetic — the file diverges
     * from its seventh character:
     *
     *  1. ts-mls is loaded by a lazy `require` INSIDE the accessor, so it loads
     *     after the host's boot WebCrypto polyfill attaches `crypto.subtle`,
     *     and so Metro's `inlineRequires` cannot resolve a top-level module
     *     namespace to undefined.
     *  2. AES-GCM is served from `@noble/ciphers`, because on Hermes
     *     `crypto.subtle` is react-native-quick-crypto, whose AES-GCM encrypt
     *     produces ciphertext standard WebCrypto cannot decrypt.
     *
     * Collapsing these into one file would mean injecting the crypto provider
     * through all three trees — a refactor of shipped crypto, not a binding.
     */
    mobileExemptBecause: 'lazy ts-mls require (Metro/boot order) + @noble/ciphers AES-GCM shim (Hermes)',
    /*
     * The two adapters, pinned by name. Presence is asserted, not tolerated:
     * DELETING one of these to make some future test go green would silently
     * break mobile→web again — the exact regression this project already
     * shipped and fixed, and one that every unit test on both sides passed
     * through, because it only appears when one platform's ciphertext meets the
     * other's decrypt.
     */
    mobileAdapters: [
      { marker: "require('ts-mls')", atLeast: 1 },
      /*
       * COUNTED IN CODE, not merely present, and not counted in prose.
       *
       * Two rounds of sharpening, both from real weaknesses:
       *
       * 1. A bare substring check passes on the function DEFINITION alone, so
       *    deleting the call site — which is what actually disables the shim —
       *    went unnoticed. Verified by mutation at the time.
       * 2. The counts were then run over the RAW file, and half of what they
       *    counted was comments: of four `installAesGcmInterop` occurrences,
       *    two were prose (lines 15 and 154) and only one was the call. A
       *    threshold half-padded by comments breaks when someone rewords a
       *    comment, and can stay satisfied when someone deletes the call and
       *    mentions it in a comment. Comments are stripped before counting, so
       *    these numbers now mean occurrences in CODE: definition + call for
       *    the shim, one use for the provider.
       */
      { marker: 'installAesGcmInterop', atLeast: 2 },
      { marker: 'nobleCryptoProvider', atLeast: 1 },
    ],
    /** The only API the mini-app may add beyond the web surface. */
    mobileExtraApi: ['aesGcmInteropInstalled'],
  },
  {
    /*
     * The session store. The SDK was missing `reconcileMembership`, `removeUser`
     * and `forgetTopic` — every way out of a room — plus `mintIdentity`, which
     * is what makes a leaf attributable in the first place.
     *
     * Binding this is what makes an agent removable. It does NOT retroactively
     * fix agents that already joined: `bootstrap` persists the first identity
     * and never changes it, because changing it orphans the stored group state
     * and re-joins as a fresh leaf. Existing `sdk-<uuid>` leaves stay
     * unattributable — the same legacy-leaf gap the web already reports rather
     * than papers over. See task A-3.
     */
    name: 'mlsSession.ts',
    web: 'src/lib/mls/mlsSession.ts',
    mobile: 'packages/mobile/src/crypto/mlsSession.ts',
    sdk: 'packages/sdk/src/mls/mlsSession.ts',
    /*
     * This one is NOT a platform variant — the two are code-identical and
     * differ only in prose, the mini-app copy carrying abbreviated comments
     * that have lost information the web copy still has. It is listed here
     * rather than in
     * TWINNED because `packages/mobile/src/crypto/*` is owned by another lane
     * right now; making it byte-identical is a copy, not a design question.
     */
    mobileExemptBecause: 'comment-only drift; code-identical today — collapse into TWINNED when the mini-app lane is free',
    /* No platform adapter here — the divergence really is only prose. */
    mobileAdapters: [],
    mobileExtraApi: [],
  },
] as const;

/**
 * Control-flow keywords the 2-space-indent pattern picks up as if they were
 * method names (`  return (typeof a === 'string' ? …)`). Never real methods, and
 * leaving them in makes an "extra API" assertion report noise as a finding.
 */
const NOT_METHODS = new Set(['return', 'if', 'for', 'while', 'switch', 'catch', 'do']);

/**
 * Source with comments removed, for assertions about what the code DOES.
 *
 * A marker counted in the raw file is half prose: the mini-app's `groupClient`
 * mentions `installAesGcmInterop` twice in comments and calls it once. Counting
 * raw text means a reworded comment breaks the guard, and — worse — deleting
 * the call while mentioning it in a comment leaves the guard satisfied.
 *
 * KNOWN LIMITATION: this is a stripper, not a parser, so `//` inside a string
 * literal (`'https://…'`) reads as a line comment and drops the rest of that
 * line. Harmless today — none of the three `groupClient` copies contains a URL
 * at all, and no marker shares a line with one — but the day a marker does, it
 * vanishes from the count and the guard fails for a reason unrelated to what it
 * guards. The fix, if it ever bites, is to count markers appearing BEFORE any
 * `//` on their own line rather than stripping first.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

/** Exported/class method names, so a diff can name what is missing. */
function methodNames(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z][a-zA-Z0-9_]*)\s*\(/gm)) {
    if (!NOT_METHODS.has(m[1])) out.add(m[1]);
  }
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s+([a-zA-Z][a-zA-Z0-9_]*)/gm)) {
    if (!NOT_METHODS.has(m[1])) out.add(m[1]);
  }
  return [...out].sort();
}

describe('MLS/TAK crypto twins', () => {
  for (const file of TWINNED) {
    describe(file.name, () => {
      it('web and mini-app copies are byte-identical', () => {
        // These two have been kept in step by hand. Asserted anyway: the pair
        // that is currently correct is the one a port is measured against.
        expect(read(file.mobile)).toBe(read(file.web));
      });

      it('the agent SDK copy is byte-identical to the web copy', () => {
        /*
         * The binding that did not exist. Until the port lands this is RED, and
         * that is the intended state — a red test naming a real gap is worth
         * more than a green suite that never looked.
         */
        expect(read(file.sdk)).toBe(read(file.web));
      });

      it('names every method the SDK copy is missing, so a failure is actionable', () => {
        // A 667-line byte diff is unreadable. This one says `openMedia`.
        const missing = methodNames(read(file.web)).filter(
          (m) => !methodNames(read(file.sdk)).includes(m),
        );
        expect(missing, `missing from ${file.sdk}`).toEqual([]);
      });

      it('CONTRACT: the three copies resolve the same sibling modules', () => {
        /*
         * Byte-identity is only a reachable target if the import specifiers are
         * the same in all three trees. They are — every import in these files is
         * relative (`./groupClient`, `./takClient`, `./mlsSession`) and each
         * directory has those siblings. If this ever fails, byte-identity has
         * become impossible and the twin must be re-thought rather than forced.
         */
        const imports = (src: string) =>
          [...src.matchAll(/from '(\.\/[a-zA-Z]+)'/g)].map((m) => m[1]).sort();
        const web = imports(read(file.web));
        expect(imports(read(file.mobile)), 'mini-app').toEqual(web);
        // The SDK's list is a subset until the port; assert no FOREIGN specifier
        // appears, which is the thing that would make identity unreachable.
        for (const spec of imports(read(file.sdk))) {
          expect(web, `${file.sdk} imports ${spec}`).toContain(spec);
        }
      });
    });
  }

  for (const file of WEB_SDK_ONLY) {
    describe(`${file.name} (web ↔ SDK; mini-app bounded)`, () => {
      it('the agent SDK copy is byte-identical to the web copy', () => {
        expect(read(file.sdk)).toBe(read(file.web));
      });

      it('names every method the SDK copy is missing, so a failure is actionable', () => {
        const missing = methodNames(read(file.web)).filter(
          (m) => !methodNames(read(file.sdk)).includes(m),
        );
        expect(missing, `missing from ${file.sdk}`).toEqual([]);
      });

      it('BOUNDARY: the mini-app is exempt from byte-identity, NOT from the method surface', () => {
        /*
         * The whole point of listing a file here rather than in TWINNED. The
         * mini-app may differ in HOW it does a thing — see mobileExemptBecause —
         * and may not differ in WHAT it can do. A mini-app copy that quietly
         * loses `reconcileMembership` or `removeMembers` is the same failure as
         * the SDK losing `openMedia`, and it goes red right here.
         */
        const missing = methodNames(read(file.web)).filter(
          (m) => !methodNames(read(file.mobile)).includes(m),
        );
        expect(
          missing,
          `missing from ${file.mobile} — exempt from byte-identity because: ${file.mobileExemptBecause}`,
        ).toEqual([]);
      });

      it('BOUNDED: the mini-app carries the known adapters, and nothing else new', () => {
        /*
         * "These are the ONLY differences" is the real guard. "There are no
         * differences" would be a false one — and asserting it would invite
         * someone to delete a platform adapter to turn this file green.
         *
         * What actually protects this file across platforms is a cross-provider
         * round trip, and one exists: `src/__tests__/e2e/chat-media.test.ts`
         * runs the web's WebCrypto copy against the mini-app's @noble copy in
         * BOTH directions against a real container. That is the test that would
         * catch a broken adapter; this one only catches a MISSING one.
         */
        const mobile = codeOnly(read(file.mobile));
        const count = (hay: string, needle: string) => hay.split(needle).length - 1;

        for (const { marker, atLeast } of file.mobileAdapters) {
          expect(
            count(mobile, marker),
            `${file.mobile} lost part of its platform adapter \`${marker}\` — mobile→web ciphertext breaks and every unit test on both sides still passes`,
          ).toBeGreaterThanOrEqual(atLeast);
        }

        // Neither the web nor the SDK copy runs on Hermes or Metro; carrying an
        // adapter there would be dead weight at best and wrong at worst.
        for (const { marker } of file.mobileAdapters) {
          // codeOnly here too: a comment in the web copy REFERRING to the
          // mini-app's shim is legitimate documentation, not a stray adapter.
          expect(codeOnly(read(file.web)).includes(marker), `${file.web} should not carry ${marker}`).toBe(
            false,
          );
          expect(codeOnly(read(file.sdk)).includes(marker), `${file.sdk} should not carry ${marker}`).toBe(
            false,
          );
        }

        // A THIRD divergence that adds new API is exactly what "bounded" has to
        // exclude, or the exemption quietly widens over time.
        const webNames = methodNames(read(file.web));
        const extra = methodNames(mobile).filter((n) => !webNames.includes(n));
        expect(extra, `${file.mobile} adds API beyond its stated adapters`).toEqual([
          ...file.mobileExtraApi,
        ]);
      });

      it('INTEGRITY: the exemption is a stated reason, not an empty escape hatch', () => {
        /*
         * A boundary with a blank reason is the accident this file exists to
         * prevent, wearing a comment. If somebody adds an entry here to make a
         * red test go green, they have to write down what is intentionally
         * different — which is the moment they notice it should not be.
         */
        expect(file.mobileExemptBecause.length, file.name).toBeGreaterThan(30);
      });
    });
  }

  /*
   * The two properties an eviction decision three subsystems away depends on.
   *
   * `A-3` attributes an otherwise-unnameable MLS leaf by reading the account
   * that POSTED the External Commit which created it. That is only sound while
   * "the poster is the joiner" holds, and it holds today for two reasons:
   *
   *  1. ts-mls `createCommit` frames a member's commit as an encrypted
   *     PrivateMessage unless `wireAsPublicMessage: true` is passed, and it
   *     refuses outright to let a member create an External Commit
   *     (`createCommit.js`: "Cannot create externalCommit as a member").
   *  2. This codebase has NO Add-path join. Every join is a self-join by
   *     External Commit — including the AI member, whose `botJoin` is just
   *     `sync()`. `botPublishKeyPackage` registers a KeyPackage that nothing
   *     ever consumes into an Add commit.
   *
   * Reason 2 is an ABSENCE, and absences are not defended by anything. This
   * block is the defence. It does NOT cover a ts-mls version bump changing the
   * default — that is a separate guard living beside the join parser, which
   * generates a real Add-path commit and asserts the parser refuses it. Neither
   * test's green means the property holds; they cover different halves.
   */
  describe('A-3 invariants: the poster of a readable commit is the joiner', () => {
    /*
     * DERIVED from the table above, not written out again. A fourth copy of
     * groupClient added to `WEB_SDK_ONLY` is covered by these invariants
     * automatically; a hand-written list would silently not cover it, which is
     * the same "state it once, in the place that owns it" failure these tests
     * exist to catch elsewhere.
     */
    const gcEntry = WEB_SDK_ONLY.find((f) => f.name === 'groupClient.ts');
    const GROUP_CLIENTS = gcEntry ? [gcEntry.web, gcEntry.sdk, gcEntry.mobile] : [];

    it('the invariant list is derived, and non-empty', () => {
      // If `groupClient.ts` is renamed or moved between tables, the loop below
      // would silently assert nothing. An empty list is a failure, not a pass.
      expect(GROUP_CLIENTS.length, 'no groupClient entry found in WEB_SDK_ONLY').toBe(3);
    });

    for (const path of GROUP_CLIENTS) {
      it(`${path} never frames a member's commit as a PublicMessage`, () => {
        expect(
          read(path).includes('wireAsPublicMessage'),
          `${path} passes \`wireAsPublicMessage\` to createCommit. That makes a MEMBER's ` +
            `commit readable to the join parser, which attributes leaves by assuming a ` +
            `readable commit is a self-join. The parser would then bind the COMMITTER's ` +
            `account to somebody else's device, and A-3 would evict the wrong one. A null ` +
            `makes that path decline; a wrong account makes it act.`,
        ).toBe(false);
      });

      it(`${path} constructs no Add proposal`, () => {
        // `proposalType: 'remove'` is expected and present — only 'add' is the
        // problem, so this must not be a bare search for `proposalType`.
        expect(
          /proposalType:\s*['"]add['"]/.test(read(path)),
          `${path} builds an Add proposal, so a device can now join by being ADDED by ` +
            `another member rather than by self-joining. The poster of that commit is the ` +
            `ADDER, not the joiner. A-3 attributes unnameable leaves by the posting account ` +
            `and would bind the adder's identity to the joined device. Revisit A-3's ` +
            `attribution before landing this — the failure mode is evicting the wrong device, ` +
            `not failing to evict.`,
        ).toBe(false);
      });
    }
  });

  it('INTEGRITY: no file is claimed as both a full twin and a bounded one', () => {
    // The two tables answer the same question differently. A file in both would
    // mean the weaker assertion silently satisfies the stronger one's absence.
    const twinned = new Set<string>(TWINNED.map((f) => f.name));
    for (const f of WEB_SDK_ONLY) {
      expect(twinned.has(f.name), `${f.name} is in both tables`).toBe(false);
    }
  });
});
