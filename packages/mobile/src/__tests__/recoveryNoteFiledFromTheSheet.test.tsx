/*
 * `FirstRunRecoveryProvider`, mounted for real: the sheet appears, and the copy
 * of the key lands in the person's own room exactly once.
 *
 * WHY THIS EXISTS. Every piece under this provider already had a green suite
 * and the whole flow was still dead: `useFirstRunRecovery` decided when to ask,
 * `useRecoveryCodeSource` made the key, `FirstRunRecoverySheet` drew it,
 * `sendRecoveryNote` filed it — and nothing rendered any of it. The provider is
 * the wiring that fixes that, so it is the one place where "the parts are fine"
 * is not an answer. `recoverySheetIsMounted.test.ts` proves the app mounts this
 * provider; this file proves the provider does something when it is mounted.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT. The decision, the latch, the duplicate
 * scan (`scanPersonalRoom` + `refuseUnreadable`), the note body and the filing
 * (`fileNoteOnce`) are the real code — they are what is under test. Stubbed:
 * the network (a client double that answers `/api/topics` and the chat history),
 * the MLS sealer, and `backupWithRecoveryCode`, none of which can run off a
 * device.
 *
 * WHY `t` IS DELIBERATELY UNSTABLE. The provider's effect lists `t` in its
 * dependencies, so a fresh `t` per render re-runs the effect on every render —
 * which is what makes the latch cases below non-vacuous. A stable `t` would let
 * "one note after five renders" pass with the latch deleted, which is the same
 * hollow green `recoveryCodeMadeOnce.test.tsx` documents catching in itself.
 * Measured both ways; see the mutation notes on each case.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → mounting the provider puts the key on screen and keeps the
 *                children (the navigator) rendered
 *   repetition → the same code across re-renders files ONE note (THE latch)
 *   race       → a DIFFERENT code files again — the latch is keyed to the code,
 *                not to "this provider has run", so a second account signing in
 *                without an app restart is not silently skipped
 *   contract   → the note is filed as soon as the code EXISTS; dismissing
 *                without confirming leaves it filed and unconfirmed
 *   integrity  → a `partial` scan stops the write (absence is not proven)
 *   integrity  → one undecryptable row stops the write (same reason)
 *   repetition → a note already in the room stops the write
 *   integrity  → SI-1: the payload is ciphertext. No `systemText`, no `message`,
 *                and no plaintext copy of the code anywhere in the body
 *   external   → a rejected send does not throw out of the effect and does not
 *                surface an error on the sheet
 *   external   → an offline topic lookup is equally silent
 *   authz      → a signed-out app files nothing
 *   empty      → no secure store (no master_key here) files nothing
 *   boundary   → an account with no personal room is a no-op, not an error
 *   hostile / UTF-8 / very large — N/A here: the note body is built from the
 *                code and two translated strings, and `recoveryNoteIsFiledOnce`
 *                owns the marker's hostile cases (a body that merely contains
 *                the marker is not a note).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Text } from 'react-native';
import { HostProvider } from '@openstoa/miniapp-bridge';
import { render, flush, type Rendered } from './harness/render';
import { hostDouble, type HostDouble } from './harness/screen';
import { useOpenStoaSession } from '../stores/sessionStore';
import { RECOVERY_SHOWN_KEY } from '../lib/firstRunRecovery';
import { recoveryCodeNote } from '../lib/recoveryCodeNote';

const CODE = 'aaaa-bbbb-cccc-dddd';
const SECOND_CODE = 'wwww-xxxx-yyyy-zzzz';
const TITLE = 'openstoa.firstRunRecovery.title';
const FAILED = 'openstoa.firstRunRecovery.failed';
const LATER = 'openstoa.firstRunRecovery.later';
const CHILD = 'the-navigator-goes-here';

const stub = vi.hoisted(() => ({
  /*
   * The sentinel the provider compares decrypted bodies against. It lives in
   * the hoisted block because `vi.mock` factories run before this file's own
   * top-level constants exist — a plain `const` here is a ReferenceError at
   * mock time, not a lint nit.
   */
  unreadable: '[unable to decrypt]',
  /** The client the mocked `useOpenStoaClient` hands out, swapped per test. */
  client: { current: null as unknown },
  /** What `backupWithRecoveryCode` returns next. */
  code: { current: 'aaaa-bbbb-cccc-dddd' },
  /** Every plaintext handed to the sealer, in order. */
  sealed: [] as string[],
  /** Overrides for `useFirstRunRecovery`'s return, for the latch cases. */
  forced: { current: null as Record<string, unknown> | null },
}));

vi.mock('../hooks/useOpenStoaClient', () => ({
  useOpenStoaClient: () => stub.client.current,
}));

