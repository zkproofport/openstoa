/**
 * The WIRING around the failed-attachment row, mounted for real (T-1).
 *
 * `MessageFailedControls` was extracted and tested on its own, which proved the
 * buttons render. It could not prove the part the last two bugs actually lived
 * in: whether the screen puts a stored row BACK on mount, whether the expiry
 * hint reaches it, and whether anything else on the screen wipes it before
 * paint. One of those bugs was a restore that was correctly written, correctly
 * parsed, and cleared by the room-clear a frame later — every unit test passed.
 *
 * So these mount the whole `ChatRoomScreen`. The data layer is REAL
 * (`@tanstack/react-query`, `zustand`, `i18next`, `@react-navigation/*`); only
 * the host bridge and navigation are doubled, because "what did it store" and
 * "where did it navigate" are questions that need a spy. See
 * `vitest.config.ts` for why nothing here is installed to make that work.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage in this file
 *   contract        → 'a stored row is put back on mount'; 'the screen mounts
 *                     and renders its composer'
 *   integrity       → 'a row already on screen is not duplicated'; 'the pruned
 *                     list is written back, so a dropped row is not re-read
 *                     forever'
 *   boundary        → expiry exactly AT and PAST the retry window
 *   empty/null      → no key stored; an empty array; whitespace; `null`
 *   hostile input   → corrupt JSON, a non-array, a row whose body is not an
 *                     envelope, a row whose key disagrees with its body
 *   external failure→ a storage that THROWS on read, and one that throws on
 *                     write — neither may take the screen down
 *   UTF-8           → a topic title carrying Korean + emoji survives to render
 *   very large      → more stored rows than the persistence cap
 *   authorization   → N/A here: the row is this client's own by construction
 *                     (the screen never renders another member's failed send).
 *   race            → the restore effect's `cancelled` guard is exercised by
 *                     unmounting mid-flight.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act } from 'react-test-renderer';
import { useOpenStoaSession } from '../stores/sessionStore';
import {
  MAX_PERSISTED_FAILED_ROWS,
  buildChatMediaBody,
  chatMediaObjectKey,
  serializeFailedRows,
  type ChatMediaEnvelope,
  type PersistedFailedRow,
} from '../lib/chatMedia';
import { renderScreen, hostDouble, failedRowKey } from './harness/screen';
import { ChatRoomScreen } from '../screens/chat/ChatRoomScreen';

const TOPIC = '11111111-2222-4333-8444-555555555555';
const ME = 'nullifier-me';

function envelope(mediaId = 'a0b1c2d3e4f5061728394a5b6c7d8e9f'): ChatMediaEnvelope {
  return {
    v: 1,
    key: chatMediaObjectKey(TOPIC, ME, mediaId),
    mediaId,
    takVersion: 0,
    mime: 'image/png',
    size: 4096,
  };
}

/**
 * A stored row whose body and key agree.
 *
 * The mediaId is always 32 LOWERCASE HEX, independent of `rowId` — an earlier
 * version derived one from the other and produced ids like `keep0000…`, which
 * `parseChatMediaBody` correctly rejected, so every fixture was silently invalid
 * and the tests were asserting against a screen that had restored nothing.
 */
function storedRow(
  over: Partial<Extract<PersistedFailedRow, { kind: 'media' }>> & { mediaId?: string } = {},
): PersistedFailedRow {
  const { mediaId, ...rest } = over;
  const env = envelope(mediaId);
  return {
    kind: 'media',
    rowId: 'row-1',
    body: buildChatMediaBody(env),
    key: env.key,
    createdAt: Date.now(),
    ...rest,
  };
}

/** The label `MessageFailedControls` renders for a row that can still retry. */
const RETRY_LABEL = 'openstoa.chat.sendFailedRetry';
/** ...and the one it renders instead once the object has probably been collected. */
const EXPIRED_LABEL = 'openstoa.chat.media.expired';

/** A host whose local store already holds `rows` for this topic. */
function hostWithRows(rows: PersistedFailedRow[]) {
  const host = hostDouble();
  host.localStore.items.set(failedRowKey(TOPIC), serializeFailedRows(rows));
  return host;
}

