/*
 * An account with no backup is told so, in its own room, exactly once.
 *
 * WHAT IS AT STAKE ON EACH SIDE, because every assertion here is on one axis or
 * the other and neither side is the "safe" one:
 *
 *   silence    → the person loses every encrypted conversation they have and
 *                only finds out when the replacement phone shows empty rooms.
 *   repetition → their room fills with the same alarm, they stop reading it,
 *                and the one that mattered is buried under nineteen copies.
 *
 * THE AXIS IS CUMULATIVE, and that is the point of this file. `RecoveryRepair`
 * runs this on every launch, so the question is never "does one call behave" —
 * it is "does the twentieth launch add a twentieth message". Every guard below
 * is therefore driven through a room that REMEMBERS what was posted to it and
 * serves it back as history, and asserted on the total after N runs. A test that
 * called the function once would pass with the duplicate suppression deleted.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   repetition (THE guard) → 20 launches with no backup file ONE message
 *   repetition             → 20 launches that all FAIL, then one that works,
 *                            file one message — a failure never counts as sent
 *   repetition             → an unreadable room is written to zero times, twenty
 *                            launches running
 *   repetition             → a room longer than one scan is written to zero
 *                            times: absence was never established
 *   escalation             → a different fact gets its own single message
 *   decision               → every (wrap × passkey × coverage) combination maps
 *                            to one health, table-driven
 *   contract               → the PERSONAL room, not the first one listed
 *   contract               → the body carries the heading AND the instructions
 *   contract               → exactly one file in the mini-app sends this, and it
 *                            does so before the banner-dismissal check
 *   integrity              → the payload is ciphertext; no `systemText` (SI-1)
 *   hostile                → a message that merely contains a marker, or starts
 *                            with a DIFFERENT note's marker, suppresses nothing
 *   boundary               → empty room, no personal room, exactly-full page
 *   UTF-8                  → Korean and emoji copy survives the round trip and
 *                            is still recognised afterwards
 *   external               → every network failure returns, never throws, and
 *                            never writes
 *   i18n                   → both kinds exist in en AND ko, and neither tells an
 *                            iPhone user the false thing about deleting the app
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  backupHealth,
  noticeKindFor,
  type BackupHealthInputs,
  type KeychainCoverage,
} from '../lib/backupHealth';
import {
  backupNotice,
  backupNoticeKindOf,
  filedBackupNoticeKinds,
  BACKUP_NOTICE_MARKERS,
} from '../lib/backupNotice';
import { RECOVERY_NOTE_MARKER } from '../lib/recoveryCodeNote';
import { SCAN_LIMIT, refuseUnreadable, type OpenRow } from '../lib/personalRoomNote';
import { sendBackupNotice, type BackupNoticeCopy } from '../lib/sendBackupNotice';

const UNREADABLE = '\u{1F512} locked';

const COPY: BackupNoticeCopy = {
  none: {
    heading: 'Your chats are locked to this phone',
    body: 'Profile → Chat recovery makes a key you can keep somewhere else.',
  },
  unopenable: {
    heading: 'Your recovery key would not open these chats',
    body: 'Set recovery up again from this phone.',
  },
};

const NO_BACKUP = backupHealth({
  authenticated: true,
  hasRecoveryWrap: false,
  hasPasskey: false,
  keychain: 'present',
});
const CANNOT_OPEN = backupHealth({
  authenticated: true,
  hasRecoveryWrap: true,
  hasPasskey: false,
  keychain: 'untrusted',
});

/**
 * A personal room that REMEMBERS.
 *
 * Anything posted comes back as history on the next read, sealed, exactly as the
 * server would serve it — which is what makes "run it twenty times" a real
 * question rather than twenty independent first runs.
 */
