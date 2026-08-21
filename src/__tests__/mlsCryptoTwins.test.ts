/**
 * ONE copy of the MLS/TAK crypto, and a guard that keeps it one.
 *
 * ── the history this file was born from ──────────────────────────────────────
 *
 * `src/lib/mls/*` (web), `packages/mobile/src/crypto/*` (mini-app) and
 * `packages/sdk/src/mls/*` (the agent SDK) used to be THREE copies of the same
 * code. The first two were kept identical by hand; the third was not bound to
 * anything, and drifted **667 lines and 14 methods** behind without a single red
 * test — `openMedia`, `sealMedia`, the whole public-root path (`getServerRoot`,
 * `putServerRoot`, `archiveRootState`, `publicRootFingerprint`,
 * `getRootFingerprint`, `setRootFingerprint`, `forgetUnsettledRoot`,
 * `distributePublicRootWhenGroupChanged`), the invite-history transfer
 * (`exportInviteHistory`, `importInviteHistory`), `backfillMissingArchive` and
 * `diagnoseKeychain`.
 *
 * What that cost: an AI member holding a topic's epoch TAK still could not read
 * an attachment, because its client had no `openMedia` to decrypt with — it
 * received the literal envelope `openstoa:media:v1:{…}` where a person saw a
 * photo. OpenStoa exists to host agents alongside humans (CLAUDE.md); an agent
 * that cannot read what a person in the same room reads is not a member of it.
 *
 * The first version of this file answered that by binding the three copies to
 * each other byte for byte. It worked, and it was always the second-best fix:
 * byte-identity makes drift LOUD, it does not make drift IMPOSSIBLE, and it
 * costs a three-way hand-sync on every edit forever.
 *
 * ── what is asserted now ─────────────────────────────────────────────────────
 *
 * The implementation moved into `packages/mls/src` — ONE file per module — and
 * the three trees hold thin re-exports of it. The two things that genuinely
 * differed (how ts-mls is loaded, where AES-GCM comes from — both in
 * `groupClient.ts`, everything else was identical) are injected through
 * `configureMlsRuntime`.
 *
 * So the invariant is no longer "the copies match". It is:
 *
 *     NOBODY REINTRODUCES A COPY.
 *
 * which is asserted four ways, because a copy can come back four ways:
 *
 *   1. a re-export file grows an implementation  → SHAPE: every consumer file is
 *      a re-export and nothing else, with `packages/mobile/src/crypto/
 *      groupClient.ts` the ONE bounded exception (it carries runtime config)
 *   2. a re-export quietly points somewhere else → TARGET: every specifier
 *      resolves into `packages/mls/src`
 *   3. two consumers load two implementations    → IDENTITY: all three resolve
 *      to the same module object at RUNTIME, and expose the same surface. This
 *      is the direct descendant of the `openMedia` assertion: a consumer that
 *      hand-picks its re-exports and drops one goes red here.
 *   4. a fourth copy appears under a new name    → SWEEP: the signature line of
 *      each shared module exists exactly once in the repo
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   contract          → IDENTITY: each consumer's export surface is compared to
 *                       the shared module's, so a narrowed re-export names the
 *                       symbols it dropped rather than failing as "differs"
 *   boundary          → the mobile `groupClient` exemption is bounded on all
 *                       four sides: stated reason, code-line budget, required
 *                       adapters, and an exact allow-list of added API
 *   result integrity  → SWEEP asserts one implementation repo-wide, so a green
 *                       run means "one copy", not "the files we happened to list"
 *   hostile           → the adapter markers are counted in CODE with comments
 *                       stripped, so a marker mentioned in prose cannot satisfy
 *                       a guard whose call site was deleted
 *   empty / null      → INTEGRITY: an exemption with a blank reason fails
 *   UTF-8 / large / authz / race → N/A: this file reads source files off disk
 *                       and imports modules; it performs no I/O and no crypto.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SHARED_DIR = join('packages', 'mls', 'src');

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * Source with comments removed, for assertions about what the code DOES.
 *
 * Inherited unchanged from the byte-identity version, and for the same reason
 * it was sharpened there: a marker counted in the RAW file is half prose. Of
 * four `installAesGcmInterop` occurrences in the old mini-app `groupClient`,
 * two were comments and only one was the call — so a threshold padded by
 * comments breaks when someone rewords a comment, and stays satisfied when
 * someone deletes the call and mentions it in a comment.
 *
 * KNOWN LIMITATION: this is a stripper, not a parser, so `//` inside a string
 * literal (`'https://…'`) reads as a line comment and drops the rest of that
 * line. Harmless here — the files it runs over are re-exports and a config
 * block, none of which contains a URL — but the day one does, the fix is to
 * count markers appearing BEFORE any `//` on their own line rather than
 * stripping first.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

const codeLines = (source: string) =>
  codeOnly(source)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Every `from '…'` specifier in a file, resolved to a repo-relative path. */