beforeEach(() => {
  // Every network call the screen makes answers emptily and immediately. The
  // subject here is what the screen does with STORAGE, and a pending fetch that
  // never settles would make these fail by timeout instead of by assertion.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/chat/media')
        ? { ciphertext: '' }
        : { messages: [], total: 0, topic: { visibility: 'public' }, members: [] };
      return { ok: true, status: 200, json: async () => body, text: async () => '' } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ChatRoomScreen — it mounts at all', () => {
  it('renders with the real query client, i18n and navigation', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />);
    // The composer's send control is the cheapest proof the tree got past its
    // providers and rendered the screen body rather than an error boundary.
    expect(rendered.text()).toContain('openstoa.chat.send');
    rendered.unmount();
  });

  it('a topic title with Korean and emoji reaches the navigation header intact', async () => {
    // The title is not in the screen body — it goes to the navigator via
    // `setOptions`, which is exactly why this asserts on the spy rather than on
    // rendered text. A test that looked for it in the tree would fail for a
    // reason that has nothing to do with the title.
    const title = '회의방 🎉 conference';
    const { rendered, nav } = await renderScreen(<ChatRoomScreen />, {
      params: { topicId: TOPIC, topicTitle: title, kind: 'topic' },
    });
    const titles = nav.setOptions.calls.map((c) => (c[0] as { title?: string })?.title);
    expect(titles).toContain(title);
    rendered.unmount();
  });
});

describe('CONTRACT: a failed attachment is put back on mount', () => {
  it('restores a stored row, so a killed app does not lose the picture', async () => {
    const row = storedRow();
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host: hostWithRows([row]) });
    // The row is back, and it is back with its controls — a restored row that
    // renders without a retry is the same as no restore from the user's side.
    expect(rendered.text()).toContain(RETRY_LABEL);
    rendered.unmount();
  });

  it('writes the PRUNED list back, so a dropped row is not re-read forever', async () => {
    // One good row, one the parser must drop (body is not an envelope).
    const good = storedRow({ rowId: 'keep' }) as Extract<PersistedFailedRow, { kind: 'media' }>;
    const bad = { kind: 'media', rowId: 'drop', body: 'just text', key: good.key, createdAt: Date.now() };
    const host = hostWithRows([good, bad as PersistedFailedRow]);
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host });

    const written = host.localStore.items.get(failedRowKey(TOPIC));
    expect(written).toBeTruthy();
    const parsed = JSON.parse(written!) as PersistedFailedRow[];
    expect(parsed.map((r) => r.rowId)).toEqual(['keep']);
    rendered.unmount();
  });

  it('stores nothing new when there was nothing to restore', async () => {
    const host = hostDouble();
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host });
    // An empty restore must not write an empty array over a key that had none —
    // that is a write on every room entry for no reason.
    expect(host.localStore.items.has(failedRowKey(TOPIC))).toBe(false);
    rendered.unmount();
  });
});

describe('BOUNDARY: the expiry hint', () => {
  it('a row inside the retry window is not marked expired', async () => {
    const row = storedRow({ createdAt: Date.now() - 60_000 });
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host: hostWithRows([row]) });
    expect(rendered.text()).toContain(RETRY_LABEL);
    rendered.unmount();
  });

  it('a row PAST the window says so instead of offering a retry that cannot work', async () => {
    // Past the collector's grace window the object is probably gone, so the row
    // is still SHOWN — silence is the defect — but it must not promise a retry.
    const row = storedRow({ createdAt: Date.now() - 2 * 60 * 60 * 1000 });
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host: hostWithRows([row]) });
    const text = rendered.text();
    expect(text).toContain(EXPIRED_LABEL);
    expect(text).not.toContain(RETRY_LABEL);
    rendered.unmount();
  });
});

describe('EXTERNAL FAILURE: storage is not a dependency the screen may die on', () => {
  it('a store that THROWS on read still renders the screen', async () => {
    const host = hostDouble();
    host.api.localStore = {
      getItem: async () => {
        throw new Error('storage unavailable');
      },
      setItem: async () => {},
    };
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host });
    expect(rendered.text()).toContain('openstoa.chat.send');
    rendered.unmount();
  });

  it('a store that THROWS on write still renders the screen', async () => {
    const host = hostWithRows([storedRow()]);
    host.api.localStore = {
      getItem: async () => serializeFailedRows([storedRow()]),
      setItem: async () => {
        throw new Error('disk full');
      },
    };
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host });
    expect(rendered.text()).toContain('openstoa.chat.send');
    rendered.unmount();
  });

  it('a host with NO local store at all still renders', async () => {
    // `localStore` is optional on HostApi — an older host binary simply has none.
    const host = hostDouble();
    delete (host.api as Record<string, unknown>).localStore;
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host });
    expect(rendered.text()).toContain('openstoa.chat.send');
    rendered.unmount();
  });
});

