'use client';

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { relativeTime } from '@/lib/utils';
import Badge from '@/components/Badge';
import Spinner from '@/components/Spinner';
import LinkPreview from '@/components/LinkPreview';
import { isSyncingHistory, nextPendingId, isProvisionalId } from '@/lib/chatStatus';
import TopicMuteToggle from '@/components/TopicMuteToggle';
import { useTranslation } from '@/lib/i18n/I18nProvider';
import Link from 'next/link';
import {
  getMlsSessionStore,
  getTakSessionStore,
  getDeviceKeyState,
  recoverDeviceWithPasskey,
  type DeviceKeyState,
  type RecoveryOutcome,
} from '@/lib/mls/webTransport';
import type { ArchiveRootState, Visibility } from '@/lib/mls/takSession';
import {
  DecryptOnce,
  fetchCatchup,
  mergeChronological,
  isOwnMessage,
  newestCreatedAt,
  sinceCursor,
  CATCHUP_PAGE_LIMIT,
  HISTORY_PAGE_LIMIT,
} from '@/lib/chatSync';

// The panel is a client component but Next still renders it once on the server,
// where useLayoutEffect warns. The scroll-anchor restore must run before paint
// (a useEffect would show one frame at the wrong offset), so pick per platform.
const useBrowserLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

// Server rows for user messages carry an encrypted `sealed` body, not plaintext.
// Decrypt for local display so MessageRow keeps rendering `msg.message` as text.
// System rows (join/leave) carry plaintext `message` and pass through unchanged.
interface RawChatMessage {
  id?: string;
  type?: string;
  sealed?: { ciphertext: string; epoch: number } | null;
  message?: string;
  createdAt?: string;
}

async function toDisplayMessage(
  topicId: string,
  raw: RawChatMessage,
  // Plaintext of messages THIS panel just sent, keyed by sealed ciphertext.
  // Consulted before any MLS work — see `pendingSendsRef`.
  pendingSends?: Map<string, string>,
): Promise<ChatMessage> {
  if (raw?.type === 'message') {
    let text = '';
    if (raw.sealed?.ciphertext) {
      // An MLS sender can NEVER decrypt its own application message (its send
      // ratchet has already advanced). The SSE echo of a message we just sent
      // can outrun the POST response that carries the server-assigned id, so
      // resolve it from the plaintext we still hold rather than attempting a
      // decrypt that is guaranteed to fail. Without this the echo resolves to
      // '[unable to decrypt]' and the id-dedupe below then KEEPS that row.
      const own = pendingSends?.get(raw.sealed.ciphertext);
      if (own != null) {
        text = own;
      } else {
        try {
          // openCached: MLS keys are consumed on first decrypt (forward secrecy),
          // so cache the plaintext by id → history survives reloads/restarts.
          const opened = raw.id
            ? await getMlsSessionStore().openCached(topicId, raw.id, raw.sealed)
            : await getMlsSessionStore().open(topicId, raw.sealed);
          text = opened ?? '';
        } catch {
          text = '';
        }
      }
      // Sealed body, no plaintext: the message is LOCKED for this device, not
      // blank. Flagged so the renderer can say that honestly and back-fill can
      // find these rows later.
      if (text === '') return { ...(raw as ChatMessage), message: '', undecryptable: true };
    }
    return { ...(raw as ChatMessage), message: text };
  }
  return raw as ChatMessage;
}

// Match the mobile chat URL detector (ChatRoomScreen.tsx). Keep them in
// sync so the same message renders an OG card on both surfaces.
const URL_REGEX = /(https?:\/\/[^\s]+)/g;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?.*)?$/i;

function extractFirstUrl(text: string): string | null {
  URL_REGEX.lastIndex = 0;
  const m = URL_REGEX.exec(text);
  URL_REGEX.lastIndex = 0;
  return m ? m[1] : null;
}

function isUrlOnly(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text.trim());
}

// Same heuristic as mobile: extension or media.zkproofport.app host.
function isImageUrl(url: string): boolean {
  if (IMAGE_EXT_RE.test(url)) return true;
  try {
    return new URL(url).hostname.endsWith('media.zkproofport.app');
  } catch {
    return false;
  }
}

// Render plain text with embedded URLs turned into clickable links.
// `linkColor` differs inside an own-message bubble, where the accent-on-accent
// link would be unreadable (mobile does the same — `linkOwn` vs `linkOther`).
function renderLinkedText(text: string, linkColor = 'var(--accent)'): React.ReactNode {
  URL_REGEX.lastIndex = 0;
  const out: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_REGEX.exec(text)) !== null) {
    const start = match.index;
    if (start > lastIndex) out.push(text.slice(lastIndex, start));
    out.push(
      <a
        key={start}
        href={match[1]}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ color: linkColor, textDecoration: 'underline', wordBreak: 'break-all' }}
      >
        {match[1]}
      </a>,
    );
    lastIndex = start + match[1].length;
  }
  URL_REGEX.lastIndex = 0;
  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface PresenceUser {
  userId: string;
  nickname: string;
  profileImage?: string;
  connectedAt: string;
}

interface ChatMessage {
  id: string;
  topicId: string;
  userId: string;
  nickname: string;
  profileImage?: string;
  message: string;
  type: 'message' | 'join' | 'leave';
  isAI?: boolean;
  createdAt: string;
  /**
   * This device holds no key for this message — it is sealed, not empty.
   *
   * A FLAG, not a sentinel string. This used to be `message === '[unable to
   * decrypt]'`, which meant an internal marker was also the user-facing text,
   * so a screen full of them read as a broken app. It also meant a real
   * message whose plaintext happened to equal that string would be silently
   * treated as a failure. Back-fill (TAK) flips this to false once the key
   * arrives; the renderer shows a locked placeholder, never raw English.
   */
  undecryptable?: boolean;
  /**
   * On screen, not yet acknowledged by the server. The bubble is drawn from the
   * text the user typed the instant they hit send — waiting for the round trip
   * meant the chat sat empty while the message was already gone from the
   * composer, which reads as "did that send?". Replaced by the real row (same
   * text, server id) when the POST returns; removed if it never does.
   */
  pending?: boolean;
  /**
   * The send failed and the message is still sitting here, unsent. Kept ON
   * SCREEN with a way to retry or discard: silently removing it and pushing the
   * text back into the composer looked like the app had eaten the message, and
   * left the user unsure whether it had gone out.
   */
  failed?: boolean;
  /** Original text, so Retry can send exactly what the user wrote. */
  draft?: string;
}

interface ChatPanelProps {
  /** Roomier type scale + spacing — used by the chat rail (a wide column) and
   *  the full-screen mobile sheet / standalone `/chat/[id]` and `/dm/[id]`
   *  pages, where the docked panel's compact scale would look cramped. */
  roomy?: boolean;
  topicId: string;
  isGuest: boolean;
  isMember: boolean;
  /** When true, panel fills its parent height (used in mobile full-screen) */
  fullHeight?: boolean;
  /** Hide the header (used when parent provides its own header) */
  hideHeader?: boolean;
  /** Close handler for mobile overlay */
  onClose?: () => void;
  /** Keep the card chrome (surface + border) while still filling the parent
   *  height — used by the docked desktop chat column. */
  framed?: boolean;
  /** Topic name for the header. Falls back to the generic "Live Chat" label. */
  title?: string;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  // Containing block for `OfflineNotice`, which overlays the bottom of the
  // panel rather than taking a row above the list.
  position: 'relative',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-card)',
  marginBottom: 'var(--space-3)',
  overflow: 'hidden',
};

const panelFullHeightStyle: React.CSSProperties = {
  // Containing block for `OfflineNotice` — see `panelStyle`.
  position: 'relative',
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  overflow: 'hidden',
};

// Docked chat column: fills the sidebar height but keeps the card chrome so it
// reads as part of the same surface family as the other sidebar cards.
const panelFramedFullHeightStyle: React.CSSProperties = {
  ...panelFullHeightStyle,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-card)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-2)',
  padding: '10px var(--space-4)',
  borderBottom: '1px solid var(--border)',
  flexShrink: 0,
};

const headerLeftStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
};

// Pair this with `className="os-label"` at every usage site: the uppercase +
// tracking idiom belongs to that class, which gates it to :lang(en). This
// label translates ("실시간 채팅"), and tracking on Hangul reads as broken
// kerning. Size/weight/family also come from the class.
const headerTitleStyle: React.CSSProperties = {
  color: 'var(--muted)',
};