function room(
  opts: {
    topics?: Array<{ id: string; personal?: boolean }>;
    seed?: string[];
    topicsThrows?: boolean;
    chatThrows?: boolean;
    postThrows?: boolean;
    /** History rows beyond what one scan can read. */
    hiddenOlder?: number;
  } = {},
) {
  const topics = opts.topics ?? [{ id: 'personal-1', personal: true }];
  /** Plaintext bodies, oldest first. */
  const history: string[] = [...(opts.seed ?? [])];
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  const sealedPlaintexts: string[] = [];
  const state = { ...opts };

  const seal = (plaintext: string) => `SEALED(${plaintext})`;
  const unseal = (ciphertext: string) => ciphertext.slice('SEALED('.length, -1);

  const client = {
    get: (async (path: string) => {
      if (path === '/api/topics') {
        if (state.topicsThrows) throw new Error('offline');
        return { topics };
      }
      if (/^\/api\/topics\/[^/]+\/chat/.test(path)) {
        if (state.chatThrows) throw new Error('cannot read history');
        // Newest first, capped at the page size — the real endpoint's shape.
        const newestFirst = [...history].reverse().slice(0, SCAN_LIMIT);
        return {
          messages: newestFirst.map((body, i) => ({
            id: `m${i}`,
            type: 'message',
            sealed: { ciphertext: seal(body), epoch: 1 },
          })),
          total: history.length + (state.hiddenOlder ?? 0),
        };
      }
      throw new Error(`unexpected GET ${path}`);
    }) as <T>(path: string) => Promise<T>,
    post: (async (path: string, body: unknown) => {
      if (state.postThrows) throw new Error('network down');
      posted.push({ path, body: body as Record<string, unknown> });
      history.push(unseal((body as { ciphertext: string }).ciphertext));
      /*
       * A server-assigned id, because the real endpoint returns one and the note
       * path needs it to cache the plaintext. Returning `{}` made every send
       * report `sent-uncached` — a fake simpler than reality in exactly the
       * place reality mattered. See `filedNoteIsReadableByItsAuthor`.
       */
      return { message: { id: `m${posted.length}` } };
    }) as <T>(path: string, body: unknown) => Promise<T>,
  };

  const sealer = {
    // The real sealer (`MlsSessionStore`) has this; without it a filed note is
    // unreadable to its own author, because MLS gives a sender no way to decrypt
    // its own message. See `filedNoteIsReadableByItsAuthor`.
    cachePlaintext: async () => {},
    seal: async (_topicId: string, plaintext: string) => {
      sealedPlaintexts.push(plaintext);
      return { ciphertext: seal(plaintext), epoch: 1 };
    },
  };

  const open: OpenRow = async (_topicId, row) => unseal(row.sealed?.ciphertext ?? 'SEALED()');

  return { client, sealer, open, posted, sealedPlaintexts, history, state };
}

describe('the no-backup notice is filed once, no matter how many launches', () => {
  it('REPETITION: twenty launches with no backup leave ONE message', async () => {
    /*
     * THE guard. `RecoveryRepair` runs on every launch and the account's state
     * does not change by itself, so without duplicate suppression this room
     * ends up holding twenty identical alarms — which is the same as holding
     * none, because nobody reads a room like that.
     */
    const h = room();

    for (let i = 0; i < 20; i++) {
      await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);
    }

    expect(h.posted).toHaveLength(1);
    expect(h.history.filter((b) => backupNoticeKindOf(b) === 'none')).toHaveLength(1);
  });

  it('REPETITION: twenty FAILED launches then a working one leave ONE message', async () => {
    /*
     * A failure must not be recorded as "said". The opposite mistake — treating
     * a failed send as done — is silence about something unrecoverable, and it
     * would look identical from the outside to the guard working.
     */
    const h = room({ postThrows: true });

    for (let i = 0; i < 20; i++) {
      const r = await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);
      expect(r.kind).toBe('failed');
    }
    expect(h.posted).toEqual([]);

    h.state.postThrows = false;
    for (let i = 0; i < 20; i++) {
      await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);
    }

    expect(h.posted).toHaveLength(1);
  });

  it('REPETITION: a room this device cannot read is never written to', async () => {
    /*
     * The real decrypt path fails SOFT — one unreadable row must not blank a
     * page of chat — so an unreadable room comes back as a wall of placeholder
     * text containing no marker, which reads as "nothing has ever been filed
     * here". Twenty launches would file twenty notes, every one of them
     * unreadable, in a room nobody can open.
     */
    const h = room({ seed: ['old message'] });
    const blind = refuseUnreadable(async () => UNREADABLE, UNREADABLE);

    for (let i = 0; i < 20; i++) {
      const r = await sendBackupNotice(h.client, h.sealer, blind, NO_BACKUP, COPY);
      expect(r.kind).toBe('failed');
    }

    expect(h.posted).toEqual([]);
  });

  it('REPETITION: a room taller than one scan is never written to', async () => {
    /*
     * These notes are filed early in an account's life, so they sit at the OLD
     * end of the room — the far end from where a page of "latest" starts. A
     * scan that read only the newest page and reported "not here" would file a
     * second copy for somebody who already has one, and keep doing it.
     */
    const h = room({ seed: ['recent chatter'], hiddenOlder: 1 });

    for (let i = 0; i < 20; i++) {
      const r = await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);
      expect(r.kind).toBe('failed');
    }

    expect(h.posted).toEqual([]);
  });

  it('ESCALATION: a different fact gets its own single message', async () => {
    /*
     * "You have no backup" and "your backup does not open these rooms" are
     * different things to be told, and somebody who fixed the first can still
     * hit the second months later. Suppressing by kind rather than by family is
     * what lets the second one through — once.
     */
    const h = room();

    for (let i = 0; i < 20; i++) {
      await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);
    }
    for (let i = 0; i < 20; i++) {
      await sendBackupNotice(h.client, h.sealer, h.open, CANNOT_OPEN, COPY);
    }

    expect(h.posted).toHaveLength(2);
    expect(filedBackupNoticeKinds(h.history)).toEqual(new Set(['none', 'unopenable']));
  });

  it('REPETITION: a healthy account is never written to at all', async () => {
    const h = room();
    const healthy = backupHealth({
      authenticated: true,
      hasRecoveryWrap: true,
      hasPasskey: false,
      keychain: 'present',
    });

    for (let i = 0; i < 20; i++) {
      const r = await sendBackupNotice(h.client, h.sealer, h.open, healthy, COPY);
      expect(r).toEqual({ kind: 'not-needed', health: 'ok' });
    }

    expect(h.posted).toEqual([]);
  });
});

