import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  tierPolicy,
  serverMayHoldKey,
  isEndToEndEncrypted,
  usesTopicRootKey,
  inviteHistoryEpochs,
  chatTierOf,
  isKnownVisibility,
  serverMayHoldKeyForRow,
  hasTopicRootForRow,
  TOPIC_VISIBILITIES,
  KEY_DELIVERIES,
  INVITE_HISTORY_EPOCHS_DEFAULT,
  INVITE_HISTORY_EPOCHS_MAX,
  type ChatTier,
  type KeyDelivery,
} from '@/lib/chatTierPolicy';

const ALL_TIERS: ChatTier[] = ['public', 'private', 'secret', 'dm'];

/** Source with comments stripped — what the code DOES, not what it says. */
function codeOf(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

/**
 * These rules are a security boundary, not a preference, so the tests assert
 * the boundary itself rather than the table that expresses it. A change that
 * lets the server hold a key it must not hold has to fail here.
 */
describe('serverMayHoldKey', () => {
  it('CONTRACT: only `public` lets the server hold the key', () => {
    expect(serverMayHoldKey('public')).toBe(true);
    for (const tier of ['private', 'secret', 'dm'] as const) {
      expect(serverMayHoldKey(tier), tier).toBe(false);
    }
  });

  it('REGRESSION: private is NOT the simpler topic-root tier', () => {
    /*
     * It nearly was. Posts in a private topic are readable by anyone signed in,
     * so "private chat can be loose too" looked reasonable — until the chat
     * route turned out to answer 403 to every non-member in every tier. The
     * conversation is members-only, so removal has to bite, so the keys are per
     * epoch.
     */
    expect(tierPolicy('private').keyModel).toBe('per-epoch');
    expect(tierPolicy('private')).toEqual(tierPolicy('secret'));
  });
});

describe('isEndToEndEncrypted', () => {
  it('is exactly the negation of the server holding the key', () => {
    // Derived, never stored twice: a banner that promises encryption over a
    // tier the server can read is the worst thing this module can prevent.
    for (const tier of ALL_TIERS) {
      expect(isEndToEndEncrypted(tier), tier).toBe(!serverMayHoldKey(tier));
    }
  });

  it('public is NOT end-to-end encrypted, and the others are', () => {
    expect(isEndToEndEncrypted('public')).toBe(false);
    expect(isEndToEndEncrypted('private')).toBe(true);
    expect(isEndToEndEncrypted('secret')).toBe(true);
    expect(isEndToEndEncrypted('dm')).toBe(true);
  });
});

describe('tierPolicy', () => {
  it('every tier is described — none falls through', () => {
    for (const tier of ALL_TIERS) {
      const p = tierPolicy(tier);
      expect(p, tier).toBeDefined();
      expect(['topic-root', 'per-epoch']).toContain(p.keyModel);
      expect(KEY_DELIVERIES).toContain(p.keyDelivery);
    }
  });

  it('CONTRACT: a key is delivered by the server ONLY where the server may hold one', () => {
    for (const tier of ALL_TIERS) {
      if (tierPolicy(tier).keyDelivery === 'server') {
        expect(serverMayHoldKey(tier), tier).toBe(true);
      }
    }
  });

  it('CONTRACT: a bounded window implies per-epoch keys', () => {
    // A single root cannot express a window — hand it over and everything opens,
    // now and after the holder is removed.
    for (const tier of ALL_TIERS) {
      if (tierPolicy(tier).historyForLaterJoiner === 'window') {
        expect(tierPolicy(tier).keyModel, tier).toBe('per-epoch');
      }
    }
  });
});

describe('inviteHistoryEpochs', () => {
  /*
   * The bound is EPOCHS, not messages. Counting messages was the first attempt
   * and it fails twice over: it does not bound the link (one key per epoch, so
   * "the last 50 messages" is one key in a quiet room and fifty in a busy one),
   * and it cannot be honoured (an epoch's key opens every message in that
   * epoch, so sharing "50" out of an epoch holding 5 000 shares 5 000).
   */
  it('defaults to a small number of recent epochs', () => {
    expect(inviteHistoryEpochs('private', undefined)).toBe(INVITE_HISTORY_EPOCHS_DEFAULT);
    expect(inviteHistoryEpochs('secret', undefined)).toBe(INVITE_HISTORY_EPOCHS_DEFAULT);
  });

  it('an inviter may share nothing — 0 is a real answer, not a missing one', () => {
    expect(inviteHistoryEpochs('secret', 0)).toBe(0);
  });

  it('BOUNDARY: the ceiling holds, and it keeps the link usable', () => {
    expect(inviteHistoryEpochs('secret', INVITE_HISTORY_EPOCHS_MAX)).toBe(INVITE_HISTORY_EPOCHS_MAX);
    expect(inviteHistoryEpochs('secret', INVITE_HISTORY_EPOCHS_MAX + 1)).toBe(INVITE_HISTORY_EPOCHS_MAX);
    expect(inviteHistoryEpochs('secret', 1_000_000)).toBe(INVITE_HISTORY_EPOCHS_MAX);
  });

  it('CONTRACT: the ceiling fits in a URL fragment', () => {
    // 32-byte key → 43 base64 characters. A fragment gives out around 2 000,
    // and this is the number that has to keep an invite link openable.
    const KEY_CHARS = 44;
    expect(INVITE_HISTORY_EPOCHS_MAX * KEY_CHARS).toBeLessThan(2000);
  });

  it('HOSTILE: a negative or fractional count shares nothing rather than guessing', () => {
    for (const bad of [-1, -1000, 1.5, NaN, Infinity]) {
      expect(inviteHistoryEpochs('secret', bad as number), String(bad)).toBe(0);
    }
  });

  it('tiers whose key opens everything have no window to bound', () => {
    expect(inviteHistoryEpochs('public', 5)).toBe(0);
    expect(inviteHistoryEpochs('dm', 5)).toBe(0);
  });
});

describe('chatTierOf', () => {
  it('a DM is a DM whatever visibility the row happens to carry', () => {
    for (const v of ['public', 'private', 'secret', null, undefined, 'nonsense']) {
      expect(chatTierOf(v, true), String(v)).toBe('dm');
    }
  });

  it('maps the visibilities it knows', () => {
    expect(chatTierOf('public', false)).toBe('public');
    expect(chatTierOf('private', false)).toBe('private');
    expect(chatTierOf('secret', false)).toBe('secret');
  });

  it('HOSTILE: an unknown visibility falls back to the LEAST-promising tier', () => {
    /*
     * Public promises the least — it is the one tier that does not claim the
     * server cannot read. A bad value can therefore only make us under-promise,
     * never claim an encryption guarantee we are not providing.
     */
    for (const v of [null, undefined, '', 'PRIVATE', 'sekret', '{}']) {
      expect(chatTierOf(v, false), String(v)).toBe('public');
      expect(isEndToEndEncrypted(chatTierOf(v, false))).toBe(false);
    }
  });
});

/**
 * The guard this file was missing, and the reason a DM was undecryptable for
 * everyone.
 *
 * `dm` declared `keyDelivery: 'on-accept'`. Nothing implemented it — a grep
 * found the type, the policy entry and their mini-app twins, and no code. Four
 * call sites nevertheless READ the declaration as an implementation and skipped
 * DMs entirely, so a DM's key never left the device that minted it. The old test
 * here could not have caught that: it asserted only that `keyDelivery` was one
 * of three strings, which is true of a string naming nothing.
 *
 * So the assertion is now about the WORLD, not the table: each delivery mode
 * names the code that carries it out, and that code has to be there.
 */
const DELIVERY_IMPLEMENTATIONS: Record<KeyDelivery, Array<{ file: string; code: string }>> = {
  /* The server keeps the key and hands it out. */
  server: [
    { file: 'packages/mls/src/takSession.ts', code: 'this.transport.getServerRoot(topicId)' },
    { file: 'packages/mls/src/takSession.ts', code: 'this.transport.putServerRoot(topicId, minted)' },
    { file: 'src/app/api/topics/[topicId]/archive/root/route.ts', code: 'db.insert(topicArchiveRoots)' },
  ],
  /* Keys ride in the invite link's fragment. */
  'invite-link': [
    { file: 'packages/mls/src/takSession.ts', code: 'async exportInviteHistory(' },
    { file: 'packages/mls/src/takSession.ts', code: 'async importInviteHistory(' },
    { file: 'src/lib/inviteHistoryLink.ts', code: 'export' },
  ],
  /* A device that holds the key wraps it to each member's leaf. */
  'peer-device': [
    { file: 'packages/mls/src/takSession.ts', code: 'async distributeRoot(' },
    { file: 'packages/mls/src/takSession.ts', code: 'wrapBundleToLeaf(lf.hpkePublicKey, payload)' },
    { file: 'src/lib/keyGrant.ts', code: 'distributeRootWhenGroupChanged(topicId, tier)' },
    { file: 'packages/mobile/src/crypto/keyGrant.ts', code: 'distributeRootWhenGroupChanged(topicId, tier)' },
    { file: 'packages/sdk/src/chatClient.ts', code: 'distributeRootWhenGroupChanged(topicId, tier)' },
  ],
};

describe('every declared keyDelivery is implemented', () => {
  it('CONTRACT: the union is fully enumerated at runtime, so nothing escapes the guard', () => {
    // A type is erased; a guard that cannot enumerate its subject can only check
    // the values somebody remembered to list. `KEY_DELIVERIES` is what makes the
    // rest of this block exhaustive, and a compile-time check in the module
    // itself is what keeps the array in step with the type.
    expect([...KEY_DELIVERIES].sort()).toEqual(Object.keys(DELIVERY_IMPLEMENTATIONS).sort());
  });

  it.each(KEY_DELIVERIES)('CONTRACT: `%s` names code that exists', (delivery) => {
    const sites = DELIVERY_IMPLEMENTATIONS[delivery];
    expect(sites.length, `${delivery} lists no implementation`).toBeGreaterThan(0);
    for (const { file, code } of sites) {
      // Read from the file with COMMENTS STRIPPED. `'on-accept'` was mentioned in
      // prose in exactly the places its implementation should have been, so a
      // guard that counted mentions would have passed on the broken code.
      expect(codeOf(file), `${file} no longer contains \`${code}\` for delivery '${delivery}'`).toContain(code);
    }
  });

  it('CONTRACT: every tier is delivered by a mode that has an implementation', () => {
    for (const tier of ALL_TIERS) {
      const delivery = tierPolicy(tier).keyDelivery;
      expect(DELIVERY_IMPLEMENTATIONS[delivery], `${tier} is delivered by '${delivery}'`).toBeTruthy();
    }
  });

  it('CONTRACT: a tier the server may not hold a key for is delivered device to device', () => {
    // The pairing that makes the promise keepable. If the server holds nothing
    // and no device hands anything over, the key stays where it was minted —
    // which is precisely the state DMs shipped in.
    for (const tier of ALL_TIERS) {
      if (serverMayHoldKey(tier)) continue;
      expect(tierPolicy(tier).keyDelivery, tier).not.toBe('server');
    }
  });
});

/**
 * The two consumers of `chatTierOf` fail in OPPOSITE directions, and these are
 * the gates that must not inherit the wrong one.
 *
 * `chatTierOf` answers `public` for a visibility it cannot classify. For the
 * BANNER that is correct: `public` promises the least, so a bad value can only
 * under-promise privacy. For a gate deciding whether the SERVER MAY HOLD A KEY
 * it is exactly backwards — `public` is the single tier whose key the server is
 * allowed to keep, so the lenient default lands on "yes, hand it over".
 *
 * Not reachable through the API today (`POST /api/topics` validates against
 * `TOPIC_VISIBILITIES`, and nothing updates the column afterwards), but the
 * column is a plain `varchar(10)` with NO CHECK constraint, so a migration, a
 * seed script or one future route that forgets to validate is the whole
 * distance between "not reachable" and "the server is storing the archive key
 * of a room the product calls end-to-end encrypted".
 */
describe('row gates refuse what they cannot classify', () => {
  it('CONTRACT: only the three real visibilities are recognised', () => {
    expect([...TOPIC_VISIBILITIES].sort()).toEqual(['private', 'public', 'secret']);
    for (const v of TOPIC_VISIBILITIES) expect(isKnownVisibility(v), v).toBe(true);
  });

  it('CONTRACT: the server may hold a key for public alone — and only when the row says so', () => {
    expect(serverMayHoldKeyForRow('public', false)).toBe(true);
    expect(serverMayHoldKeyForRow('private', false)).toBe(false);
    expect(serverMayHoldKeyForRow('secret', false)).toBe(false);
    // A DM is stored `secret` + kind='dm'; both readings must refuse.
    expect(serverMayHoldKeyForRow('secret', true)).toBe(false);
    expect(serverMayHoldKeyForRow('public', true)).toBe(false);
  });

  it('HOSTILE: an unclassifiable visibility is REFUSED, not resolved to public', () => {
    /*
     * The whole point. Each of these resolves to `public` through `chatTierOf`
     * — which is deliberate there — and `public` is the permissive branch of
     * the gate. Anything that reaches the gate must therefore be refused before
     * it is classified, not after.
     */
    const hostile = [
      undefined, null, '', ' ', 'PUBLIC', 'Public', 'Secret', 'SECRET', 'privte', 'sekret',
      'publi', 'public ', ' public', 'dm', 'topic', '{}', 'public,secret', "public' OR '1'='1",
      '공개', '🔓', 'public\u0000', 'a'.repeat(500),
    ];
    for (const v of hostile) {
      expect(isKnownVisibility(v as string), JSON.stringify(v)).toBe(false);
      expect(serverMayHoldKeyForRow(v as string, false), JSON.stringify(v)).toBe(false);
      expect(hasTopicRootForRow(v as string, false), JSON.stringify(v)).toBe(false);
      // and the lenient path really does say `public` for these — which is why
      // the strict check has to come first rather than being a belt on top.
      expect(chatTierOf(v as string, false), JSON.stringify(v)).toBe('public');
    }
  });

  it('CONTRACT: the two gates AGREE about which rows have a topic-wide root', () => {
    // A client told "publish a fingerprint" by one gate and "you may not
    // deposit" by the other has no way to settle on a root at all.
    for (const v of [...TOPIC_VISIBILITIES, 'nonsense', undefined]) {
      for (const isDm of [true, false]) {
        if (serverMayHoldKeyForRow(v as string, isDm)) {
          expect(hasTopicRootForRow(v as string, isDm), `${v}/${isDm}`).toBe(true);
        }
      }
    }
  });

  it('CONTRACT: a DM has a topic-wide root, and the server still may not hold it', () => {
    // The two answers that must not collapse into each other — this pairing is
    // the entire reason a DM needs the fingerprint surface at all.
    expect(hasTopicRootForRow('secret', true)).toBe(true);
    expect(serverMayHoldKeyForRow('secret', true)).toBe(false);
  });
});

describe('usesTopicRootKey', () => {
  it('is exactly the keyModel, so the TAK layer cannot disagree with the table', () => {
    for (const tier of ALL_TIERS) {
      expect(usesTopicRootKey(tier), tier).toBe(tierPolicy(tier).keyModel === 'topic-root');
    }
  });

  it('REGRESSION: a DM uses ONE root — it is not the per-epoch tier its visibility says', () => {
    /*
     * The whole defect in one line. A DM row is stored `visibility: 'secret'`,
     * and `takSession` used to branch on visibility, so DMs took the per-epoch
     * path while this table said topic-root. Nothing typed the disagreement,
     * because 'dm' is not a visibility.
     */
    expect(usesTopicRootKey('dm')).toBe(true);
    expect(usesTopicRootKey(chatTierOf('secret', true))).toBe(true);
    expect(usesTopicRootKey(chatTierOf('secret', false))).toBe(false);
  });

  it('CONTRACT: the crypto layer reads the policy rather than a visibility', () => {
    // The mechanical half of the regression above: `currentArchiveKey` decided
    // the key model from `visibility === 'public'`. A DM is not a visibility, so
    // no test could express the bug at the type level — only this can.
    const takSession = codeOf('packages/mls/src/takSession.ts');
    expect(takSession).toContain('usesTopicRootKey(tier)');
    expect(takSession, 'the TAK layer is branching on a visibility again').not.toContain("visibility === 'public'");
  });
});

describe('one copy of the rule', () => {
  it('the web and mini-app files are re-exports, not copies', () => {
    // Byte-identity used to be asserted here between two hand-synced copies.
    // The rule now lives in `packages/mls` beside the crypto that obeys it, and
    // `mlsCryptoTwins.test.ts` owns the "nobody reintroduces a copy" guard for
    // every shared module including this one. What is left to check here is that
    // the consumers still point at it.
    for (const rel of [
      'src/lib/chatTierPolicy.ts',
      'packages/mobile/src/lib/chatTierPolicy.ts',
      'packages/sdk/src/chatTierPolicy.ts',
    ]) {
      expect(codeOf(rel), rel).toMatch(/export \* from '[^']*mls\/src\/chatTierPolicy';/);
    }
  });
});