function resolvedSpecifiers(rel: string): { spec: string; target: string }[] {
  const dir = dirname(join(ROOT, rel));
  return [...codeOnly(read(rel)).matchAll(/from\s+'([^']+)'/g)].map((m) => ({
    spec: m[1],
    target: relative(ROOT, resolve(dir, m[1])),
  }));
}

/**
 * The shared modules, and the re-export each consumer holds for them.
 *
 * `signature` is one line that only the real implementation can contain — used
 * by the repo-wide sweep, which is the assertion that survives someone adding a
 * FOURTH copy under a name this table does not list.
 */
const MODULES = [
  {
    name: 'groupClient',
    signature: "export const MLS_SUITE_NAME =",
    web: 'src/lib/mls/groupClient.ts',
    mobile: 'packages/mobile/src/crypto/groupClient.ts',
    sdk: 'packages/sdk/src/mls/groupClient.ts',
  },
  {
    name: 'mlsSession',
    signature: 'export class MlsSessionStore {',
    web: 'src/lib/mls/mlsSession.ts',
    mobile: 'packages/mobile/src/crypto/mlsSession.ts',
    sdk: 'packages/sdk/src/mls/mlsSession.ts',
  },
  {
    name: 'takSession',
    signature: 'export class TakSessionStore {',
    web: 'src/lib/mls/takSession.ts',
    mobile: 'packages/mobile/src/crypto/takSession.ts',
    sdk: 'packages/sdk/src/mls/takSession.ts',
  },
  {
    name: 'takClient',
    signature: "const ROOT_FINGERPRINT_LABEL = 'openstoa-archive-root-id/v1'",
    web: 'src/lib/mls/takClient.ts',
    mobile: 'packages/mobile/src/crypto/takClient.ts',
    sdk: 'packages/sdk/src/mls/takClient.ts',
  },
  {
    /*
     * Who a leaf belongs to. The SDK did not have this file AT ALL, so an
     * agent's leaf was minted as a bare `sdk-<uuid>` with no `<userId>:` part —
     * and `userIdOfLeaf` returns null for that BY DESIGN, since a leaf nobody
     * can name belongs to somebody and guessing would evict an innocent member.
     * `reconcileMembership` therefore counted the leaf and deliberately left it
     * in the tree, so removing an AI member deleted its membership row and left
     * it deriving every future epoch key.
     */
    name: 'leafIdentity',
    signature: 'export function userIdOfLeaf(',
    web: 'src/lib/mls/leafIdentity.ts',
    mobile: 'packages/mobile/src/crypto/leafIdentity.ts',
    sdk: 'packages/sdk/src/mls/leafIdentity.ts',
  },
  {
    /*
     * The device master_key and the at-rest store built on it. The SDK copy was
     * 61 lines behind: no `RETIRED_KEY_STORE_KEY`, no `loadRetiredMasterKey`,
     * and `EncryptingKVStore.lazy` without its `rootStore` argument, so no
     * read-time fallback and no opportunistic re-seal. Everything local — MLS
     * group state, cached plaintexts, TAK keys — is sealed under
     * HKDF(master_key), and `EncryptingKVStore.get` reports an unopenable value
     * as ABSENT, so swapping the key did not error: it made the device silently
     * forget its own group state and archive keys.
     */
    name: 'keyManager',
    signature: "const RETIRED_KEY_STORE_KEY = 'openstoa.masterKey.retired.v1'",
    web: 'src/lib/mls/keyManager.ts',
    mobile: 'packages/mobile/src/crypto/keyManager.ts',
    sdk: 'packages/sdk/src/mls/keyManager.ts',
  },
  {
    name: 'keyBackup',
    signature: "const LABEL_TAK_BACKUP = 'openstoa-tak-backup/v1'",
    web: 'src/lib/mls/keyBackup.ts',
    mobile: 'packages/mobile/src/crypto/keyBackup.ts',
    sdk: 'packages/sdk/src/mls/keyBackup.ts',
  },
  {
    name: 'aiMember',
    signature: 'export async function botPublishKeyPackage(',
    web: 'src/lib/mls/aiMember.ts',
    mobile: 'packages/mobile/src/crypto/aiMember.ts',
    sdk: 'packages/sdk/src/mls/aiMember.ts',
  },
  {
    /*
     * The attachment envelope AND the object-key builder. M-3 moved that key
     * shape once already: a hand-written fourth copy is how
     * `topics/{topicId}/chat/…` becomes two different strings, and the one that
     * stops matching is whichever nobody tested that day. Note the three
     * consumers keep it in three DIFFERENT directories — which is exactly why
     * the specifier has to be resolved rather than pattern-matched.
     */
    name: 'chatMedia',
    signature: "export const CHAT_MEDIA_BODY_PREFIX = 'openstoa:media:v1:'",
    web: 'src/lib/chatMedia.ts',
    mobile: 'packages/mobile/src/lib/chatMedia.ts',
    sdk: 'packages/sdk/src/chatMedia.ts',
  },
] as const;

