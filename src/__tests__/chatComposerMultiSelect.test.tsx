// @vitest-environment jsdom
/**
 * ChatPanel composer — attaching SEVERAL images at once, mounted for real.
 *
 * THE DEFECT, from device testing: "웹은 이미지 멀티 셀렉트가 안되네" — the web
 * cannot select multiple images. The mini-app has picked several photos in one
 * trip and sent them as separate messages for a while
 * (`packages/mobile/src/lib/pickedAttachments.ts`); the web's file input had no
 * `multiple` and its change handler read `files[0]`.
 *
 * WHY BOTH HALVES ARE PINNED HERE, and why neither alone would do:
 *   • `multiple` without the loop is a WORSE bug than the original. The picker
 *     would offer three, accept three, and send one — silently, with nothing on
 *     screen naming the two that were dropped.
 *   • the loop without `multiple` is unreachable: the browser hands over one
 *     file however good the handler is.
 * So the count test is the load-bearing one — it is the assertion a `files[0]`
 * handler sitting behind a `multiple` attribute fails.
 *
 * The send path is REAL down to `sendEncryptedChatMedia`, which is doubled: the
 * type sniff, the HEIC branch and the size cap all still run, so a file this
 * test calls sent is one the shipped composer would also have accepted.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract     — the input accepts more than one file
 *   contract     — THREE files selected produce THREE sends, in pick order
 *   integrity    — one bad file does not sink the rest of the selection: a
 *                  non-image in the middle still leaves the other two sent
 *   boundary     — one file still sends exactly once (no regression on the
 *                  path that already worked)
 *   empty        — a cleared picker (change with no files) sends nothing
 *   integrity    — the input is reset after a selection, so picking the same
 *                  photos again still fires `change`
 *   hostile/UTF-8/very large/authz/race — N/A here: bytes, mime sniffing, the
 *                  size cap and the failure rows are `sendImage`'s and
 *                  `chatMediaSendFailure.test.tsx`'s subject, and this file
 *                  deliberately does not re-test them.
 *
 * THE CLIPBOARD IS THE SAME DEFECT, and the second describe covers it. The
 * paste handler had `.find()` where the input had `files[0]` — one image out of
 * a multi-image clipboard, the rest dropped silently. Same helper, same
 * guarantee. It carries two extra hazards the input does not:
 *   empty      — a TEXT paste must be left to the browser. An unconditional
 *                `preventDefault` here breaks ordinary pasting into the
 *                composer, which is worse than the bug being fixed.
 *   race       — `getAsFile()` must run synchronously inside the event.
 *                `clipboardData.items` dies when the handler returns, so
 *                reading it after an await yields null and the paste vanishes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOPIC = '11111111-2222-4333-8444-555555555555';
const ME = 'nullifier-me';

// ─── MLS doubles ─────────────────────────────────────────────────────────────

const mlsStore = {
  openCached: vi.fn(async (_t: string, _id: string, s: { ciphertext: string }) => `plain(${s.ciphertext})`),
  open: vi.fn(async (_t: string, s: { ciphertext: string }) => `plain(${s.ciphertext})`),
  seal: vi.fn(async (_t: string, plaintext: string) => ({ ciphertext: `ct-own-${plaintext}`, epoch: 0 })),
  cachePlaintext: vi.fn(async () => {}),
};

const takStore = {
  backfill: vi.fn(async () => [] as { messageId: string; plaintext: string }[]),
  myDeviceId: vi.fn(async () => 'device-1'),
  distributeRoot: vi.fn(async () => 0),
  grantPrivateHistory: vi.fn(async () => {}),
  sealForPush: vi.fn(async () => null),
  archiveOnSend: vi.fn(async () => {}),
  sealMedia: vi.fn(async () => ({ key: new Uint8Array(32), version: 0 })),
};

vi.mock('@/lib/mls/webTransport', () => ({
  getMlsSessionStore: () => mlsStore,
  getTakSessionStore: () => takStore,
  getDeviceKeyState: async () => 'ready',
  recoverDeviceWithPasskey: async () => true,
}));

/**
 * PARTIAL mock, same rationale as `chatComposerNewline.test.tsx`: only the
 * seal-and-upload step is doubled. `resolveChatMediaMime`, the HEIC sniff and
 * the size cap stay REAL, so this file cannot certify a selection the shipped
 * composer would have refused.
 *
 * It RECORDS the bytes it was handed, because "three sends happened" and "the
 * three files that were picked were sent, in order" are different claims and
 * only the second one rules out a handler that sent the first file three times.
 */
