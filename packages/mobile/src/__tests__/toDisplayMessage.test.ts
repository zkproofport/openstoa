import { describe, it, expect, vi } from 'vitest';
import type { ChatMessage } from '@openstoa/api-types';
import type { MlsSessionStore } from '../crypto/mlsSession';
import { toDisplayMessageMls } from '../crypto/mobileTransport';

/**
 * Blast-radius regression: ONE undecryptable row must never blank the whole
 * message list.
 *
 * The bug: `MlsSessionStore.open()` acquired the session OUTSIDE its try/catch,
 * so a bootstrap/rejoin failure REJECTED instead of returning null;
 * `toDisplayMessageMls` had no try/catch of its own; and ChatRoomScreen maps it
 * over a whole history page through `Promise.all`, which rejects wholesale on
 * the first rejection. Net effect: a single bad row emptied the entire chat.
 *
 * These tests pin the fixed contract — per-row soft failure, identical to the
 * web twin (`ChatPanel.tsx` `toDisplayMessage`). They fail if the try/catch in
 * `toDisplayMessageMls` is removed, because the assertions go through the same
 * `Promise.all` shape the screen uses.
 *
 * Matrix rows: race/fire-and-forget (one async failure must not break the
 * user-facing path), contract invocation (openCached vs open selection),
 * hostile/empty input (missing id, missing sealed, system rows), integrity
 * (UTF-8 bodies survive, siblings keep their own text).
 */

const PLACEHOLDER = '[unable to decrypt]';

function row(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm-1',
    topicId: 't-1',
    userId: 'u-1',
    nickname: 'alice',
    type: 'message',
    isAI: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    message: null,
    sealed: { ciphertext: 'c2VhbGVk', epoch: 0, takVersion: null },
    ...over,
  } as ChatMessage;
}

/** A store whose openCached resolves per id, or throws for ids in `throwOn`. */
function makeStore(opts: { throwOn?: Set<string>; nullOn?: Set<string> } = {}) {
  const openCached = vi.fn(async (_t: string, msgId: string) => {
    if (opts.throwOn?.has(msgId)) throw new Error(`MLS bootstrap failed for topic ${_t}`);
    if (opts.nullOn?.has(msgId)) return null;
    return `plaintext for ${msgId}`;
  });
  const open = vi.fn(async () => 'plaintext without id');
  return {
    store: { openCached, open } as unknown as MlsSessionStore,
    openCached,
    open,
  };
}