describe('what the message is, and where it goes', () => {
  it('CONTRACT: it goes to the PERSONAL room, not the first one listed', async () => {
    // A warning about this account's keys, delivered into a shared room, is a
    // warning delivered to everybody in it.
    const h = room({
      topics: [{ id: 'shared-1' }, { id: 'shared-2' }, { id: 'personal-1', personal: true }],
    });

    const r = await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);

    expect(r).toEqual({ kind: 'sent', topicId: 'personal-1' });
    expect(h.posted[0].path).toBe('/api/topics/personal-1/chat');
  });

  it('CONTRACT: the body carries the heading AND what to do about it', async () => {
    /*
     * The alarming half without the instructions is a message that makes
     * somebody feel bad and change nothing.
     */
    const h = room();

    await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);

    expect(h.sealedPlaintexts).toHaveLength(1);
    expect(h.sealedPlaintexts[0]).toContain(COPY.none.heading);
    expect(h.sealedPlaintexts[0]).toContain(COPY.none.body);
    expect(h.sealedPlaintexts[0].startsWith(BACKUP_NOTICE_MARKERS.none)).toBe(true);
  });

  it('INTEGRITY: the payload is ciphertext, never a system message (SI-1)', async () => {
    /*
     * `systemText` is a plaintext column the server reads. Nothing here is
     * secret, but a server-authored row in a person's own room is exactly the
     * property this product says it does not have.
     */
    const h = room();

    await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);

    const body = h.posted[0].body;
    expect(body).toHaveProperty('ciphertext');
    expect(body).toHaveProperty('epoch');
    expect(body).not.toHaveProperty('systemText');
    expect(body).not.toHaveProperty('message');
  });

  it('UTF-8: Korean and emoji copy round-trips and stays recognisable', async () => {
    const korean: BackupNoticeCopy = {
      none: {
        heading: '이 대화는 이 휴대폰에만 잠겨 있습니다 🔐',
        body: '프로필 → 채팅 복구에서 복구 키를 만드세요.\n탭\t줄바꿈 포함.',
      },
      unopenable: { heading: '복구 키가 열지 못합니다', body: '다시 설정하세요.' },
    };
    const h = room();

    await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, korean);
    // Same launch again: the Korean note must recognise itself.
    await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, korean);

    expect(h.posted).toHaveLength(1);
    expect(h.history.at(-1)).toContain(korean.none.heading);
    expect(h.history.at(-1)).toContain(korean.none.body);
  });

  it('BOUNDARY: an empty room is written to, once', async () => {
    const h = room({ seed: [] });

    await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);
    await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);

    expect(h.posted).toHaveLength(1);
  });

  it('BOUNDARY: an exactly-full page is still a complete scan', async () => {
    /*
     * `total === messages.length` at the page ceiling means the room is exactly
     * that tall, not that it is taller. Reading it as "partial" would silence
     * the notice for every account that lands on the boundary.
     */
    const seed = Array.from({ length: SCAN_LIMIT }, (_, i) => `note ${i}`);
    const h = room({ seed });

    const r = await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);

    expect(r.kind).toBe('sent');
  });

  it('BOUNDARY: an account with no personal room is a no-op, not an error', async () => {
    const h = room({ topics: [{ id: 'shared-1' }] });

    const r = await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);

    expect(r).toEqual({ kind: 'no-room' });
    expect(h.posted).toEqual([]);
  });
});