const sentBytes: number[] = [];
const sendEncryptedChatMedia = vi.fn(async (input: { bytes: Uint8Array; mime: string }) => {
  sentBytes.push(input.bytes[input.bytes.length - 1]);
  return {
    v: 1,
    key: `chat/${TOPIC}/${ME}/a0b1c2d3e4f5061728394a5b6c7d8e9f`,
    mediaId: 'a0b1c2d3e4f5061728394a5b6c7d8e9f',
    takVersion: 0,
    mime: input.mime,
    size: input.bytes.length,
  };
});
vi.mock('@/lib/chatMedia', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chatMedia')>();
  return { ...actual, sendEncryptedChatMedia: (...args: unknown[]) => sendEncryptedChatMedia(...(args as [never])) };
});

const { default: ChatPanel } = await import('@/components/ChatPanel');
const { I18nProvider } = await import('@/lib/i18n/I18nProvider');

// ─── EventSource double ──────────────────────────────────────────────────────

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    const l = this.listeners.get(type) ?? [];
    l.push(fn);
    this.listeners.set(type, l);
  }
  close() {}
  open() {
    this.onopen?.();
  }
  static get last(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }
}

// ─── HTTP double ─────────────────────────────────────────────────────────────

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

function installFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/auth/session') return json({ userId: ME });
      if (url === `/api/topics/${TOPIC}`) {
        return json({ topic: { visibility: 'public' }, currentUserRole: 'member' });
      }
      if (url.startsWith(`/api/topics/${TOPIC}/chat?`)) return json({ messages: [], total: 0 });
      if (url === `/api/topics/${TOPIC}/chat`) {
        return json({ message: { id: `m-${Date.now()}-${Math.random()}` } }, true, 201);
      }
      if (url === `/api/topics/${TOPIC}/chat/delivered`) {
        return json({ deliveredThrough: new Date().toISOString() });
      }
      return json({ error: 'not found' }, false, 404);
    }),
  );
}

// ─── Harness ─────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount() {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <ChatPanel topicId={TOPIC} isGuest={false} isMember={true} />
      </I18nProvider>,
    );
  });
  await flush();
  // The composer is disabled until the stream is live.
  await act(async () => FakeEventSource.last.open());
  await flush();
}

/** The hidden `<input type="file">` the attach button drives. */
function fileInput(): HTMLInputElement {
  const el = container.querySelector('input[type="file"]');
  if (!el) throw new Error('no file input rendered');
  return el as HTMLInputElement;
}

/**
 * A PNG whose LAST byte identifies it.
 *
 * Only the 8-byte signature has to be real — `resolveChatMediaMime` sniffs the
 * magic and the seal step is doubled — and the marker is what lets the
 * assertions say WHICH files arrived and in what order, rather than only how
 * many calls happened.
 */
function markedPng(marker: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker]);
}