const CONSUMERS = ['web', 'mobile', 'sdk'] as const;

/**
 * The ONE consumer file allowed to hold code, and the exact bound on it.
 *
 * Naming the reason is the point, and it is inherited from the version of this
 * file that bound three copies: an unbound copy with no note is what produced
 * this whole class of bug, because the next person cannot tell "deliberately
 * different" from "nobody looked". The difference is that the exemption is now
 * ~9 lines of configuration instead of a 900-line twin.
 */
const CONFIGURED_CONSUMER = {
  file: 'packages/mobile/src/crypto/groupClient.ts',
  exemptBecause:
    'ts-mls must load lazily, after the boot WebCrypto polyfill and out of reach of Metro inlineRequires; ' +
    'and AES-GCM must come from @noble/ciphers because Hermes crypto.subtle (react-native-quick-crypto) ' +
    'encrypts ciphertext standard WebCrypto cannot decrypt',
  /*
   * A budget, not a shape: the file may be re-worded, and it may not grow a
   * function body. Nine code lines today; the ceiling leaves room for one more
   * runtime knob and no room for an implementation.
   */
  maxCodeLines: 16,
  /*
   * The adapters, pinned by name and COUNTED IN CODE. Presence is asserted, not
   * tolerated: deleting one of these to make some future test go green would
   * silently break mobile→web again — the exact regression this project already
   * shipped and fixed, and one that every unit test on both sides passed
   * through, because it only appears when one platform's ciphertext meets the
   * other's decrypt.
   */
  adapters: [
    { marker: "require('ts-mls')", atLeast: 1 },
    { marker: 'configureMlsRuntime', atLeast: 2 }, // import + call
    { marker: 'installNobleAesGcmInterop', atLeast: 2 }, // wired as prepareCrypto + re-exported
    { marker: 'nobleCryptoProvider', atLeast: 1 },
  ],
  /** The only API it may add beyond the shared groupClient surface. */
  extraApi: ['installNobleAesGcmInterop', 'aesGcmInteropInstalled'],
} as const;