describe('recognising a note that is already there', () => {
  it('HOSTILE: a message that merely CONTAINS a marker suppresses nothing', async () => {
    /*
     * Somebody quoting the warning back at themselves, or an unrelated message
     * that happens to use the emoji, must not stand in for the real note — a
     * false match here is permanent silence about something unrecoverable.
     */
    const h = room({ seed: [`I saw ${BACKUP_NOTICE_MARKERS.none}this warning somewhere`] });

    const r = await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);

    expect(r.kind).toBe('sent');
  });

  it('HOSTILE: another kind of note does not stand in for this one', async () => {
    const h = room({ seed: [backupNotice('unopenable', COPY.unopenable)] });

    const r = await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);

    expect(r.kind).toBe('sent');
  });

  it('HOSTILE: the recovery-key note is not one of these', async () => {
    /*
     * Both notes live in the same room and both are recognised by a leading
     * glyph. A collision would make one silence the other, and the one silenced
     * would be whichever is filed second.
     */
    const filed = `${RECOVERY_NOTE_MARKER}Your recovery key\n\nabcd-efgh`;

    expect(backupNoticeKindOf(filed)).toBeNull();
    for (const marker of Object.values(BACKUP_NOTICE_MARKERS)) {
      expect(marker.startsWith(RECOVERY_NOTE_MARKER)).toBe(false);
      expect(RECOVERY_NOTE_MARKER.startsWith(marker)).toBe(false);
    }
  });

  it('CONTRACT: the markers are distinct and neither prefixes the other', () => {
    const markers = Object.values(BACKUP_NOTICE_MARKERS);
    expect(new Set(markers).size).toBe(markers.length);
    expect(markers[0].startsWith(markers[1])).toBe(false);
    expect(markers[1].startsWith(markers[0])).toBe(false);
  });

  it('EMPTY: nothing to check is not a match', () => {
    expect(filedBackupNoticeKinds([]).size).toBe(0);
    expect(backupNoticeKindOf('')).toBeNull();
    expect(backupNoticeKindOf('   ')).toBeNull();
  });
});

describe('external failures are returned, never thrown, and never written', () => {
  const cases: Array<[string, Parameters<typeof room>[0]]> = [
    ['the topic list is unreachable', { topicsThrows: true }],
    ['the history is unreachable', { chatThrows: true }],
    ['the send fails', { postThrows: true }],
  ];

  for (const [name, opts] of cases) {
    it(`EXTERNAL: ${name} → failed, no write`, async () => {
      const h = room(opts);

      const r = await sendBackupNotice(h.client, h.sealer, h.open, NO_BACKUP, COPY);

      expect(r.kind).toBe('failed');
      expect(h.posted).toEqual([]);
    });
  }
});

describe('deciding whether there is anything to say', () => {
  const base: BackupHealthInputs = {
    authenticated: true,
    hasRecoveryWrap: false,
    hasPasskey: false,
    keychain: 'present',
  };

  it('DECISION: no wrap of any kind, with keys at stake → tell them', () => {
    for (const keychain of ['present', 'uploaded', 'untrusted'] as KeychainCoverage[]) {
      expect(backupHealth({ ...base, keychain }).kind).toBe('none');
    }
  });

  it('DECISION: either kind of wrap is a backup', () => {
    expect(backupHealth({ ...base, hasRecoveryWrap: true }).kind).toBe('ok');
    expect(backupHealth({ ...base, hasPasskey: true }).kind).toBe('ok');
    expect(backupHealth({ ...base, hasRecoveryWrap: true, hasPasskey: true }).kind).toBe('ok');
  });

  it('DECISION: a wrap whose snapshot this device cannot open is not a backup', () => {
    expect(backupHealth({ ...base, hasRecoveryWrap: true, keychain: 'untrusted' }).kind).toBe(
      'unopenable',
    );
  });

  it('DECISION: an account with no chat keys is told nothing', () => {
    /*
     * The mistake `recoveryNudge.ts` was written to stop making: warning
     * somebody at signup about history they have not made yet. Holds whether or
     * not they have a wrap.
     */
    expect(backupHealth({ ...base, keychain: 'empty' }).kind).toBe('nothing-at-stake');
    expect(backupHealth({ ...base, keychain: 'empty', hasRecoveryWrap: true }).kind).toBe(
      'nothing-at-stake',
    );
  });

  it('DECISION: nothing is claimed on a guess', () => {
    // Signed out.
    expect(backupHealth({ ...base, authenticated: false }).kind).toBe('unknown');
    // The upload path could not reach the server.
    expect(backupHealth({ ...base, keychain: 'failed' }).kind).toBe('unknown');
    // The wrap lookup did not answer. Null is not "no".
    expect(backupHealth({ ...base, hasRecoveryWrap: null }).kind).toBe('unknown');
    expect(backupHealth({ ...base, hasPasskey: null }).kind).toBe('unknown');
    // And a signed-out session is unknown even when everything else looks bad.
    expect(backupHealth({ ...base, authenticated: false, keychain: 'failed' }).kind).toBe('unknown');
  });

  it('DECISION: only the two dangerous states produce a notice', () => {
    const quiet: BackupHealthInputs[] = [
      { ...base, authenticated: false },
      { ...base, keychain: 'failed' },
      { ...base, hasRecoveryWrap: null },
      { ...base, keychain: 'empty' },
      { ...base, hasRecoveryWrap: true },
    ];
    for (const input of quiet) expect(noticeKindFor(backupHealth(input))).toBeNull();

    expect(noticeKindFor(backupHealth(base))).toBe('none');
    expect(
      noticeKindFor(backupHealth({ ...base, hasRecoveryWrap: true, keychain: 'untrusted' })),
    ).toBe('unopenable');
  });
});