/** Select `files`, exactly as a browser does: set `files`, dispatch `change`. */
async function pick(files: Array<{ name: string; type: string; bytes: Uint8Array }>) {
  const handles = files.map(({ name, type, bytes }) => {
    const file = new File([bytes as BlobPart], name, { type });
    // jsdom's File has no arrayBuffer() in some versions — the component needs it.
    if (typeof (file as unknown as { arrayBuffer?: unknown }).arrayBuffer !== 'function') {
      Object.defineProperty(file, 'arrayBuffer', {
        value: async () => bytes.buffer.slice(0),
        configurable: true,
      });
    }
    return file;
  });
  // jsdom's FileList is read-only; define the property the handler reads.
  Object.defineProperty(fileInput(), 'files', { value: handles, configurable: true });
  await act(async () => {
    fileInput().dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

/**
 * Dispatch a paste carrying `items`, the way a browser does.
 *
 * `getAsFile` is a function on each item rather than a stored File, because
 * that is the shape the real `DataTransferItem` has — and it is what lets the
 * "read it synchronously" rule be violated by a wrong implementation and
 * caught here rather than only on a real machine.
 */
async function paste(
  items: Array<{ type: string; file?: File | null }>,
): Promise<{ defaultPrevented: boolean }> {
  const el = container.querySelector('textarea');
  if (!el) throw new Error('no composer found');
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: {
      items: items.map((i) => ({ type: i.type, getAsFile: () => i.file ?? null })),
    },
  });
  await act(async () => {
    el.dispatchEvent(ev);
  });
  await flush();
  return { defaultPrevented: ev.defaultPrevented };
}

/** An image on the clipboard, identified by its last byte like the picks. */
function clipboardImage(marker: number): { type: string; file: File } {
  const bytes = markedPng(marker);
  const file = new File([bytes as BlobPart], `pasted-${marker}.png`, { type: 'image/png' });
  if (typeof (file as unknown as { arrayBuffer?: unknown }).arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => bytes.buffer.slice(0),
      configurable: true,
    });
  }
  return { type: 'image/png', file };
}