// Latin/numeric-only ("N online"), so the label floor (--text-label) applies
// rather than the Korean-prose floor — bumped up from the original 11px
// (below even that floor).
const onlineCountStyle: React.CSSProperties = {
  fontSize: 'var(--text-label)',
  fontFamily: 'var(--font-mono)',
  color: 'var(--muted)',
  marginLeft: 4,
};

// Persistent E2EE strip, directly under whichever header the host supplies
// (the panel's own, or the rail's / the standalone page's when `hideHeader`).
// Korean prose, so it sits at the caption step — `--text-label` is reserved
// for uppercase Latin.
const e2eeStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  padding: 'var(--space-2) var(--space-4)',
  fontSize: 'var(--text-caption)',
  lineHeight: 1.4,
  color: 'var(--color-brand-accent)',
  background: 'color-mix(in srgb, var(--color-brand-accent) 10%, transparent)',
  borderBottom: '1px solid var(--border)',
  flexShrink: 0,
};

const connStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  marginLeft: 'auto',
  color: 'var(--color-text-tertiary)',
  whiteSpace: 'nowrap',
};

// Composer controls — round, at the touch minimum, so attach and send read as
// one family and neither depends on how long the word "Send" is in the active
// locale.
const composerIconButtonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 'var(--touch-target-min)',
  height: 'var(--touch-target-min)',
  minWidth: 'var(--touch-target-min)',
  minHeight: 'var(--touch-target-min)',
  borderRadius: 'var(--radius-pill)',
  padding: 0,
  flexShrink: 0,
};

const messagesContainerStyle: React.CSSProperties = {
  maxHeight: 400,
  overflowY: 'auto' as const,
  padding: '10px var(--space-4)',
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 6,
};

// ─── Avatar dots component ────────────────────────────────────────────────────

function PresenceDots({ users, max = 5 }: { users: PresenceUser[]; max?: number }) {
  const shown = users.slice(0, max);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {shown.map((u) =>
        u.profileImage ? (
          <img
            key={u.userId}
            src={u.profileImage}
            alt={u.nickname}
            title={u.nickname}
            style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              objectFit: 'cover',
              border: '1px solid var(--border)',
            }}
          />
        ) : (
          <div
            key={u.userId}
            title={u.nickname}
            style={{
              width: 18,
              height: 18,
              borderRadius: '50%',
              background: 'var(--accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              // A single initial inside a fixed 18x18px dot. Still held to the
              // 12px floor — a 12px glyph is ~9px tall, so it fits.
              fontSize: 'var(--text-label)',
              fontWeight: 700,
              color: 'var(--color-text-inverted)',
              border: '1px solid var(--border)',
              flexShrink: 0,
            }}
          >
            {u.nickname.charAt(0).toUpperCase()}
          </div>
        )
      )}
      {users.length > max && (
        // Numeric-only overflow count, not inside a fixed-size circle — safe
        // to bump to the label floor (was 10px).
        <span style={{ fontSize: 'var(--text-label)', color: 'var(--muted)', marginLeft: 2 }}>
          +{users.length - max}
        </span>
      )}
    </div>
  );
}

// ─── E2EE banner ──────────────────────────────────────────────────────────────

/**
 * States the product's central claim on the surface where it applies.
 *
 * Before this, nothing in the web chat UI said messages are end-to-end
 * encrypted — the word "encrypt" appeared only in implementation comments, so
 * the one property that distinguishes this chat from every other one was
 * invisible to the person using it.
 *
 * The connection state rides on the right (`connected` omitted → not shown, as
 * on the guest/non-member panel, where there is no stream to be connected to).
 * It replaces a bare 7px dot whose only label was a `title` attribute:
 * invisible to a screen reader, and ambiguous to everyone else.
 *
 * `aria-live` WITHOUT `role="status"` is deliberate: `LockedHistoryNotice`
 * above is the panel's one `role="status"` element and `lockedHistory.test.tsx`
 * asserts on that selector being absent when no history is locked. A bare
 * `aria-live="polite"` container is announced identically by assistive tech.
 */
/*
 * The connection state used to ride on the right of this line. It moved to the
 * header dot, because a chip that says "Connected" and then "Reconnecting"
 * changes width, wraps to a second row at panel widths, and shifts the entire
 * message list down and back every time the stream blinks. A colour in the
 * header carries the same information without occupying a line that can grow.
 *
 * A connection that stays down is not a chip-sized problem anyway — after ten
 * seconds the panel says so in a dialog (`OfflineNotice`), which is the only
 * point at which the reader has to do something about it.
 */
function E2eeBanner({ connected }: { connected?: boolean }) {
  const { t } = useTranslation();
  const state = connected ? t('chat.connected') : t('chat.reconnecting');
  return (
    <div style={e2eeStyle} data-testid="chat-e2ee-banner">
      <span aria-hidden="true">🔒</span>
      <span style={{ minWidth: 0 }}>{t('chat.e2ee')}</span>
      {connected !== undefined && (
        <span
          data-testid="chat-connection-state"
          aria-live="polite"
          aria-atomic="true"
          aria-label={`${t('chat.connectionStatusLabel')}: ${state}`}
          title={state}
          style={{
            // 6px, whatever it is saying. The word it replaces changed width
            // between "Connected" and "Reconnecting", wrapped this line to two
            // rows at panel widths, and shifted the whole conversation down and
            // back on every blink of the stream.
            width: 6,
            height: 6,
            borderRadius: 'var(--radius-pill)',
            background: connected ? 'var(--color-status-success)' : 'var(--color-text-tertiary)',
            flexShrink: 0,
            marginLeft: 'auto',
          }}
        />
      )}
    </div>
  );
}

/**
 * Says the connection is down, once it has been down long enough to matter.
 *
 * A bar at the bottom, not a dialog. The stream blinks routinely — a tab wakes,
 * a phone changes network — and the reader has nothing to decide when it does:
 * the client reconnects on its own. Blocking the panel to say so would
 * interrupt without offering anything to do about it. It is still an
 * `role="alert"`, so assistive tech announces it; it just does not take the
 * screen.
 *
 * The old treatment was a status line ABOVE the list, which pushed the whole
 * conversation down and back on every blink. This is `position: absolute`
 * inside the panel: it overlays, so showing it moves nothing.
 */
const OFFLINE_NOTICE_AFTER_MS = 10_000;