describe('toDisplayMessageMls — one bad row never takes down the page', () => {
  it('a THROWING openCached yields the placeholder for that row only', async () => {
    const { store } = makeStore({ throwOn: new Set(['m-2']) });
    const rows = [row({ id: 'm-1' }), row({ id: 'm-2' }), row({ id: 'm-3' })];

    // Exactly the shape ChatRoomScreen uses (useInfiniteQuery queryFn + the SSE
    // reconnect catch-up): Promise.all over the whole page.
    const decrypted = await Promise.all(rows.map((m) => toDisplayMessageMls(store, 't-1', m)));

    expect(decrypted).toHaveLength(3);
    expect(decrypted[0].message).toBe('plaintext for m-1'); // sibling intact
    expect(decrypted[1].message).toBe(PLACEHOLDER); // the failing row, soft
    expect(decrypted[2].message).toBe('plaintext for m-3'); // sibling intact
  });

  it('the page still resolves when EVERY row throws', async () => {
    const { store } = makeStore({ throwOn: new Set(['m-1', 'm-2']) });
    const decrypted = await Promise.all(
      [row({ id: 'm-1' }), row({ id: 'm-2' })].map((m) => toDisplayMessageMls(store, 't-1', m)),
    );
    expect(decrypted.map((d) => d.message)).toEqual([PLACEHOLDER, PLACEHOLDER]);
  });

  it('a throwing row never rejects on its own either', async () => {
    const { store } = makeStore({ throwOn: new Set(['m-1']) });
    await expect(toDisplayMessageMls(store, 't-1', row({ id: 'm-1' }))).resolves.toMatchObject({
      id: 'm-1',
      message: PLACEHOLDER,
    });
  });

  it('a non-Error rejection (string throw) is caught too', async () => {
    const store = {
      openCached: vi.fn(async () => {
        throw 'boom'; // eslint-disable-line no-throw-literal
      }),
      open: vi.fn(),
    } as unknown as MlsSessionStore;
    await expect(toDisplayMessageMls(store, 't-1', row())).resolves.toMatchObject({
      message: PLACEHOLDER,
    });
  });

  it('a null return (pre-join epoch) is still the same placeholder', async () => {
    const { store } = makeStore({ nullOn: new Set(['m-2']) });
    const decrypted = await Promise.all(
      [row({ id: 'm-1' }), row({ id: 'm-2' })].map((m) => toDisplayMessageMls(store, 't-1', m)),
    );
    expect(decrypted.map((d) => d.message)).toEqual(['plaintext for m-1', PLACEHOLDER]);
  });

  it('mixed page: throw + null + success all coexist, order preserved', async () => {
    const { store } = makeStore({ throwOn: new Set(['m-2']), nullOn: new Set(['m-3']) });
    const rows = ['m-1', 'm-2', 'm-3', 'm-4'].map((id) => row({ id }));
    const decrypted = await Promise.all(rows.map((m) => toDisplayMessageMls(store, 't-1', m)));
    expect(decrypted.map((d) => d.id)).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
    expect(decrypted.map((d) => d.message)).toEqual([
      'plaintext for m-1',
      PLACEHOLDER,
      PLACEHOLDER,
      'plaintext for m-4',
    ]);
  });
});

describe('toDisplayMessageMls — contract invocation and pass-through', () => {
  it('uses openCached when the row has an id, plain open when it does not', async () => {
    const { store, openCached, open } = makeStore();
    await toDisplayMessageMls(store, 't-1', row({ id: 'm-9' }));
    expect(openCached).toHaveBeenCalledWith('t-1', 'm-9', { ciphertext: 'c2VhbGVk', epoch: 0, takVersion: null });
    expect(open).not.toHaveBeenCalled();

    const noId = await toDisplayMessageMls(store, 't-1', row({ id: undefined as never }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(noId.message).toBe('plaintext without id');
  });

  it('a throwing open() (no-id path) also degrades per row', async () => {
    const store = {
      openCached: vi.fn(),
      open: vi.fn(async () => {
        throw new Error('no session');
      }),
    } as unknown as MlsSessionStore;
    await expect(
      toDisplayMessageMls(store, 't-1', row({ id: undefined as never })),
    ).resolves.toMatchObject({ message: PLACEHOLDER });
  });

  it('system rows (join/leave) pass through untouched, no decrypt attempted', async () => {
    const { store, openCached, open } = makeStore();
    const sys = row({ id: 's-1', type: 'join', message: 'alice joined', sealed: null as never });
    await expect(toDisplayMessageMls(store, 't-1', sys)).resolves.toBe(sys); // same object
    expect(openCached).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('a message row with no sealed body becomes empty text, not the placeholder', async () => {
    const { store, openCached } = makeStore();
    const bare = row({ sealed: null as never });
    await expect(toDisplayMessageMls(store, 't-1', bare)).resolves.toMatchObject({ message: '' });
    expect(openCached).not.toHaveBeenCalled();
  });

  it('integrity: UTF-8 plaintext (Korean, emoji) is returned verbatim', async () => {
    const body = '회의 3시 🎉';
    const store = { openCached: vi.fn(async () => body), open: vi.fn() } as unknown as MlsSessionStore;
    await expect(toDisplayMessageMls(store, 't-1', row())).resolves.toMatchObject({ message: body });
  });
});