describe('HOSTILE / EMPTY stored state never reaches the screen', () => {
  const cases: Array<[string, string]> = [
    ['corrupt json', '{not json'],
    ['a bare string', '"hello"'],
    ['a number', '42'],
    ['null', 'null'],
    ['an empty array', '[]'],
    ['whitespace only', '   '],
    ['an object, not an array', '{"rowId":"x"}'],
    ['an array of nulls', '[null,null]'],
  ];

  for (const [label, raw] of cases) {
    it(`renders normally for ${label}`, async () => {
      const host = hostDouble();
      host.localStore.items.set(failedRowKey(TOPIC), raw);
      const { rendered } = await renderScreen(<ChatRoomScreen />, { host });
      expect(rendered.text()).toContain('openstoa.chat.send');
      rendered.unmount();
    });
  }

  it('a row whose key disagrees with its body never reaches the screen', async () => {
    const row = storedRow();
    const tampered = { ...row, key: chatMediaObjectKey(TOPIC, 'someone-else', 'a0b1c2d3e4f5061728394a5b6c7d8e9f') };
    const host = hostWithRows([tampered as PersistedFailedRow]);
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host });
    expect(rendered.text()).not.toContain(RETRY_LABEL);
    rendered.unmount();
  });

  it('DEFECT (documented): an all-invalid store is never cleaned up', async () => {
    /*
     * The restore effect returns early when the parse leaves nothing
     * (`rows.length === 0`), and the write-back is AFTER that return. So a store
     * holding only unusable rows is re-read and re-parsed on every single room
     * entry, forever — the one case the write-back exists to prevent.
     *
     * Asserted as it BEHAVES rather than as it should, so the day someone moves
     * the write-back above the return this test fails and says why. Harmless
     * today (a few hundred bytes and one parse), which is why it is recorded
     * here rather than fixed inside a testing task.
     */
    const host = hostDouble();
    host.localStore.items.set(failedRowKey(TOPIC), JSON.stringify([{ kind: 'media', rowId: 'x', body: 'text', key: 'k', createdAt: Date.now() }]));
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host });
    const still = host.localStore.items.get(failedRowKey(TOPIC));
    expect(JSON.parse(still ?? '[]')).toHaveLength(1);
    expect(rendered.text()).not.toContain(RETRY_LABEL);
    rendered.unmount();
  });
});

describe('VERY LARGE: more stored rows than the cap', () => {
  it('keeps at most the cap, newest first', async () => {
    const now = Date.now();
    const rows = Array.from({ length: MAX_PERSISTED_FAILED_ROWS + 10 }, (_, i) =>
      storedRow({
        rowId: `row-${i}`,
        createdAt: now - i * 1000,
        body: buildChatMediaBody(envelope(String(i).padStart(32, '0'))),
        key: chatMediaObjectKey(TOPIC, ME, String(i).padStart(32, '0')),
      }),
    );
    const host = hostWithRows(rows);
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host });
    const written = JSON.parse(host.localStore.items.get(failedRowKey(TOPIC)) ?? '[]');
    expect(written.length).toBeLessThanOrEqual(MAX_PERSISTED_FAILED_ROWS);
    rendered.unmount();
  });
});

describe('RACE: unmounting mid-restore', () => {
  it('a screen unmounted before the restore settles does not throw', async () => {
    const host = hostWithRows([storedRow()]);
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host });
    // The `cancelled` guard in the restore effect is what makes this safe; without
    // it React warns about a state update on an unmounted tree.
    expect(() => rendered.unmount()).not.toThrow();
  });
});