/**
 * Runtime handles. Static, because a dynamic `import(variable)` is invisible to
 * the bundler — and because the point of the IDENTITY block is to load these
 * exactly the way the products do.
 *
 * Importing the mini-app's `groupClient` runs `configureMlsRuntime` for this
 * FILE's module registry. Harmless here (nothing below performs a crypto
 * operation) and deliberate: it is the same module the web import returns, and
 * demonstrating that is half the point. `installNobleAesGcmInterop` is NOT run
 * by the import — `prepareCrypto` fires inside `ciphersuiteImpl`, which this
 * file never calls — so the global `crypto.subtle` is left untouched.
 */
const IMPORTERS: Record<string, Record<string, () => Promise<Record<string, unknown>>>> = {
  groupClient: {
    web: () => import('@/lib/mls/groupClient'),
    mobile: () => import('../../packages/mobile/src/crypto/groupClient'),
    sdk: () => import('../../packages/sdk/src/mls/groupClient'),
  },
  mlsSession: {
    web: () => import('@/lib/mls/mlsSession'),
    mobile: () => import('../../packages/mobile/src/crypto/mlsSession'),
    sdk: () => import('../../packages/sdk/src/mls/mlsSession'),
  },
  takSession: {
    web: () => import('@/lib/mls/takSession'),
    mobile: () => import('../../packages/mobile/src/crypto/takSession'),
    sdk: () => import('../../packages/sdk/src/mls/takSession'),
  },
  takClient: {
    web: () => import('@/lib/mls/takClient'),
    mobile: () => import('../../packages/mobile/src/crypto/takClient'),
    sdk: () => import('../../packages/sdk/src/mls/takClient'),
  },
  leafIdentity: {
    web: () => import('@/lib/mls/leafIdentity'),
    mobile: () => import('../../packages/mobile/src/crypto/leafIdentity'),
    sdk: () => import('../../packages/sdk/src/mls/leafIdentity'),
  },
  keyManager: {
    web: () => import('@/lib/mls/keyManager'),
    mobile: () => import('../../packages/mobile/src/crypto/keyManager'),
    sdk: () => import('../../packages/sdk/src/mls/keyManager'),
  },
  keyBackup: {
    web: () => import('@/lib/mls/keyBackup'),
    mobile: () => import('../../packages/mobile/src/crypto/keyBackup'),
    sdk: () => import('../../packages/sdk/src/mls/keyBackup'),
  },
  aiMember: {
    web: () => import('@/lib/mls/aiMember'),
    mobile: () => import('../../packages/mobile/src/crypto/aiMember'),
    sdk: () => import('../../packages/sdk/src/mls/aiMember'),
  },
  chatMedia: {
    web: () => import('@/lib/chatMedia'),
    mobile: () => import('../../packages/mobile/src/lib/chatMedia'),
    sdk: () => import('../../packages/sdk/src/chatMedia'),
  },
  shared: {
    groupClient: () => import('../../packages/mls/src/groupClient'),
    mlsSession: () => import('../../packages/mls/src/mlsSession'),
    takSession: () => import('../../packages/mls/src/takSession'),
    takClient: () => import('../../packages/mls/src/takClient'),
    leafIdentity: () => import('../../packages/mls/src/leafIdentity'),
    keyManager: () => import('../../packages/mls/src/keyManager'),
    keyBackup: () => import('../../packages/mls/src/keyBackup'),
    aiMember: () => import('../../packages/mls/src/aiMember'),
    chatMedia: () => import('../../packages/mls/src/chatMedia'),
  },
};