function OfflineNotice({ connected }: { connected: boolean }) {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (connected) {
      // Reconnected: down immediately, and the clock restarts, so a later blip
      // gets its own full ten seconds rather than inheriting these.
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), OFFLINE_NOTICE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  if (!show) return null;
  return (
    <div
      role="alert"
      data-testid="chat-offline-notice"
      style={{
        position: 'absolute',
        left: 'var(--space-3)',
        right: 'var(--space-3)',
        // Clear of the composer, which is pinned to the bottom of the panel.
        bottom: 68,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-card)',
        background: 'var(--color-bg-tertiary)',
        border: '1px solid var(--color-border-default)',
        boxShadow: 'var(--shadow-card, none)',
        fontSize: 'var(--text-body-sm)',
        color: 'var(--foreground)',
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{t('chat.offline.body')}</span>
      <button
        type="button"
        onClick={() => setShow(false)}
        aria-label={t('chat.offline.dismiss')}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--muted)',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
          fontSize: 'var(--text-body)',
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}

// ─── Message row ──────────────────────────────────────────────────────────────

/**
 * Shown once above the list when this device cannot read part of the history.
 *
 * Why this exists: a brand-new device (a second browser, a reinstalled app)
 * mints its OWN master_key, so the TAK keychain on the server — sealed under
 * the account's real key — stays closed to it and every pre-join message is
 * locked. Previously the only signal was a column of raw "[unable to decrypt]"
 * bubbles: no cause, no remedy, and it reads as a broken product.
 *
 * The unlock cannot be automatic. `navigator.credentials.get()` required a user
 * gesture in Safari through iOS 17.3, so recovery has to hang off a real tap —
 * hence a button rather than a silent effect on mount.
 */
function LockedHistoryNotice({
  lockedCount,
  syncing,
}: {
  lockedCount: number;
  /** The room is still working on these — see `syncing` in the panel below. */
  syncing: boolean;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<DeviceKeyState | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RecoveryOutcome | null>(null);

  useEffect(() => {
    if (lockedCount === 0) return;
    let alive = true;
    // Silent probe — reads local storage + one GET. Never prompts.
    void getDeviceKeyState().then((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
    };
  }, [lockedCount]);

  // GROUND TRUTH is `lockedCount`: these messages are on screen and this device
  // could not open them. That needs no inference, so it alone decides whether to
  // speak.
  //
  // This used to also bail on `state === 'ready'` and on `state === null`, and
  // both were wrong. 'ready' only means the local key opens the account's TAK
  // archive — the archive may not COVER these epochs, so a device can be
  // perfectly "ready" and still hold nothing for the messages in front of it.
  // And suppressing while the probe is in flight meant a slow or failing probe
  // silently hid the only route out. The key state now chooses WHICH remedy to
  // offer, never whether the user is told anything at all.
  if (lockedCount === 0) return null;

  // STILL ARRIVING, not broken. A device that has just joined has no archive key
  // yet and one is on its way to it. Offering "set up recovery" here blames the
  // user for a normal thirty-second wait, and showing nothing at all leaves a
  // column of padlocks with no explanation. Say what is happening.
  if (syncing) {
    return (
      <div
        role="status"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          margin: '0 0 var(--space-3)',
          padding: 'var(--space-3)',
          border: '1px solid var(--color-border-default)',
          borderRadius: 'var(--radius-card)',
          background: 'var(--color-bg-secondary)',
          fontSize: 'var(--text-body-sm)',
          color: 'var(--color-text-secondary)',
        }}
      >
        <Spinner size={16} />
        <span style={{ flex: 1, minWidth: 0 }}>
          {t('chat.lockedHistory.syncing', { count: String(lockedCount) })}
        </span>
      </div>
    );
  }

  const unlock = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      // Runs inside the click, preserving the user activation Safari needs.
      const result = await recoverDeviceWithPasskey();
      if (result === 'restored') {
        // Only reload when something actually changed. Reloading on failure is
        // what made this look broken: the page bounced back to the same locked
        // messages with nothing said.
        window.location.reload();
        return;
      }
      setOutcome(result);
    } catch {
      setOutcome('unavailable');
    } finally {
      setBusy(false);
    }
  };

  // Until the probe resolves (or if it failed), fall back to the honest,
  // always-true half of the message: these are locked and recovery is where to
  // look. Never offer an unlock that has nothing behind it.
  const recoverable = state === 'recoverable';
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        flexWrap: 'wrap',
        margin: '0 0 var(--space-3)',
        padding: 'var(--space-3)',
        border: '1px solid var(--color-border-default)',
        borderRadius: 'var(--radius-card)',
        background: 'var(--color-bg-secondary)',
        fontSize: 'var(--text-body-sm)',
        color: 'var(--color-text-secondary)',
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        {state === null
          ? // The probe has not answered yet. Naming a remedy now means naming
            // the WRONG one about half the time: this rendered "no recovery key
            // is set up" with a Set-up button, then flipped to "Unlock history"
            // a moment later. Say what is true — these are locked — and let the
            // remedy appear once it is known.
            t('chat.lockedHistory.checking', { count: String(lockedCount) })
          : outcome === 'no-archive'
          ? // The key came back but nothing on the server opens with it.
            // Retrying achieves nothing, so say what would.
            t('chat.lockedHistory.noArchive')
          : outcome === 'unavailable'
            ? t('chat.lockedHistory.failed')
            : recoverable
              ? t('chat.lockedHistory.recoverable', { count: String(lockedCount) })
              : state === 'ready'
                ? // The account key is HERE and opens the archive — the archive
                  // just does not reach back this far. Telling this user to "set
                  // up recovery" blames them for a key they already have.
                  t('chat.lockedHistory.notCovered', { count: String(lockedCount) })
                : t('chat.lockedHistory.noBackup', { count: String(lockedCount) })}
      </span>
      {state === null ? null : recoverable && outcome !== 'no-archive' ? (
        <button type="button" className="os-button os-button-primary" onClick={unlock} disabled={busy}>
          {busy ? t('chat.lockedHistory.unlocking') : t('chat.lockedHistory.unlock')}
        </button>
      ) : (
        // No backup exists, so nothing can unlock the past — but setting
        // recovery up now protects every message from here on.
        <Link href="/my" className="os-button">
          {t('chat.lockedHistory.setUp')}
        </Link>
      )}
    </div>
  );
}

function MessageRow({
  msg,
  grouped,
  roomy,
  own,
  syncing,
  onRetry,
  onDiscard,
}: {
  msg: ChatMessage;
  grouped?: boolean;
  roomy?: boolean;
  own?: boolean;
  /** The room key has not reached this device YET — locked rows are loading,
   *  not broken, and must not be dressed as a permanent failure. */
  syncing?: boolean;
  onRetry?: (msg: ChatMessage) => void;
  onDiscard?: (msg: ChatMessage) => void;
}) {
  const { t } = useTranslation();
  // System rows are about the room, not about a person — centered on both
  // surfaces so they never read as somebody's message.
  if (msg.type === 'join' || msg.type === 'leave') {
    return (
      <div style={{
        // Was 11/12px — both below (or right at) the floor for a row whose
        // nickname segment can be Korean; bumped to the caption step (13px).
        fontSize: 'var(--text-caption)',
        color: 'var(--muted)',
        fontStyle: 'italic',
        padding: '2px 0',
        lineHeight: 1.4,
        textAlign: 'center' as const,
      }}>
        {t(msg.type === 'join' ? 'chat.joinedRoom' : 'chat.leftRoom', { nickname: msg.nickname })}
      </div>
    );
  }

  // Locked, not broken. This device has no key for this message — almost always
  // because it joined the group after the message was sent. Say that, in the
  // user's language, instead of leaking the internal marker; the banner above
  // the list carries the actual remedy so every locked row need not repeat it.
  if (msg.undecryptable) {
    /*
     * While the room is still syncing this row shows NOTHING — the single
     * spinner above the list is the whole story. A per-row placeholder meant
     * every unreadable message printed its own "···", so a room opened as a
     * column of dots; and once the text was hidden the row collapsed to a bare
     * timestamp, which reads as a bug rather than as waiting.
     *
     * Once syncing stops, a row that is STILL unreadable is a real outcome, and
     * it says so with the padlock below.
     */
    if (syncing) return null;
    return (
      <div style={{ display: 'flex', justifyContent: own ? 'flex-end' : 'flex-start', padding: '2px 0' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            maxWidth: '78%',
            fontSize: roomy ? 14 : 13,
            fontStyle: 'italic',
            color: 'var(--color-text-tertiary)',
            background: 'transparent',
            border: '1px dashed var(--color-border-default)',
            borderRadius: 'var(--radius-card)',
            padding: roomy ? '8px 12px' : '6px 10px',
          }}
        >
          {/* While the banner above is already saying "history is arriving",
              each row repeating that sentence turns the screen into a wall of
              the same text. The row shows only that it is not readable yet. */}
          <span aria-hidden="true">🔒</span>
          {t('chat.lockedMessage')}
        </span>
      </div>
    );
  }

  const firstUrl = extractFirstUrl(msg.message);
  const urlOnly = firstUrl !== null && isUrlOnly(msg.message);
  const inlineImage = urlOnly && firstUrl && isImageUrl(firstUrl) ? firstUrl : null;
  /*
   * The text is hidden ONLY when something else is guaranteed to carry the
   * message: an inline image, which is the content itself.
   *
   * It used to be hidden for any link, on the theory that the OG card would
   * carry it. The card is not guaranteed — `/api/og` answers 502 for anything
   * that blocks server-side fetches (reddit, for one), and `LinkPreview`
   * renders NOTHING when it fails. So a link-only message showed a skeleton,
   * then vanished: the row was still there, with no bubble and no card, just a
   * timestamp floating on its own. A message the user sent must never be able
   * to disappear because a third-party site refused us.
   */
  const hideMessageText = inlineImage !== null;

  // Bubble treatment mirrors mobile (ChatRoomScreen `bubbleOwn`/`bubbleOther`):
  // own messages sit right in an accent bubble, everyone else left on a neutral
  // surface, with the tail corner squared off on the speaker's side.
  // Retry / discard sit BESIDE the failed bubble, the way a phone messenger puts
  // them: the message stays where the user left it, and both ways out are one
  // tap away instead of the text silently reappearing in the composer.
  const failedControls = msg.failed && (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        fontSize: 'var(--text-label)',
        color: 'var(--color-status-danger, var(--color-text-tertiary))',
        flexShrink: 0,
      }}
    >
      <span aria-hidden="true">!</span>
      <button
        type="button"
        onClick={() => onRetry?.(msg)}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', textDecoration: 'underline' }}
      >
        {t('chat.sendFailedRetry')}
      </button>
      <button
        type="button"
        onClick={() => onDiscard?.(msg)}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--muted)', textDecoration: 'underline' }}
      >
        {t('chat.sendFailedDiscard')}
      </button>
    </span>
  );

  const timestamp = !grouped && (
    <span style={{
      // Latin/numeric-only relative time — the label floor (12px), not the
      // Korean-prose floor, applies. Was 10px (below even that).
      fontSize: 'var(--text-label)',
      fontFamily: 'var(--font-mono)',
      color: 'var(--muted)',
      flexShrink: 0,
      paddingBottom: 2,
    }}>
      {relativeTime(msg.createdAt)}
    </span>
  );

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: own ? 'flex-end' : 'flex-start',
      lineHeight: roomy ? 1.5 : 1.4,
      marginTop: grouped ? -2 : 0,
      maxWidth: '100%',
    }}>
      {/* Author — other people only, first message of a group (mobile parity).
          Was 12/13px; a nickname can be short Korean text, so bumped to the
          caption step (13px) in both densities rather than dipping to the
          12px label floor (reserved for uppercase Latin). */}
      {!own && !grouped && (
        <span style={{
          fontSize: 'var(--text-caption)',
          fontWeight: 700,
          color: 'var(--accent)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          marginBottom: 2,
          paddingLeft: 2,
        }}>
          {msg.nickname}
          {msg.isAI && <Badge type="ai" />}
        </span>
      )}

      <div style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 6,
        maxWidth: '85%',
        // Timestamp sits on the outside of the bubble on both surfaces: left of
        // an own bubble, right of someone else's (mobile `bubbleTimeOwn/Other`).
        // The column's alignItems already packs the row to the correct edge.
        flexDirection: own ? 'row' : 'row-reverse',
      }}>
        {failedControls}
        {timestamp}
        {!hideMessageText && (
          <span style={{
            // Message bubble text — reverted to the pre-migration size per
            // user feedback ("채팅 말풍선에서는 기존 크기가 더 좋은거 같아"):
            // the 16px body-copy floor made bubbles read as oversized. This
            // is a deliberate EXCEPTION to the floor, scoped to bubble text
            // only — the composer `<input>` below stays at the 16px floor
            // (iOS Safari zooms the page on focus below that).
            fontSize: roomy ? 14 : 13,
            color: own ? 'var(--color-text-inverted)' : 'var(--foreground)',
            background: own ? 'var(--accent)' : 'var(--color-bg-tertiary)',
            borderRadius: 'var(--radius-card)',
            ...(own
              ? { borderBottomRightRadius: 'var(--radius-control)' }
              : { borderBottomLeftRadius: 'var(--radius-control)' }),
            padding: roomy ? '8px 12px' : '6px 10px',
            wordBreak: 'break-word' as const,
            minWidth: 0,
          }}>
            {renderLinkedText(msg.message, own ? 'var(--color-text-inverted)' : 'var(--accent)')}
          </span>
        )}
      </div>

      {inlineImage && (
        <a
          href={inlineImage}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'block', marginTop: 4, maxWidth: '85%' }}
        >
          <img
            src={inlineImage}
            alt=""
            style={{
              maxWidth: '100%',
              maxHeight: roomy ? 380 : 240,
              borderRadius: 'var(--radius-card)',
              border: '1px solid var(--border)',
              display: 'block',
            }}
          />
        </a>
      )}
      {firstUrl && !inlineImage && (
        <div style={{ marginTop: 6, marginBottom: 2, maxWidth: '85%' }}>
          {/* Fixed-height: a chat list is bottom-anchored, so a card that
              grows, shrinks or vanishes drags the whole conversation. */}
          <LinkPreview url={firstUrl} compact />
        </div>
      )}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Last painted messages per room, for the lifetime of the page.
 *
 * Re-entering a room re-fetched history and re-decrypted every row before it
 * could show anything, so a room the user had just been reading opened on a
 * blank pane. In-memory only, never persisted: the plaintext is already on
 * screen in this same process, and writing it anywhere else would widen where
 * decrypted content lives.
 */