/*
 * The whole module is replaced, so every export the provider's tree reaches for
 * has to exist here — a missing one is a throw inside an effect, not a visible
 * failure. `toDisplayMessageMls` returns the row's `body` so a test can write
 * "the room already holds this text" directly, including the UNREADABLE
 * sentinel, which is the input `refuseUnreadable` exists for.
 */
vi.mock('../crypto/mobileTransport', () => ({
  keyBackupHttp: () => ({
    getBackup: async () => ({ wrappedMaster: null, passkeys: [] as unknown[] }),
    postRecovery: async () => ({}),
  }),
  getDeviceMasterKey: async () => new Uint8Array(32),
  getMlsSessionStore: () => ({
    seal: async (_topicId: string, plaintext: string) => {
      stub.sealed.push(plaintext);
      return { ciphertext: `SEALED(${plaintext.length})`, epoch: 7 };
    },
  }),
  toDisplayMessageMls: async (_mls: unknown, _topicId: string, row: unknown) => ({
    message: (row as { body?: string }).body ?? '',
  }),
  UNREADABLE_BODY: stub.unreadable,
}));

/** Same value, in a name the cases can read. */
const UNREADABLE = stub.unreadable;

vi.mock('../crypto/keyManager', () => ({
  backupWithRecoveryCode: async () => stub.code.current,
}));

// A fresh `t` on every render, on purpose — see the header.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/*
 * The real hook always runs, so hook order never changes between renders; the
 * override only replaces what it RETURNED. This is how a second code reaches
 * the provider without an app restart, which the real hook cannot produce on
 * its own (it creates one key per launch, by design) but a second account
 * signing in does.
 */
vi.mock('../hooks/useFirstRunRecovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks/useFirstRunRecovery')>();
  return {
    ...actual,
    useFirstRunRecovery: (deps: Parameters<typeof actual.useFirstRunRecovery>[0]) => {
      const real = actual.useFirstRunRecovery(deps);
      return stub.forced.current ? { ...real, ...stub.forced.current } : real;
    },
  };
});

import { FirstRunRecoveryProvider } from '../components/FirstRunRecovery';

interface RoomRow {
  id: string;
  /** What this device decrypts the row to. */
  body: string;
}

interface ClientOpts {
  topics?: Array<{ id: string; personal?: boolean }>;
  /** The personal room's history, as this device can read it. */
  rows?: RoomRow[];
  /** The server's `total`. Larger than `rows` is a room taller than one scan. */
  total?: number;
  failTopics?: boolean;
  failPost?: boolean;
}

function clientDouble(opts: ClientOpts) {
  // The personal room is deliberately NOT first: a recovery key in a shared
  // room is a recovery key handed to everyone in it.
  const topics = opts.topics ?? [{ id: 'shared-1' }, { id: 'personal-1', personal: true }];
  const rows = opts.rows ?? [];
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];

  const client = {
    get: async (path: string) => {
      if (path === '/api/topics') {
        if (opts.failTopics) throw new Error('offline');
        return { topics };
      }
      if (/^\/api\/topics\/[^/]+\/chat/.test(path)) {
        return { messages: rows, total: opts.total ?? rows.length };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path: string, body: unknown) => {
      posted.push({ path, body: body as Record<string, unknown> });
      if (opts.failPost) throw new Error('network down');
      return {};
    },
  };
  return { client, posted };
}

function signIn(userId = 'u-first-run-1') {
  useOpenStoaSession.setState({
    mode: 'authenticated',
    token: 'test-token',
    userId,
    nickname: 'tester',
    needsNickname: false,
    expiresAt: null,
    role: 'member',
  });
}

interface Mounted {
  rendered: Rendered;
  posted: Array<{ path: string; body: Record<string, unknown> }>;
  host: HostDouble;
  /** Render the tree again — the provider is never remounted by this. */
  rerender(): Promise<void>;
}

async function mount(opts: ClientOpts = {}, host: HostDouble = hostDouble()): Promise<Mounted> {
  const { client, posted } = clientDouble(opts);
  stub.client.current = client;

  /*
   * A FRESH element every time, and that is load-bearing.
   *
   * Re-`update()`ing with the identical element object lets React bail out of
   * reconciliation entirely — nothing re-renders, no effect re-runs, and both
   * latch cases below pass whether or not the latch exists. The first draft did
   * exactly that, and the RACE case caught it by expecting a SECOND note that
   * could never arrive. Same vacuous-pass shape `recoveryCodeMadeOnce` records
   * catching in itself.
   */
  const tree = () => (
    <HostProvider api={host.api as never}>
      <FirstRunRecoveryProvider>
        <Text>{CHILD}</Text>
      </FirstRunRecoveryProvider>
    </HostProvider>
  );

  const rendered = await render(tree());
  // The chain is getBackup → mark read → decide → create key → file the note;
  // each link is its own microtask turn, so a short flush lands mid-chain.
  await flush(20);

  return {
    rendered,
    posted,
    host,
    async rerender() {
      await rendered.update(tree());
      await flush(20);
    },
  };
}