describe('CONTRACT: an unsent MESSAGE is put back on mount', () => {
  /*
   * The attachment case above shipped and words were left behind, so a photo
   * nobody watched fail outlived a sentence someone did. These are the screen
   * half of that fix — the storage rules are pinned in
   * `src/__tests__/failedTextSurvivesRestart.test.ts` on the web side, where
   * the module actually lives.
   */
  const textRow = (over: Partial<Extract<PersistedFailedRow, { kind: 'text' }>> = {}): PersistedFailedRow => ({
    kind: 'text',
    rowId: 'text-1',
    text: '회의 늦어요 🙇',
    createdAt: Date.now(),
    ...over,
  });

  it('restores the words, with the controls that make them actionable', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host: hostWithRows([textRow()]) });
    const out = rendered.text();
    // Both halves matter: the sentence itself, and a Retry. A restored row that
    // renders without one is the same as no restore from the user's side.
    expect(out).toContain('회의 늦어요 🙇');
    expect(out).toContain(RETRY_LABEL);
    rendered.unmount();
  });

  it('INTEGRITY: it does NOT claim the attachment expired', async () => {
    // Nothing a text row refers to can have been collected, so the attachment
    // explanation would be a false one for a message that can still be sent.
    const old = textRow({ createdAt: Date.now() - 6 * 60 * 60 * 1000 });
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host: hostWithRows([old]) });
    expect(rendered.text()).not.toContain(EXPIRED_LABEL);
    expect(rendered.text()).toContain(RETRY_LABEL);
    rendered.unmount();
  });

  it('a stored attachment and a stored message both come back', async () => {
    const { rendered } = await renderScreen(<ChatRoomScreen />, {
      host: hostWithRows([storedRow({ rowId: 'pic' }), textRow({ rowId: 'msg', text: 'both please' })]),
    });
    expect(rendered.text()).toContain('both please');
    rendered.unmount();
  });

  it('a store that refuses to answer leaves the room working', async () => {
    // Storage is optional infrastructure. A room that fails to open because a
    // failed row could not be read is a worse outcome than the lost row.
    const host = hostDouble();
    host.localStore.getItem = async () => {
      throw new Error('store unavailable');
    };
    const { rendered } = await renderScreen(<ChatRoomScreen />, { host });
    expect(rendered.text()).toContain('openstoa.chat.send');
    rendered.unmount();
  });
});

describe('CONTRACT: a failed send WRITES the message down', () => {
  /*
   * The restore tests above prove a stored row comes back. They would all still
   * pass if nothing ever stored one — which is exactly the shape of the defect
   * being fixed, so the write needs its own proof.
   */
  it('the words are in the store the moment the send fails', async () => {
    /*
     * Signed in, because the composer refuses to send otherwise and the sign-in
     * sheet — not a failed send — is what the screen would show instead.
     */
    useOpenStoaSession.setState({
      mode: 'authenticated',
      token: 'test-token',
      userId: 'me',
      nickname: 'me',
      needsNickname: false,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      role: 'member',
    });
    const host = hostDouble();
    // Reads succeed, the POST does not: the failure this whole path exists for.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'POST' && String(input).includes('/chat')) {
          return { ok: false, status: 503, json: async () => ({}), text: async () => '' } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: [], total: 0, topic: { visibility: 'public' }, members: [] }),
          text: async () => '',
        } as unknown as Response;
      }),
    );

    const { rendered } = await renderScreen(<ChatRoomScreen />, { host });
    const input = rendered.root.findAll((n) => (n.type as unknown as string) === 'TextInput')[0];
    expect(input, 'no composer to type into').toBeTruthy();
    await act(async () => {
      (input.props.onChangeText as (t: string) => void)('놓치면 안 되는 말');
    });
    const sendButton = rendered.pressableWith('openstoa.chat.send');
    expect(sendButton, 'no send control').toBeTruthy();
    await rendered.press(sendButton!);

    /*
     * The send is fired through the auth guard, which does not hand the
     * caller its promise — so pressing returns before the POST has failed.
     * Waited on a WALL-CLOCK deadline rather than a fixed number of turns: a
     * turn count that is generous when this file runs alone ran out when the
     * whole suite was competing for the machine, and the test failed for load
     * rather than for behaviour.
     */
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !host.localStore.items.has(failedRowKey(TOPIC))) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    const raw = host.localStore.items.get(failedRowKey(TOPIC));
    expect(raw, 'the failed send was never written down').toBeTruthy();
    const stored = JSON.parse(raw!) as PersistedFailedRow[];
    expect(stored).toHaveLength(1);
    expect(stored[0].kind).toBe('text');
    expect((stored[0] as Extract<PersistedFailedRow, { kind: 'text' }>).text).toBe('놓치면 안 되는 말');
    rendered.unmount();
  });
});