/* ------------------------------------------------------------------------- *
 * Where the notice is sent from, asserted over the whole mini-app rather than
 * by mounting one component: a second caller added anywhere — a screen, a hook,
 * a new provider — is a second notice per launch, and it would not fail a test
 * that only checked the one place it was expected.
 * ------------------------------------------------------------------------- */

const SRC = join(__dirname, '..');
const THE_SENDER = 'components/RecoveryRepair.tsx';

/** Comments describe the call; they are not the call. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('exactly one thing sends it', () => {
  it('CONTRACT: one file calls sendBackupNotice, and it is RecoveryRepair', () => {
    const callers = walk(SRC)
      .filter((f) => relative(SRC, f) !== 'lib/sendBackupNotice.ts')
      .filter((f) => /\bsendBackupNotice\s*\(/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC, f));

    expect(callers).toEqual([THE_SENDER]);
  });

  it('CONTRACT: it is sent before the banner-dismissal check', () => {
    /*
     * Dismissing the banner means "stop showing me this on Profile". It does
     * not mean the account acquired a backup — and the message in the person's
     * own room is precisely the copy that is supposed to outlive the dismissal.
     * Moving the send below the early return would make a single tap silence
     * the only durable warning there is, with every other test still green.
     */
    const src = stripComments(readFileSync(join(SRC, THE_SENDER), 'utf8'));
    const send = src.indexOf('sendBackupNotice(');
    const dismissed = src.indexOf('recoveryNudgeDismissKey(');

    expect(send).toBeGreaterThan(-1);
    expect(dismissed).toBeGreaterThan(-1);
    expect(send).toBeLessThan(dismissed);
  });

  it('CONTRACT: the scan refuses rows this device cannot read', () => {
    // Losing this wrapper is silent: everything still passes, and a device that
    // has lost its keys quietly starts filing a notice per launch.
    const src = stripComments(readFileSync(join(SRC, THE_SENDER), 'utf8'));
    expect(src).toMatch(/refuseUnreadable\s*\(/);
    expect(src).toContain('UNREADABLE_BODY');
  });
});

describe('the words, in both languages', () => {
  const locales = ['en', 'ko'] as const;

  function copyFor(locale: string): Record<string, { heading: string; body: string }> {
    const json = JSON.parse(readFileSync(join(SRC, `i18n/locales/${locale}.json`), 'utf8'));
    return json.openstoa.backupNotice;
  }

  for (const locale of locales) {
    it(`I18N: ${locale} has both kinds, non-empty`, () => {
      const copy = copyFor(locale);
      for (const kind of ['none', 'unopenable'] as const) {
        expect(copy[kind]?.heading?.trim()).toBeTruthy();
        expect(copy[kind]?.body?.trim()).toBeTruthy();
      }
    });

    it(`I18N: ${locale} never tells an iPhone user to back up before deleting the app`, () => {
      /*
       * `expo-secure-store` keeps its items on iOS across an app deletion and
       * does NOT on Android. "Back up before you uninstall" is therefore false
       * for every iPhone reader — and a warning caught being wrong once is a
       * warning the next one does not survive. Reinstalling may only be named
       * as an Android-specific case.
       */
      const body = copyFor(locale).none.body;
      const mentionsReinstall = /reinstall|uninstall|delet|삭제|다시 설치|재설치|지우면/i.test(body);
      if (mentionsReinstall) {
        expect(body).toMatch(/Android|안드로이드/i);
      }
      // The unqualified claim, in either language.
      expect(body).not.toMatch(/before you (delete|uninstall)/i);
      expect(body).not.toMatch(/앱을 삭제하기 전에/);
    });
  }
});