beforeEach(() => {
  stub.code.current = CODE;
  stub.forced.current = null;
  stub.sealed.length = 0;
  signIn();
});

afterEach(() => {
  useOpenStoaSession.getState().clear();
});

describe('mounting the provider actually asks', () => {
  it('CONTRACT: the sheet is on screen with the key, and the children still render', async () => {
    /*
     * The defect this whole file is about: for the length of a release, this
     * assertion would have failed for the only reason that matters — nothing
     * rendered the sheet. The children assertion is the other half: a provider
     * that swallowed the navigator would "fix" the sheet by hiding the app.
     */
    const m = await mount();

    expect(m.rendered.text(), 'the sheet did not open').toContain(TITLE);
    expect(m.rendered.text(), 'the key is not on screen').toContain(CODE);
    expect(m.rendered.text(), 'the provider ate its children').toContain(CHILD);

    m.rendered.unmount();
  });

  it('CONTRACT: the note is filed in the PERSONAL room, sealed, with its warning', async () => {
    const m = await mount();

    expect(m.posted.map((p) => p.path)).toEqual(['/api/topics/personal-1/chat']);
    expect(stub.sealed).toHaveLength(1);
    expect(stub.sealed[0]).toContain(CODE);
    expect(stub.sealed[0]).toContain('openstoa.firstRunRecovery.noteWarning');

    m.rendered.unmount();
  });
});

describe('the copy is filed once per key', () => {
  it('REPETITION: five renders with the same code file ONE note', async () => {
    /*
     * THE latch. The effect re-runs on every render here (`t` changes identity),
     * so without `filedFor` this posts once per render and the room fills with
     * identical notes — which is a room nobody reads.
     *
     * MUTATION: deleting the `filedFor.current === code` guard turns this red
     * (5 posts instead of 1). Verified.
     */
    const m = await mount();
    await m.rerender();
    await m.rerender();
    await m.rerender();
    await m.rerender();

    expect(m.posted).toHaveLength(1);
    expect(stub.sealed).toHaveLength(1);

    m.rendered.unmount();
  });

  it('RACE: a DIFFERENT code is filed again', async () => {
    /*
     * The other direction, and the reason the latch holds the code rather than a
     * boolean. This provider wraps the navigator and is never remounted by tab
     * navigation, so a `useRef(false)` stays true for the whole app run — and a
     * second account signing in without an app restart would have its key shown
     * and never filed.
     *
     * MUTATION: replacing the latch with a bare `useRef(false)` turns this red
     * (the second code is never filed). Verified.
     */
    stub.forced.current = { prompt: { kind: 'show', reason: 'first-run' }, code: CODE };
    const m = await mount();
    expect(m.posted).toHaveLength(1);

    stub.forced.current = { prompt: { kind: 'show', reason: 'first-run' }, code: SECOND_CODE };
    await m.rerender();

    expect(m.posted).toHaveLength(2);
    expect(stub.sealed[0]).toContain(CODE);
    expect(stub.sealed[1]).toContain(SECOND_CODE);

    m.rendered.unmount();
  });

  it('CONTRACT: filed as soon as the key EXISTS, not when they confirm', async () => {
    /*
     * The note in their own room is precisely the copy that survives a
     * dismissal. Gating it on "I have saved it" would file it only for the
     * people who least need it — same reasoning `RecoveryRepair` gives for
     * sending the no-backup notice ahead of the banner's dismissal check.
     *
     * The mark is asserted too: `pending`, not `stored`. A dismissed sheet must
     * never look like a completed one, and the note being filed must not be
     * what makes it look that way.
     */
    const m = await mount();
    expect(m.posted, 'nothing was filed before the person acted').toHaveLength(1);

    const later = m.rendered.pressableWith(LATER);
    expect(later, 'the sheet offers no way out').toBeTruthy();
    await m.rendered.press(later!);

    expect(m.rendered.text(), 'the sheet stayed open after "not now"').not.toContain(TITLE);
    expect(m.posted, 'dismissing un-filed the note').toHaveLength(1);
    expect(m.host.localStore.items.get(RECOVERY_SHOWN_KEY)).toBe('pending');

    m.rendered.unmount();
  });
});