/** Every `.ts`/`.tsx` under `dir`, skipping build output, deps and tests. */
function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist' || entry === '__tests__') continue;
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walkSources(rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

describe('MLS/TAK crypto: exactly one implementation', () => {
  it('the table is complete: every shared module is listed, and every listed module exists', () => {
    /*
     * The table is what all four assertions below iterate, so a shared module
     * missing FROM it is a module nothing checks. Derived from the directory
     * rather than trusted, for the same reason the old file derived its A-3
     * list rather than writing it out twice.
     */
    /*
     * `aesGcmInterop` and `imageMetadata` are excluded because neither has a
     * per-consumer re-export to check — they are INTERNAL to the package. The
     * first is a runtime shim installed by `groupClient`; the second is the
     * attachment metadata stripper `chatMedia` calls before it seals. Nothing
     * outside the package imports either by name, so there is no copy for the
     * four assertions below to compare. Both are still in the barrel, which is
     * asserted separately — so "internal" never means "unreachable".
     */
    const INTERNAL = ['index.ts', 'aesGcmInterop.ts', 'imageMetadata.ts'];
    const onDisk = readdirSync(join(ROOT, SHARED_DIR))
      .filter((f) => f.endsWith('.ts') && !INTERNAL.includes(f))
      .map((f) => f.replace(/\.ts$/, ''))
      .sort();
    expect(MODULES.map((m) => m.name).sort()).toEqual(onDisk);
  });

  it('the barrel re-exports every shared module, so a new one is not born unreachable', () => {
    const barrel = codeOnly(read(join(SHARED_DIR, 'index.ts')));
    for (const f of readdirSync(join(ROOT, SHARED_DIR)).filter((f) => f.endsWith('.ts') && f !== 'index.ts')) {
      const name = f.replace(/\.ts$/, '');
      expect(barrel, `packages/mls/src/index.ts does not export ./${name}`).toContain(`from './${name}'`);
    }
  });

  for (const mod of MODULES) {
    describe(mod.name, () => {
      for (const consumer of CONSUMERS) {
        const file = mod[consumer];
        const isConfigured = file === CONFIGURED_CONSUMER.file;

        it(`SHAPE: ${consumer} holds a re-export, not an implementation`, () => {
          /*
           * The assertion that replaces byte-identity. A copy comes back by
           * someone "just adding one small thing here" — which is invisible to
           * the other two consumers, and is precisely how the SDK copy fell 667
           * lines behind. There is nowhere to add it: the file may contain
           * re-export statements and (for the one configured consumer) its
           * runtime wiring, and nothing else.
           */
          const lines = codeLines(read(file));
          if (!isConfigured) {
            expect(lines, `${file} is more than a re-export`).toEqual([
              `export * from '${resolvedSpecifiers(file)[0].spec}';`,
            ]);
          } else {
            expect(lines.length, `${file} exceeds its configuration budget`).toBeLessThanOrEqual(
              CONFIGURED_CONSUMER.maxCodeLines,
            );
            // A budget alone would let 16 lines of implementation in.
            for (const kw of [/\bfunction\b/, /\bclass\b/, /\bawait\b/, /\bfor\s*\(/, /\bif\s*\(/]) {
              expect(
                codeOnly(read(file)),
                `${file} contains \`${kw.source}\` — configuration only, put logic in ${SHARED_DIR}`,
              ).not.toMatch(kw);
            }
          }
        });

        it(`TARGET: ${consumer}'s re-export resolves into ${SHARED_DIR}`, () => {
          /*
           * SHAPE alone accepts `export * from './somewhereElse'`. The three
           * consumers sit at three different depths and (for chatMedia) in
           * three different directories, so the specifier is RESOLVED rather
           * than matched as text.
           */
          const specs = resolvedSpecifiers(file);
          expect(specs.length, `${file} has no re-export`).toBeGreaterThan(0);
          for (const { spec, target } of specs) {
            expect(
              target.startsWith(SHARED_DIR + sep),
              `${file} imports '${spec}' → ${target}, outside ${SHARED_DIR}`,
            ).toBe(true);
          }
          expect(
            specs.some(({ target }) => target === join(SHARED_DIR, mod.name)),
            `${file} does not re-export ${join(SHARED_DIR, mod.name)}`,
          ).toBe(true);
        });
      }

      it('IDENTITY: all three consumers resolve to the same module, with the same surface', async () => {
        /*
         * The direct descendant of "names every method the SDK copy is
         * missing". That test caught `openMedia` after the drift had already
         * shipped; this one makes the drift unrepresentable — there is one
         * module object, and all three names for it are the same object.
         *
         * The surface diff is kept because SHAPE permits `export * from`, and
         * a future edit to a NAMED re-export list would satisfy every text
         * assertion above while dropping a symbol. That is `openMedia` again,
         * and it fails here naming the symbol.
         */
        const shared = await IMPORTERS.shared[mod.name]();
        const sharedNames = Object.keys(shared).sort();
        expect(sharedNames.length, `${mod.name} exports nothing`).toBeGreaterThan(0);

        for (const consumer of CONSUMERS) {
          const loaded = await IMPORTERS[mod.name][consumer]();
          const missing = sharedNames.filter((n) => !(n in loaded));
          expect(missing, `missing from ${mod[consumer]}`).toEqual([]);
          for (const name of sharedNames) {
            expect(
              loaded[name],
              `${mod[consumer]} exports a DIFFERENT \`${name}\` — that is a second implementation`,
            ).toBe(shared[name]);
          }
        }
      });
    });
  }

  describe(`the one configured consumer: ${CONFIGURED_CONSUMER.file}`, () => {
    it('INTEGRITY: the exemption is a stated reason, not an empty escape hatch', () => {
      /*
       * Carried over unchanged in intent. A boundary with a blank reason is the
       * accident this file exists to prevent, wearing a comment. Someone adding
       * a second configured consumer has to write down what is intentionally
       * different — which is the moment they notice it should not be.
       */
      expect(CONFIGURED_CONSUMER.exemptBecause.length).toBeGreaterThan(30);
    });

    it('BOUNDED: it carries the known adapters, counted in code', () => {
      const code = codeOnly(read(CONFIGURED_CONSUMER.file));
      const count = (hay: string, needle: string) => hay.split(needle).length - 1;
      for (const { marker, atLeast } of CONFIGURED_CONSUMER.adapters) {
        expect(
          count(code, marker),
          `${CONFIGURED_CONSUMER.file} lost part of its platform adapter \`${marker}\` — mobile→web ` +
            `ciphertext breaks and every unit test on both sides still passes`,
        ).toBeGreaterThanOrEqual(atLeast);
      }
    });

    it('BOUNDED: nobody else carries a platform adapter, the shared module least of all', () => {
      /*
       * Neither the web nor the SDK runs on Hermes or Metro, so an adapter
       * there is dead weight at best and wrong at worst. The shared module is
       * the important half of this assertion: the whole reason three copies
       * existed was that these two decisions lived INSIDE the implementation.
       * They are parameters now, and this is what stops one leaking back in.
       */
      const elsewhere = [
        ...MODULES.map((m) => m.web),
        ...MODULES.map((m) => m.sdk),
        ...MODULES.filter((m) => m.mobile !== CONFIGURED_CONSUMER.file).map((m) => m.mobile),
        join(SHARED_DIR, 'groupClient.ts'),
      ];
      for (const file of elsewhere) {
        const code = codeOnly(read(file));
        for (const { marker } of CONFIGURED_CONSUMER.adapters) {
          if (marker === 'configureMlsRuntime') continue; // defined by the shared module, by design
          expect(code.includes(marker), `${file} should not carry ${marker}`).toBe(false);
        }
      }
    });

    it('BOUNDED: it adds exactly the stated API and nothing else', async () => {
      /*
       * A third divergence that adds new API is what "bounded" has to exclude,
       * or the exemption quietly widens over time.
       */
      const shared = await IMPORTERS.shared.groupClient();
      const mobile = await IMPORTERS.groupClient.mobile();
      const extra = Object.keys(mobile).filter((n) => !(n in shared)).sort();
      expect(extra, `${CONFIGURED_CONSUMER.file} adds API beyond its stated adapters`).toEqual(
        [...CONFIGURED_CONSUMER.extraApi].sort(),
      );
    });

    it('the shim it installs is reachable and reports itself', async () => {
      /*
       * `aesGcmInteropInstalled` is how `mls-mobile-aesgcm-interop.test.ts`
       * proves the shim ran on the instance it is testing. It was missing from
       * this file's re-exports when the shared package landed, which turned
       * that proof into a TypeError. Re-exported and asserted so it stays.
       */
      const mobile = await IMPORTERS.groupClient.mobile();
      expect(typeof mobile.installNobleAesGcmInterop).toBe('function');
      expect(typeof mobile.aesGcmInteropInstalled).toBe('function');
    });
  });

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
   *
   * It used to run over three copies. There is one now, which is the whole
   * point: the invariant is asserted once because it can only be broken once.
   */
  describe('A-3 invariants: the poster of a readable commit is the joiner', () => {
    const GROUP_CLIENT = join(SHARED_DIR, 'groupClient.ts');

    it(`${GROUP_CLIENT} never frames a member's commit as a PublicMessage`, () => {
      expect(
        read(GROUP_CLIENT).includes('wireAsPublicMessage'),
        `${GROUP_CLIENT} passes \`wireAsPublicMessage\` to createCommit. That makes a MEMBER's ` +
          `commit readable to the join parser, which attributes leaves by assuming a ` +
          `readable commit is a self-join. The parser would then bind the COMMITTER's ` +
          `account to somebody else's device, and A-3 would evict the wrong one. A null ` +
          `makes that path decline; a wrong account makes it act.`,
      ).toBe(false);
    });

    it(`${GROUP_CLIENT} constructs no Add proposal`, () => {
      // `proposalType: 'remove'` is expected and present — only 'add' is the
      // problem, so this must not be a bare search for `proposalType`.
      expect(
        /proposalType:\s*['"]add['"]/.test(read(GROUP_CLIENT)),
        `${GROUP_CLIENT} builds an Add proposal, so a device can now join by being ADDED by ` +
          `another member rather than by self-joining. The poster of that commit is the ` +
          `ADDER, not the joiner. A-3 attributes unnameable leaves by the posting account ` +
          `and would bind the adder's identity to the joined device. Revisit A-3's ` +
          `attribution before landing this — the failure mode is evicting the wrong device, ` +
          `not failing to evict.`,
      ).toBe(false);
    });
  });

  describe('SWEEP: no fourth copy, under any name', () => {
    /*
     * Everything above iterates a TABLE, so all of it can be satisfied while a
     * fresh copy sits in a file the table never heard of — `packages/sdk/src/
     * mlsGroup.ts`, say, pasted in because importing across packages "felt
     * wrong". That is exactly how the SDK copy started.
     *
     * So: one signature line per shared module, and it must exist in exactly
     * one place in the repo. Chosen to be a DECLARATION rather than a mention,
     * so documentation and tests that discuss the code do not trip it.
     */
    const SOURCES = [...walkSources('src'), ...walkSources('packages')];

    it('the sweep actually reads the tree', () => {
      // A walk that silently returned nothing would make every case below pass.
      expect(SOURCES.length, 'no sources found — the sweep is asserting nothing').toBeGreaterThan(200);
      expect(SOURCES).toContain(join(SHARED_DIR, 'groupClient.ts'));
    });

    for (const mod of MODULES) {
      it(`${mod.name} is implemented exactly once`, () => {
        const holders = SOURCES.filter((f) => read(f).includes(mod.signature));
        expect(holders, `\`${mod.signature}\` should live only in ${join(SHARED_DIR, mod.name)}.ts`).toEqual([
          join(SHARED_DIR, `${mod.name}.ts`),
        ]);
      });
    }
  });
});