/** Three ordinary photos, the case the reporter could not do at all. */
function threePhotos() {
  return [
    { name: 'one.png', type: 'image/png', bytes: markedPng(1) },
    { name: 'two.png', type: 'image/png', bytes: markedPng(2) },
    { name: 'three.png', type: 'image/png', bytes: markedPng(3) },
  ];
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sentBytes.length = 0;
  sendEncryptedChatMedia.mockClear();
  FakeEventSource.instances = [];
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  Element.prototype.scrollTo = function scrollTo() {};
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
  installFetch();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('ChatPanel composer — several images in one pick', () => {
  it('CONTRACT: the picker accepts more than one file', async () => {
    await mount();
    expect(
      fileInput().multiple,
      'the file input is single-select — the picker will never offer more than one photo',
    ).toBe(true);
  });

  it('CONTRACT: three files picked are three sends, in pick order', async () => {
    await mount();
    await pick(threePhotos());

    expect(
      sendEncryptedChatMedia,
      'the selection was truncated — a `files[0]` handler behind a `multiple` input',
    ).toHaveBeenCalledTimes(3);
    expect(sentBytes, 'the three sends were not the three files, in the order they were picked')
      .toEqual([1, 2, 3]);
  });

  it('INTEGRITY: one unusable file does not sink the rest of the selection', async () => {
    await mount();
    // The middle one is not an image at all. The real `resolveChatMediaMime`
    // refuses it, `sendImage` reports it, and the two either side must still go.
    await pick([
      { name: 'one.png', type: 'image/png', bytes: markedPng(1) },
      { name: 'notes.txt', type: 'text/plain', bytes: new Uint8Array([0x68, 0x69, 0x21]) },
      { name: 'three.png', type: 'image/png', bytes: markedPng(3) },
    ]);

    expect(sentBytes, 'a refused file in the middle cancelled the rest of the pick').toEqual([1, 3]);
  });

  it('BOUNDARY: a single file still sends exactly once', async () => {
    await mount();
    await pick([{ name: 'only.png', type: 'image/png', bytes: markedPng(7) }]);
    expect(sentBytes).toEqual([7]);
  });

  it('EMPTY: a cleared picker sends nothing and does not throw', async () => {
    await mount();
    Object.defineProperty(fileInput(), 'files', { value: [], configurable: true });
    await act(async () => {
      fileInput().dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(sendEncryptedChatMedia).not.toHaveBeenCalled();
  });

  it('INTEGRITY: the input is reset, so the same photos can be picked again', async () => {
    // Without the reset the browser fires no `change` for an identical
    // selection, and the second attempt silently does nothing.
    await mount();
    await pick(threePhotos());
    expect(fileInput().value).toBe('');
  });
});

describe('ChatPanel composer — several images on one clipboard', () => {
  it('CONTRACT: three pasted images are three sends, in clipboard order', async () => {
    await mount();
    const { defaultPrevented } = await paste([
      clipboardImage(1),
      clipboardImage(2),
      clipboardImage(3),
    ]);

    // Prevented, because the alternative is the browser ALSO pasting the
    // images' filenames into the composer as text.
    expect(defaultPrevented).toBe(true);
    expect(
      sendEncryptedChatMedia,
      'the clipboard was truncated — a `.find()` handler takes one image and drops the rest',
    ).toHaveBeenCalledTimes(3);
    expect(sentBytes, 'the three sends were not the three pasted images, in clipboard order')
      .toEqual([1, 2, 3]);
  });

  it('BOUNDARY: a single pasted image still uploads exactly once', async () => {
    await mount();
    const { defaultPrevented } = await paste([clipboardImage(7)]);
    expect(defaultPrevented).toBe(true);
    expect(sentBytes).toEqual([7]);
  });

  it('EMPTY: a text-only clipboard is left to the browser', async () => {
    await mount();
    const { defaultPrevented } = await paste([{ type: 'text/plain' }]);

    // The regression this pins: an unconditional `preventDefault` stops
    // ordinary text pasting into the composer — a worse bug than the one being
    // fixed, and one no other assertion in this file would catch.
    expect(defaultPrevented, 'a plain text paste was swallowed').toBe(false);
    expect(sendEncryptedChatMedia).not.toHaveBeenCalled();
  });

  it('INTEGRITY: a mixed clipboard sends every image and skips the text', async () => {
    // Copying pictures out of a web page routinely puts text/plain and
    // text/html on the clipboard alongside them.
    await mount();
    const { defaultPrevented } = await paste([
      { type: 'text/plain' },
      clipboardImage(1),
      { type: 'text/html' },
      clipboardImage(2),
    ]);
    expect(defaultPrevented).toBe(true);
    expect(sentBytes).toEqual([1, 2]);
  });

  it('HOSTILE: image items that yield no file do not swallow the paste', async () => {
    // `getAsFile()` returning null for an `image/*` item is a real browser
    // behaviour. Preventing the default and sending nothing would consume the
    // user's paste and show them nothing at all.
    await mount();
    const { defaultPrevented } = await paste([
      { type: 'image/png', file: null },
      { type: 'text/plain' },
    ]);
    expect(defaultPrevented, 'the paste was consumed but nothing was sent').toBe(false);
    expect(sendEncryptedChatMedia).not.toHaveBeenCalled();
  });

  it('RACE: the clipboard is read synchronously, before any send is awaited', async () => {
    // The real `clipboardData.items` is dead once the handler returns. This
    // double models that refusal — after the event, `getAsFile` throws — so an
    // implementation that reads the clipboard from inside the async send fails
    // here instead of only on a real machine.
    await mount();
    const el = container.querySelector('textarea')!;
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    let alive = true;
    const images = [clipboardImage(1), clipboardImage(2)];
    Object.defineProperty(ev, 'clipboardData', {
      value: {
        items: images.map((i) => ({
          type: i.type,
          getAsFile: () => {
            if (!alive) throw new Error('clipboardData read after the paste event ended');
            return i.file;
          },
        })),
      },
    });
    await act(async () => {
      el.dispatchEvent(ev);
      // The event has returned; a real browser has released the clipboard.
      alive = false;
    });
    await flush();

    expect(sentBytes, 'the clipboard was read too late — the files came back empty').toEqual([1, 2]);
  });
});