describe('the duplicate check refuses to guess', () => {
  it('INTEGRITY: a partial scan stops the write', async () => {
    /*
     * These notes are filed on an account's FIRST day, so they are the oldest
     * messages in the room — the far end from where a page of "latest" starts.
     * A scan that read the newest 500 of 900 proves nothing about the note, and
     * `alreadyFiled` throws rather than returning `true`, so a partial read is
     * never recorded as a settled "already there" either.
     */
    const m = await mount({ rows: [{ id: 'm1', body: 'hello' }], total: 900 });

    expect(m.posted, 'a second copy was filed on an unproven absence').toEqual([]);
    // …and the person still has their key on screen, which is the path that matters.
    expect(m.rendered.text()).toContain(CODE);

    m.rendered.unmount();
  });

  it('INTEGRITY: one undecryptable row stops the write', async () => {
    /*
     * The real decrypt path never throws — one bad row must not blank a page of
     * chat — so a room this device cannot read comes back as placeholders
     * containing no marker, which reads as "no note has ever been filed here".
     * Every launch would then file another, into a room where none of them can
     * be read.
     */
    const m = await mount({
      rows: [
        { id: 'm1', body: 'hello' },
        { id: 'm2', body: UNREADABLE },
      ],
    });

    expect(m.posted).toEqual([]);

    m.rendered.unmount();
  });

  it('REPETITION: a note already in the room stops the write', async () => {
    // The complete-scan path: absence really can be established here, and it
    // says the note is present.
    const already = recoveryCodeNote('an-older-code', {
      heading: 'openstoa.firstRunRecovery.noteHeading',
      warning: 'openstoa.firstRunRecovery.noteWarning',
    });
    const m = await mount({ rows: [{ id: 'm1', body: 'hello' }, { id: 'm2', body: already }] });

    expect(m.posted).toEqual([]);

    m.rendered.unmount();
  });
});

describe('what reaches the server', () => {
  it('INTEGRITY: SI-1 — the payload is ciphertext and holds no copy of the key', async () => {
    /*
     * `systemText` is a PLAINTEXT column the server reads (`lib/chat.ts`).
     * Filing the key there would put the value that opens `master_key` in the
     * database in the clear — the one value `keyManager` states never reaches
     * the server. This is the check that stops it coming back as a
     * simplification.
     */
    const m = await mount();

    expect(m.posted).toHaveLength(1);
    const body = m.posted[0].body;
    expect(body).toHaveProperty('ciphertext');
    expect(body).toHaveProperty('epoch');
    expect(body).not.toHaveProperty('systemText');
    expect(body).not.toHaveProperty('message');
    expect(JSON.stringify(body), 'the key was posted in the clear').not.toContain(CODE);

    m.rendered.unmount();
  });
});

describe('failure is silent', () => {
  it('EXTERNAL: a rejected send never reaches the sheet', async () => {
    /*
     * The sheet has already shown the key and asked for it to be written down.
     * A red line about the COPY failing reads as the key itself having failed,
     * which it did not — and it arrives while somebody is mid-way through
     * copying a string off the screen.
     */
    const m = await mount({ failPost: true });

    expect(m.rendered.text(), 'the copy failing was reported as the key failing').not.toContain(
      FAILED,
    );
    expect(m.rendered.text(), 'the key left the screen').toContain(CODE);

    m.rendered.unmount();
  });

  it('EXTERNAL: an offline topic lookup is equally silent', async () => {
    const m = await mount({ failTopics: true });

    expect(m.posted).toEqual([]);
    expect(m.rendered.text()).not.toContain(FAILED);
    expect(m.rendered.text()).toContain(CODE);

    m.rendered.unmount();
  });

  it('BOUNDARY: an account with no personal room is a no-op', async () => {
    const m = await mount({ topics: [{ id: 'shared-1' }] });

    expect(m.posted).toEqual([]);
    expect(m.rendered.text()).not.toContain(FAILED);

    m.rendered.unmount();
  });
});

describe('nothing is filed for an account that is not there', () => {
  it('AUTHZ: a signed-out app files nothing and shows nothing', async () => {
    useOpenStoaSession.getState().clear();

    const m = await mount();

    expect(m.posted).toEqual([]);
    expect(m.rendered.text()).not.toContain(TITLE);
    expect(m.rendered.text(), 'the children stopped rendering when signed out').toContain(CHILD);

    m.rendered.unmount();
  });

  it('EMPTY: no secure store means no master_key here — nothing to file', async () => {
    // `createCode` cannot run without it either, so the sheet reports a failure
    // rather than pretending; what matters for this file is that no note is
    // filed under a key that does not exist.
    const host = hostDouble({ secureStore: undefined });

    const m = await mount({}, host);

    expect(m.posted).toEqual([]);

    m.rendered.unmount();
  });
});