const paintCache = new Map<string, ChatMessage[]>();


export default function ChatPanel({
  topicId,
  isGuest,
  isMember,
  fullHeight,
  hideHeader,
  onClose,
  roomy = false,
  framed,
  title,
}: ChatPanelProps) {
  const { t } = useTranslation();
  // Seeded from the last render of THIS room, so re-entering paints instantly
  // instead of showing an empty pane while history refetches and re-decrypts.
  // Live data replaces it as soon as it lands.
  const [messages, setMessages] = useState<ChatMessage[]>(() => paintCache.get(topicId) ?? []);
  // Mirror of `messages` for callbacks that must not re-subscribe every time a
  // message arrives (the archive gap-filler reads the current rows once).
  const messagesRef = useRef<ChatMessage[]>([]);
  // Whether this device can open the topic archive yet. Drives the difference
  // between "your history is on its way" and "something is wrong".
  const [rootState, setRootState] = useState<ArchiveRootState | null>(null);
  /** How many rows on screen this device cannot open. */
  const lockedCount = messages.reduce((n, m) => (m.undecryptable ? n + 1 : n), 0);
  /** Whether the archive probe has answered YET — see `isSyncingHistory`. */
  const [rootProbed, setRootProbed] = useState(false);
  const syncing = isSyncingHistory({ lockedCount, rootState, rootProbed });
  const [presence, setPresence] = useState<{ users: PresenceUser[]; count: number }>({ users: [], count: 0 });
  const [connected, setConnected] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Own-message alignment needs the caller's id. Same source the rest of the
  // web app uses for "is this me" checks (see topics/[topicId]/members).
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // ── History paging (`?before=`) ────────────────────────────────────────────
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Ref mirrors of the two flags above: the scroll handler fires many times per
  // frame and must not act on a state value React has not committed yet.
  const hasMoreHistoryRef = useRef(false);
  const loadingOlderRef = useRef(false);
  /** id of the oldest row on screen — the `?before=` cursor. */
  const oldestIdRef = useRef<string | null>(null);

  // ── Reconnect catch-up (`?since=`) ─────────────────────────────────────────
  /** createdAt of the newest row we have ingested — the `?since=` cursor. */
  const lastSeenIsoRef = useRef<string | null>(null);
  /** False until the SSE stream has opened once; the FIRST open has nothing to
   *  catch up on (the history fetch covers it), every later one does. */
  const hasConnectedRef = useRef(false);
  const catchupRunningRef = useRef(false);

  // ── Scroll bookkeeping ─────────────────────────────────────────────────────
  /** Distance from the bottom captured just before older messages prepend. */
  const pendingScrollAnchorRef = useRef<number | null>(null);
  const userNearBottomRef = useRef(true);
  const initialScrolledRef = useRef(false);
  const lastBottomIdRef = useRef<string | null>(null);

  /**
   * One decrypt per message id, forever — the panel's central correctness
   * guard. History, `?before=` pages, `?since=` catch-up and the SSE stream all
   * funnel through `ingest`, so a message delivered by two of them at once
   * awaits ONE decrypt instead of racing MLS, whose per-message key is consumed
   * on first use (the loser of that race renders `[unable to decrypt]` forever).
   */
  const decryptOnceRef = useRef(new DecryptOnce<ChatMessage>());
  // Topic visibility drives the TAK tier (public root vs scoped per-epoch).
  // Resolved once per topic in the history effect; defaults to public.
  const visibilityRef = useRef<Visibility>('public');
  // The caller's topic role — secret-tier history is granted only by the owner.
  const roleRef = useRef<string | null>(null);
  // Plaintext of messages sent from THIS panel, keyed by the sealed ciphertext
  // (known at seal() time, i.e. before the POST is even issued). The SSE echo
  // carries the same ciphertext, so this resolves our own messages without an
  // MLS open — which a sender can never satisfy. Bounded so a long session
  // cannot grow it without limit.
  const pendingSendsRef = useRef(new Map<string, string>());

  const rememberOwnPlaintext = useCallback((ciphertext: string, plaintext: string) => {
    const m = pendingSendsRef.current;
    m.set(ciphertext, plaintext);
    while (m.size > 200) m.delete(m.keys().next().value as string);
  }, []);

  /**
   * Turn raw server rows into display rows, decrypting each id at most once.
   *
   * Every delivery path calls this — there is deliberately no other route from
   * a wire row to the message list. A row whose decrypt throws outright (a
   * broken key store, not just an undecryptable body) degrades to a single
   * `[unable to decrypt]` row: `Promise.all` would otherwise reject and blank
   * the entire page it was part of.
   */
  const ingest = useCallback(
    (raws: RawChatMessage[]): Promise<ChatMessage[]> =>
      Promise.all(
        raws.map((raw) => {
          const decrypt = () =>
            toDisplayMessage(topicId, raw, pendingSendsRef.current).catch(
              () => ({ ...(raw as unknown as ChatMessage), message: '', undecryptable: true }),
            );
          return raw?.id ? decryptOnceRef.current.get(raw.id, decrypt) : decrypt();
        }),
      ),
    [topicId],
  );

  /**
   * Merge decrypted rows into the list and advance the `?since=` cursor.
   * Safe to call with rows that are already on screen (dedupe by id) and with
   * rows older than everything on screen (the merge sorts chronologically), so
   * catch-up, live and history paging share one path.
   */
  const applyIncoming = useCallback((incoming: ChatMessage[]) => {
    if (incoming.length === 0) return;
    setMessages((prev) => mergeChronological(prev, incoming));
    const newest = newestCreatedAt(incoming);
    // Older pages must never rewind the catch-up cursor.
    if (newest && (!lastSeenIsoRef.current || new Date(newest) > new Date(lastSeenIsoRef.current))) {
      lastSeenIsoRef.current = newest;
    }
  }, []);

  // Seal the push-preview copy (design §13.6 strategy A) so the recipient's iOS
  // NSE has something it can decrypt without consuming an MLS ratchet key. Sent
  // INSIDE the POST because push fan-out happens there — the separate
  // archiveOnSend upload only lands after the response. Best-effort: any failure
  // just omits the field and the recipient gets the content-free push.
  const buildPushArchive = useCallback(async (text: string) => {
    const seal = await getTakSessionStore().sealForPush(topicId, text, visibilityRef.current).catch(() => null);
    return seal ? { ct: seal.ct, takVersion: seal.takVersion } : undefined;
  }, [topicId]);

  // Uploads via /api/upload and posts the returned URL as a chat message.
  // The message body is the bare URL — MessageRow's isImageUrl detection
  // renders it inline, matching the mobile chat UX.
  const sendImage = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const up = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!up.ok) throw new Error('upload failed');
      // The endpoint returns `{ publicUrl: ... }` (see app/api/upload/route.ts).
      const { publicUrl } = await up.json();
      if (!publicUrl) throw new Error('no url');
      const sealed = await getMlsSessionStore().seal(topicId, publicUrl);
      rememberOwnPlaintext(sealed.ciphertext, publicUrl);
      const pushArchive = await buildPushArchive(publicUrl);
      const res = await fetch(`/api/topics/${topicId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext: sealed.ciphertext, epoch: sealed.epoch, pushArchive }),
      });
      // Optimistic local echo (sender can't decrypt its own MLS message).
      if (res.ok) {
        try {
          const { message: payload } = await res.json();
          if (payload?.id) {
            const own: ChatMessage = { ...payload, message: publicUrl };
            // Pre-seed the decrypt memo so the SSE echo of our own message never
            // reaches MLS at all (a sender cannot open its own message).
            decryptOnceRef.current.set(payload.id, own);
            applyIncoming([own]);
            // Cache own plaintext so it survives a restart (sender can't self-decrypt).
            void getMlsSessionStore().cachePlaintext(topicId, payload.id, publicUrl);
            // Re-encrypt for the archive so later members can read it (Phase 3).
            // Fire-and-forget: an archive failure must never break sending.
            void getTakSessionStore().archiveOnSend(topicId, payload.id, publicUrl, visibilityRef.current).catch(() => {});
          }
        } catch {}
      }
    } catch {
      // best-effort; the user can retry
    } finally {
      setUploading(false);
    }
  }, [topicId, buildPushArchive, rememberOwnPlaintext]);

  async function handleSend() {
    const text = inputValue.trim();
    if (!text) return;
    // Clear FIRST. Waiting for the server round-trip left the sent text sitting
    // in the box, so the next keystrokes landed after it and a fast second
    // message read as an edit of the first. The composer belongs to the user,
    // not to the request.
    setInputValue('');
    inputRef.current?.focus();
    setSending(true);

    // Draw it NOW. The id is local and provisional; the server's row replaces
    // this one by id below. Sealing alone takes an MLS lock plus a round trip,
    // so without this the bubble appears well after the composer has emptied.
    const pendingId = nextPendingId();
    // NOT `applyIncoming`: that also advances the SSE catch-up cursor, and this
    // row does not exist on the server. Moving the cursor to a provisional
    // timestamp would make the next catch-up skip real messages.
    setMessages((prev) =>
      mergeChronological(prev, [
        {
          id: pendingId,
          topicId,
          userId: myUserId ?? '',
          nickname: '',
          message: text,
          type: 'message',
          createdAt: new Date().toISOString(),
          pending: true,
        },
      ]),
    );
    const markFailed = () =>
      setMessages((prev) => prev.map((m) => (m.id === pendingId ? { ...m, pending: false, failed: true, draft: text } : m)));

    try {
      const sealed = await getMlsSessionStore().seal(topicId, text);
      rememberOwnPlaintext(sealed.ciphertext, text);
      const pushArchive = await buildPushArchive(text);
      const res = await fetch(`/api/topics/${topicId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext: sealed.ciphertext, epoch: sealed.epoch, pushArchive }),
      });
      if (res.ok) {
        // Optimistic local echo: an MLS sender cannot decrypt its own sealed
        // message (the sender ratchet has advanced), so show the known
        // plaintext directly. The SSE echo carries the same id and dedupes.
        try {
          const { message: payload } = await res.json();
          if (payload?.id) {
            const own: ChatMessage = { ...payload, message: text };
            // Pre-seed the decrypt memo so the SSE echo of our own message never
            // reaches MLS at all (a sender cannot open its own message).
            decryptOnceRef.current.set(payload.id, own);
            // Drop the provisional row, then MERGE the real one. Appending it
            // directly skipped `mergeChronological`, which is what dedupes by id
            // and keeps the list in order — so the SSE echo of the same message
            // arrived as a second bubble, and rapid sends piled up out of order.
            setMessages((prev) => mergeChronological(prev.filter((m) => m.id !== pendingId), [own]));
            // Cache own plaintext so it survives a restart (sender can't self-decrypt).
            void getMlsSessionStore().cachePlaintext(topicId, payload.id, text);
            // Re-encrypt for the archive so later members can read it (Phase 3).
            void getTakSessionStore().archiveOnSend(topicId, payload.id, text, visibilityRef.current).catch(() => {});
          }
        } catch {}
      } else {
        markFailed();
      }
    } catch {
      markFailed();
    } finally {
      setSending(false);
    }
  }

  /** Send it again, from the bubble. The failed row goes away and a fresh
   *  optimistic one takes its place, so one retry cannot leave two. */
  function retryFailed(msg: ChatMessage) {
    const text = msg.draft ?? msg.message;
    setMessages((prev) => prev.filter((m) => m.id !== msg.id));
    setInputValue(text);
    // Next tick: handleSend reads `inputValue`, which has not committed yet.
    setTimeout(() => {
      void handleSend();
    }, 0);
  }

  function discardFailed(msg: ChatMessage) {
    setMessages((prev) => prev.filter((m) => m.id !== msg.id));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  useEffect(() => {
    if (isGuest) return;
    let alive = true;
    fetch('/api/auth/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.userId) setMyUserId(d.userId); })
      .catch(() => {});
    return () => { alive = false; };
  }, [isGuest]);

  /**
   * Scroll the message list to the bottom.
   *
   * Scrolls `scrollerRef` DIRECTLY rather than calling `scrollIntoView` on the
   * bottom sentinel. `scrollIntoView` walks up and scrolls EVERY scrollable
   * ancestor, including the document — so once the panel became a normal flex
   * child of the page (the chat rail) instead of a `position: fixed` layer,
   * opening a room yanked the whole page down with it. Setting `scrollTop` on
   * the panel's own scroller cannot move anything outside the panel.
   *
   * `smooth` only for messages arriving while the user is already at the
   * bottom; entering a room jumps instantly, since animating a scroll the user
   * never initiated is what reads as the page "running away".
   */
  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  /**
   * Load one page of older history (`?before=<oldest id>`).
   *
   * Cursor is a message id, not an offset, so messages arriving while the page
   * is in flight cannot shift the window and cause a skip or a duplicate. The
   * in-flight guard is a ref, not the `loadingOlder` state: the scroll handler
   * can fire again before React commits.
   */
  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !hasMoreHistoryRef.current) return;
    const cursor = oldestIdRef.current;
    if (!cursor) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    // Anchor on the distance from the BOTTOM: prepending grows scrollHeight, so
    // restoring this distance keeps the row the user is reading under the cursor.
    const el = scrollerRef.current;
    pendingScrollAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    try {
      const res = await fetch(
        `/api/topics/${topicId}/chat?limit=${HISTORY_PAGE_LIMIT}&before=${encodeURIComponent(cursor)}`,
      );
      if (!res.ok) throw new Error(`history ${res.status}`);
      const data = await res.json();
      const raws: RawChatMessage[] = Array.isArray(data?.messages) ? data.messages : [];
      // A short page means we reached the beginning of the topic — stop asking.
      const more = raws.length >= HISTORY_PAGE_LIMIT;
      const decrypted = await ingest(raws);
      if (!mountedRef.current) return;
      if (decrypted.length === 0) pendingScrollAnchorRef.current = null;
      applyIncoming(decrypted);
      hasMoreHistoryRef.current = more;
      setHasMoreHistory(more);
    } catch {
      // Transient failure: keep `hasMoreHistory` so the user can retry.
      pendingScrollAnchorRef.current = null;
    } finally {
      loadingOlderRef.current = false;
      if (mountedRef.current) setLoadingOlder(false);
    }
  }, [topicId, ingest, applyIncoming]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      // "Near bottom" decides whether an incoming message may steal the scroll
      // position from someone reading history further up.
      userNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      if (el.scrollTop < 80) void loadOlder();
    },
    [loadOlder],
  );

  // Restore the scroll position BEFORE paint whenever a page of older messages
  // was just prepended. Runs ahead of the auto-scroll effect below (layout
  // effects flush first), so the two never fight.
  useBrowserLayoutEffect(() => {
    const anchor = pendingScrollAnchorRef.current;
    if (anchor == null) return;
    pendingScrollAnchorRef.current = null;
    const el = scrollerRef.current;
    if (el) el.scrollTop = Math.max(0, el.scrollHeight - anchor);
  }, [messages]);

  // Auto-scroll only when the BOTTOM of the list moved (a new message), never
  // when older history prepended — and only if the user was already at the
  // bottom, so reading history is not interrupted by someone else typing.
  // A device that joins the group AFTER the root was handed out receives
  // nothing, and until now that lasted "until some other device happens to
  // reopen the chat" — reproducibly minutes, or forever. Re-check on a slow
  // timer while the room is open. `distributePublicRootWhenGroupChanged` is a
  // no-op unless the MLS epoch actually advanced, so the steady-state cost is
  // one commits-since GET, not a bundle per tick.
  useEffect(() => {
    if (isGuest || !isMember) return;
    // Backoff from a short first interval: a device that joins right after the
    // hand-out is the case that matters, and making it wait a fixed half-minute
    // is the whole complaint. Quiet rooms settle to one cheap check a minute.
    let delay = 3_000;
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const schedule = () => {
      timer = setTimeout(() => {
        void getTakSessionStore()
          .distributePublicRootWhenGroupChanged(topicId)
          .catch(() => {})
          .finally(() => {
            if (!alive) return;
            delay = Math.min(delay * 2, 60_000);
            schedule();
          });
      }, delay);
    };
    schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [isGuest, isMember, topicId]);

  useEffect(() => {
    messagesRef.current = messages;
    // Decrypted bodies live only in memory here — this is the same process that
    // already holds them on screen, never storage.
    if (messages.length) paintCache.set(topicId, messages);
    oldestIdRef.current = messages.length > 0 ? messages[0].id : null;
    const bottomId = messages.length > 0 ? messages[messages.length - 1].id : null;
    if (bottomId === lastBottomIdRef.current) return;
    lastBottomIdRef.current = bottomId;
    if (!bottomId) return;
    if (!initialScrolledRef.current || userNearBottomRef.current) {
      const isFirstPaint = !initialScrolledRef.current;
      initialScrolledRef.current = true;
      scrollToBottom(!isFirstPaint);
    }
  }, [messages, scrollToBottom]);

  // Provision archive access for later members, by tier. public: claim the
  // single-winner holder lease (409 = someone else holds it, no-op) and the
  // winner distributes the root to all leaves (SI-6). private: explicitly grant
  // the epochs we hold to new member leaves (SI-6b — no custodian/lease). secret:
  // nothing (the owner grants explicitly). Best-effort — never throws into chat.
  // Runs AFTER `provisionArchiveAccess`, because that is where a device that was
  // waiting finally adopts the topic root — and only a verified root may seal.
  // Reads from the panel's own decrypted rows plus whatever the archive just
  // gave back, so it never re-derives anything. Best-effort throughout.
  const archiveGaps = useCallback(
    async (fromArchive: Array<{ messageId: string; plaintext: string }>) => {
      try {
        const readable = [
          ...messagesRef.current
            // A provisional row has a client-side id and no server row behind
            // it yet, so archiving it would POST a non-uuid messageId — which
            // the archive route rejects, once per unsent message, on every
            // pass. It gets archived by `archiveOnSend` the moment the server
            // gives it a real id.
            .filter((m) => m.type === 'message' && !m.undecryptable && m.message && !isProvisionalId(m.id))
            .map((m) => ({ messageId: m.id, plaintext: m.message as string })),
          ...fromArchive,
        ];
        await getTakSessionStore().backfillMissingArchive(topicId, visibilityRef.current, readable);
      } catch {}
    },
    [topicId],
  );

  /**
   * Pull any TAK bundles addressed to this device, decrypt whatever the archive
   * now opens, and put back anything the archive is missing.
   *
   * Extracted so it can run again later, not only on entry. Bundles are PULLED
   * over HTTP — nothing pushes them down the SSE stream — so a device that was
   * still waiting for the root when it opened the room would never see the
   * bundle that arrived a moment later. It sat locked until the user reopened
   * the room, which is exactly what it looked like on a real phone.
   */
  const catchUpArchive = useCallback(async () => {
    let recovered: Array<{ messageId: string; plaintext: string }> = [];
    try {
      recovered = await getTakSessionStore().backfill(topicId, visibilityRef.current);
      if (mountedRef.current && recovered.length) {
        const byId = new Map(recovered.map((r) => [r.messageId, r.plaintext]));
        setMessages((prev) =>
          prev.map((m) =>
            m.undecryptable && byId.has(m.id)
              ? { ...m, message: byId.get(m.id)!, undecryptable: false }
              : m,
          ),
        );
      }
    } catch {}
    // Close archive GAPS: `archiveOnSend` gets one attempt, at send time, and
    // does nothing while the root is unverified. Anything this device can read
    // is a chance to put one back.
    void archiveGaps(recovered);
  }, [topicId, archiveGaps]);

  const provisionArchiveAccess = useCallback(async () => {
    try {
      const tak = getTakSessionStore();
      if (visibilityRef.current === 'public') {
        const deviceId = await tak.myDeviceId(topicId);
        // Only a device that HOLDS the root may take the role, because the
        // holder is who everyone else receives the root from. A device still
        // waiting for it that claims anyway makes itself the one party nobody
        // will ever send a bundle to — and blocks every newer device behind it.
        const rootFingerprint = await tak.publicRootFingerprint(topicId);
        if (!rootFingerprint) {
          // Waiting for the root. If a previous visit already took the lease,
          // hand it back now rather than idling on it for the full 15 minutes.
          await fetch(`/api/topics/${topicId}/tak/holder?deviceId=${encodeURIComponent(deviceId)}`, {
            method: 'DELETE',
            credentials: 'include',
          });
          return;
        }
        await fetch(`/api/topics/${topicId}/tak/holder`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId, rootFingerprint }),
        });
        // Distribute whether or not we won the lease. Gating on the lease made
        // delivery depend on ONE device being online at the right moment, and
        // that is what left a device that joined a minute late with no root at
        // all. Serving is safe from any holder of a verified root: a recipient
        // rejects any bundle whose fingerprint is not the topic's.
        await tak.distributePublicRootWhenGroupChanged(topicId);
      } else if (visibilityRef.current === 'private') {
        await tak.grantPrivateHistory(topicId);
      } else if (visibilityRef.current === 'secret' && roleRef.current === 'owner') {
        // secret: no auto-grant by default — only the owner shares history.
        await tak.grantPrivateHistory(topicId);
      }
    } catch {}
  }, [topicId]);

  // The RECEIVING half of root delivery. Bundles are pulled, never pushed, and
  // the pull used to happen once per room entry — so a device that was still
  // waiting when it opened the room never saw the bundle created seconds later.
  // Poll while this device cannot open the archive, and stop the moment it can:
  // an unlocked device costs nothing, and a locked one is the only case where
  // history is actually missing from the screen.
  useEffect(() => {
    // Never probed, never will be — so nothing is pending and the spinner must
    // not imply otherwise.
    if (isGuest || !isMember) {
      setRootProbed(true);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const state = await getTakSessionStore().archiveRootState(topicId, visibilityRef.current);
        // null = a scoped tier with no topic-wide root, so there is nothing to
        // wait for and nothing to decrypt from an archive.
        if (state === null) {
          if (alive) setRootState(state);
          return true;
        }
        // Decrypt BEFORE reporting the new state. The previous version stopped
        // the moment the root became 'verified' — which is precisely the pass
        // that can finally open the history — so the banner cleared over a room
        // still full of locked rows, and nothing decrypted until the user left
        // and came back.
        await catchUpArchive();
        if (alive) setRootState(state);
        return state === 'verified';
      } catch {
        return false;
      } finally {
        // Settled either way. A failed probe is an ANSWER — it must stop the
        // spinner and let the locked rows explain themselves.
        if (alive) setRootProbed(true);
      }
    };
    // Backoff, starting FAST. A fixed slow interval meant a newcomer stared at
    // padlocks for the whole period even when the key was already waiting; the
    // common case now resolves in a couple of seconds, and a genuinely stuck one
    // stops hammering.
    let delay = 1_500;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        void tick().then((done) => {
          if (!alive || done) return;
          delay = Math.min(delay * 2, 15_000);
          schedule();
        });
      }, delay);
    };
    // Ask once immediately so the banner reflects reality on first paint.
    void tick().then((done) => {
      if (!alive || done) return;
      schedule();
    });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [isGuest, isMember, topicId, catchUpArchive]);


  useEffect(() => {
    if (isGuest || !isMember) return;

    mountedRef.current = true;

    // Switching topics must not carry ANY of the previous room across: its
    // messages, its decrypt memo (ids are unique per message, but a stale memo
    // just wastes memory), its catch-up cursor, or its paging cursor.
    setMessages([]);
    setHasMoreHistory(false);
    hasMoreHistoryRef.current = false;
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    decryptOnceRef.current = new DecryptOnce<ChatMessage>();
    lastSeenIsoRef.current = null;
    oldestIdRef.current = null;
    lastBottomIdRef.current = null;
    hasConnectedRef.current = false;
    catchupRunningRef.current = false;
    pendingScrollAnchorRef.current = null;
    initialScrolledRef.current = false;
    userNearBottomRef.current = true;

    // Fetch history, then TAK back-fill pre-join messages (Phase 3).
    (async () => {
      // Resolve the topic's visibility once → selects the TAK tier. Best-effort:
      // default 'public' if the lookup fails.
      // In PARALLEL. These were sequential, so the message list waited on a
      // metadata lookup it does not depend on — the room painted a blank pane
      // for one extra round trip on every single entry.
      const [topicMeta, data] = await Promise.all([
        fetch(`/api/topics/${topicId}`, { credentials: 'include' })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch(`/api/topics/${topicId}/chat?limit=${HISTORY_PAGE_LIMIT}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      const v = (topicMeta?.topic?.visibility ?? topicMeta?.visibility) as Visibility | undefined;
      if (v === 'public' || v === 'private' || v === 'secret') visibilityRef.current = v;
      roleRef.current = (topicMeta?.currentUserRole as string | null) ?? null;
      if (!mountedRef.current || !Array.isArray(data?.messages)) return;
      const raws = data.messages as RawChatMessage[];
      // A full first page means older messages exist behind it; a short one
      // means this topic's entire history already fits on screen.
      const more = raws.length >= HISTORY_PAGE_LIMIT;
      const decrypted = await ingest(raws);
      if (!mountedRef.current) return;
      // Server returns newest-first here; the merge sorts, so no reverse needed.
      applyIncoming(decrypted);
      hasMoreHistoryRef.current = more;
      setHasMoreHistory(more);

      // Back-fill: fetch TAK bundles + archive, decrypt history MLS forward
      // secrecy locked out, and fill in any '[unable to decrypt]' rows. Entirely
      // best-effort — never blocks or breaks the live chat.
      await catchUpArchive();

      // Public holder upkeep (SI-6): claim the lease and, if we hold it,
      // distribute the archive root to every current member leaf so later
      // joiners can read history. Single-winner on the server; idempotent for
      // recipients. Custodian-free tiers (private/secret) skip this by design.
      void provisionArchiveAccess();
    })();

    /**
     * Pull everything that arrived while the stream was down.
     *
     * The SSE subscription only delivers events that happen after it is live,
     * so every message written during a drop is invisible until a reload —
     * which is exactly what this closes. Idempotent by construction: rows the
     * stream also delivers are deduped by id and decrypted once (`ingest`), so
     * running catch-up and receiving the same message live is harmless.
     */
    async function runCatchup() {
      const anchor = lastSeenIsoRef.current;
      // No anchor = we have never seen a message, so there is no delta to sync
      // against; the initial history fetch is the complete picture.
      if (!anchor || catchupRunningRef.current) return;
      catchupRunningRef.current = true;
      try {
        const raws = await fetchCatchup<RawChatMessage & { id: string; createdAt: string }>({
          sinceIso: sinceCursor(anchor),
          fetchPage: async (since, limit) => {
            const r = await fetch(
              `/api/topics/${topicId}/chat?limit=${limit}&since=${encodeURIComponent(since)}`,
            );
            if (!r.ok) throw new Error(`catchup ${r.status}`);
            const d = await r.json();
            return Array.isArray(d?.messages) ? d.messages : [];
          },
          limit: CATCHUP_PAGE_LIMIT,
        });
        if (!mountedRef.current || raws.length === 0) return;
        const decrypted = await ingest(raws);
        if (!mountedRef.current) return;
        applyIncoming(decrypted);
      } catch {
        // Best-effort: the next reconnect retries from the same cursor, and the
        // cursor only advances on messages we actually ingested.
      } finally {
        catchupRunningRef.current = false;
      }
    }

    function connect() {
      if (!mountedRef.current) return;

      const es = new EventSource(`/api/topics/${topicId}/chat/subscribe`);
      esRef.current = es;

      es.addEventListener('presence', (e) => {
        if (!mountedRef.current) return;
        try {
          const data = JSON.parse(e.data);
          setPresence({ users: data.users ?? [], count: data.count ?? 0 });
        } catch {}
      });

      es.addEventListener('message', (e) => {
        if (!mountedRef.current) return;
        try {
          const raw = JSON.parse(e.data);
          // A new member joined → if we hold the public archive lease, push them
          // the root so they can back-fill history (SI-6, membership change).
          if (raw?.type === 'join') void provisionArchiveAccess();
          // Decrypt the sealed body before display. Goes through the same
          // one-decrypt-per-id funnel as catch-up, so a message delivered by
          // both paths is opened once and rendered once.
          void ingest([raw]).then((msgs) => {
            if (!mountedRef.current) return;
            applyIncoming(msgs);
          });
        } catch {}
      });

      es.addEventListener('ping', () => {
        // keep-alive, ignore
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        setConnected(false);
        if (mountedRef.current) {
          reconnectTimerRef.current = setTimeout(connect, 3000);
        }
      };

      es.onopen = () => {
        if (!mountedRef.current) return;
        setConnected(true);
        // The first open is the initial subscription — history already covers
        // it. Every later open follows a drop, and only then can messages have
        // been missed.
        const reopened = hasConnectedRef.current;
        hasConnectedRef.current = true;
        if (reopened) void runCatchup();
      };
    }

    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [topicId, isGuest, isMember, provisionArchiveAccess, ingest, applyIncoming]);

  // Root chrome: card by default, flex column when it has to fill its parent.
  const rootStyle = fullHeight
    ? framed
      ? panelFramedFullHeightStyle
      : panelFullHeightStyle
    : panelStyle;

  // Every current host (the chat rail's narrow column, the full-screen mobile
  // sheet, and the standalone /chat/[id] and /dm/[id] pages) already caps its
  // own reading width where that matters, so the panel itself no longer needs
  // a mode-specific measure.
  const measureStyle: React.CSSProperties = { width: '100%' };

  // Topic pages pass the topic name; everything else keeps the generic label.
  const headerLabel = (
    <div style={headerLeftStyle}>
      <span style={{ fontSize: roomy ? 'var(--text-body)' : 'var(--text-body-sm)', flexShrink: 0 }}>💬</span>
      {title ? (
        <div style={{ minWidth: 0 }}>
          {/* Topic title — was 13/15px (below/at the floor); a topic title
              can be Korean, so both densities now use the same 14px step. */}
          <div style={{
            fontSize: 'var(--text-body-sm)',
            fontWeight: 700,
            color: 'var(--foreground)',
            letterSpacing: '-0.01em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap' as const,
          }}>
            {title}
          </div>
          {/* `.os-label` carries the 12px floor, the mono face, and the
              uppercase+tracking gated to :lang(en) — "Live Chat" translates,
              so the idiom must not be hand-rolled here. */}
          <div className="os-label" style={{
            fontWeight: 400,
            color: 'var(--muted)',
            marginTop: 1,
          }}>
            {presence.count > 0
              ? `${t('chat.liveChat')} · ${t('chat.onlineCount', { count: presence.count })}`
              : t('chat.liveChat')}
          </div>
        </div>
      ) : (
        <>
          <span className="os-label" style={headerTitleStyle}>{t('chat.liveChat')}</span>
          {presence.count > 0 && <span style={onlineCountStyle}>{t('chat.onlineCount', { count: presence.count })}</span>}
        </>
      )}
    </div>
  );

  // ─── Guest / non-member state ──────────────────────────────────────────────
  if (isGuest || !isMember) {
    return (
      <div style={rootStyle}>
        {!hideHeader && (
          <div style={headerStyle}>
            <div style={headerLeftStyle}>
              <span style={{ fontSize: 'var(--text-body-sm)' }}>💬</span>
              <span className="os-label" style={headerTitleStyle}>{t('chat.liveChat')}</span>
            </div>
            {onClose && <button onClick={onClose} aria-label={t('chat.close')} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 'var(--text-body-lg)', cursor: 'pointer' }}>×</button>}
          </div>
        )}
        {/* No `connected` here: there is no stream for a non-member, but the
            encryption claim is exactly what they are deciding to join. */}
        <E2eeBanner />
        <div style={{
          padding: '20px var(--space-4)',
          textAlign: 'center',
          fontSize: 'var(--text-caption)',
          color: 'var(--muted)',
          lineHeight: 1.5,
        }}>
          {t('chat.joinToView')}
        </div>
      </div>
    );
  }

  // ─── Member state ─────────────────────────────────────────────────────────
  return (
    <div style={rootStyle}>
      {/* Header */}
      {!hideHeader && (
      <div style={headerStyle}>
        {headerLabel}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {presence.users.length > 0 && <PresenceDots users={presence.users} max={roomy ? 8 : 4} />}
          {/* The connection state lives in the E2EE strip below, where it has a
              visible word next to the dot and is announced. It used to be a
              bare 7px dot here whose only label was `title`. */}
          {/* Per-topic notification mute (P-S). Renders nothing until known. */}
          <TopicMuteToggle topicId={topicId} enabled={!isGuest && isMember} style={{ lineHeight: 1, flexShrink: 0 }} />
          {onClose && <button onClick={onClose} aria-label={t('chat.close')} style={{ background: 'none', border: 'none', color: 'var(--muted)', fontSize: 'var(--text-body-lg)', cursor: 'pointer' }}>×</button>}
        </div>
      </div>
      )}

      {/* Persistent under whichever header is above it — the panel's own, or
          the rail's / the standalone page's when `hideHeader` is set. */}
      <E2eeBanner connected={connected} />
      <OfflineNotice connected={connected} />

      {/* Messages — the only scroller once the panel fills its parent. */}
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        style={fullHeight ? {
        ...messagesContainerStyle,
        maxHeight: 'none',
        flex: 1,
        minHeight: 0,
        padding: roomy ? '16px 20px' : '10px var(--space-4)',
        overflowY: 'auto' as const,
      } : messagesContainerStyle}>
        <div style={{
          ...measureStyle,
          display: 'flex',
          flexDirection: 'column',
          gap: roomy ? 8 : 6,
          // Short conversations sit on the composer instead of floating at the
          // top of a tall column. `margin-top: auto` (not justify-content) so a
          // long list still scrolls from the very first message.
          ...(fullHeight ? { marginTop: 'auto' } : null),
        }}>
          {/* Older history. Scrolling to the top loads the next page too; the
              button exists so a short panel (a non-fullHeight host barely
              scrolls) and keyboard users are not stuck at 50 messages. It
              disappears once the beginning of the topic is reached. */}
          {hasMoreHistory && (
            <button
              type="button"
              onClick={() => void loadOlder()}
              disabled={loadingOlder}
              style={{
                alignSelf: 'center',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-pill)',
                color: 'var(--muted)',
                cursor: loadingOlder ? 'default' : 'pointer',
                // Uppercase-adjacent mono meta control, not running copy —
                // the label floor (12px) applies. Was 11px.
                fontSize: 'var(--text-label)',
                fontFamily: 'var(--font-mono)',
                padding: '3px var(--space-3)',
                marginBottom: 4,
                opacity: loadingOlder ? 0.5 : 1,
                minHeight: 'var(--touch-target-min)',
              }}
            >
              {loadingOlder ? t('chat.loading') : t('chat.loadEarlier')}
            </button>
          )}
          <LockedHistoryNotice syncing={syncing} lockedCount={lockedCount} />
          {messages.length === 0 ? (
            <div style={{ fontSize: 'var(--text-label)', color: 'var(--muted)', textAlign: 'center', padding: '20px 0' }}>
              {t('chat.noMessagesYet')}
            </div>
          ) : (
            messages.map((msg, i) => {
              // Same-author messages within 60s collapse into a single
              // group (matches the mobile chat). Hide the nickname row
              // and trim the gap.
              const prev = messages[i - 1];
              const grouped =
                prev != null &&
                prev.type === 'message' &&
                msg.type === 'message' &&
                prev.userId === msg.userId &&
                !!prev.isAI === !!msg.isAI &&
                new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < 60_000;
              return (
                <MessageRow
                  syncing={syncing}
                  onRetry={retryFailed}
                  onDiscard={discardFailed}
                  key={msg.id}
                  msg={msg}
                  grouped={grouped}
                  roomy={roomy}
                  own={isOwnMessage(msg, myUserId)}
                />
              );
            })
          )}
        </div>
      </div>

      {/* Composer — pinned to the bottom of the panel. */}
      <div style={{
        borderTop: '1px solid var(--border)',
        flexShrink: 0,
      }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: roomy ? '12px 20px' : '8px 10px',
        ...measureStyle,
      }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void sendImage(file);
            // Allow selecting the same file again later.
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!connected || uploading}
          aria-label={t('chat.attachImage')}
          title={t('chat.attachImage')}
          style={{
            ...composerIconButtonStyle,
            background: 'var(--color-bg-secondary)',
            color: 'var(--muted)',
            border: '1px solid var(--color-border-default)',
            cursor: connected && !uploading ? 'pointer' : 'not-allowed',
            opacity: connected && !uploading ? 1 : 0.5,
          }}
        >
          {uploading ? (
            <span style={{ fontSize: 'var(--text-label)' }}>…</span>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          )}
        </button>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={(e) => {
            // Pasted image from clipboard → upload directly.
            const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
            const file = item?.getAsFile();
            if (file) {
              e.preventDefault();
              void sendImage(file);
            }
          }}
          placeholder={t('chat.messagePlaceholder')}
          maxLength={1000}
          disabled={!connected}
          style={{
            flex: 1,
            background: 'transparent',
            border: '1px solid var(--color-border-default)',
            // Pill, not a 6px rounded rectangle — the composer is the one
            // control the reader touches most, and the rounded-rect version
            // read as a form field dropped into a chat.
            borderRadius: 'var(--radius-pill)',
            padding: roomy ? '9px var(--space-4)' : '7px var(--space-3)',
            color: 'var(--foreground)',
            // var(--text-body) = 16px: below that, iOS Safari zooms the page
            // on focus. Was 13/14px in both densities — a text input must
            // never dip below this floor, so both roomy and compact now match.
            fontSize: 'var(--text-body)',
            outline: 'none',
            boxSizing: 'border-box',
            opacity: connected ? 1 : 0.5,
            minHeight: 'var(--touch-target-min)',
          }}
        />
        {/* Icon button, not a text button: "Send"/"보내기"/"Enviar" each take a
            different width, so a labelled button made the composer's geometry
            depend on the locale. The accessible name still says Send. */}
        <button
          onClick={handleSend}
          disabled={!inputValue.trim() || !connected}
          aria-label={t('chat.send')}
          title={t('chat.send')}
          style={{
            ...composerIconButtonStyle,
            background: 'var(--accent)',
            color: 'var(--color-text-inverted)',
            border: 'none',
            cursor: !inputValue.trim() || !connected ? 'not-allowed' : 'pointer',
            opacity: !inputValue.trim() || !connected ? 0.4 : 1,
            transition: 'opacity 0.12s',
          }}
        >
          {/* No busy state. The message is already on screen the instant it is
              typed, and the only outcome worth reporting is failure — which the
              row itself reports, with retry and discard beside it. A spinner
              here says "wait" about something the reader has already seen
              finish. */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
          </svg>
        </button>
        </div>
      </div>
    </div>
  );
}
