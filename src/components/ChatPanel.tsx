'use client';

import { sendPickedFiles } from '@/lib/pickedFiles';
import { apiFetch, MEDIA_DOWNLOAD_TIMEOUT_MS, UPLOAD_REQUEST_TIMEOUT_MS } from '@/lib/apiFetch';
import { rememberSentChatMedia, readSentChatMedia } from '@/lib/chatMediaPlaintextCache';
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import { relativeTime } from '@/lib/utils';
import Badge from '@/components/Badge';
import Spinner from '@/components/Spinner';
import LinkPreview from '@/components/LinkPreview';
import { isSyncingHistory, nextPendingId, isProvisionalId } from '@/lib/chatStatus';
import { copyTargets } from '@/lib/messageActions';
import {
  ChatMediaError,
  MAX_CHAT_MEDIA_BYTES,
  CHAT_MEDIA_CONTENT_TYPE,
  chatMediaFilename,
  addFailedMedia,
  buildChatMediaBody,
  isFailedMediaExpired,
  isHeicBytes,
  loadEncryptedChatMedia,
  parseFailedMedia,
  removeFailedMedia,
  serializeFailedMedia,
  resolveChatMediaMime,
  parseChatMediaBody,
  sendEncryptedChatMedia,
  type ChatMediaEnvelope,
  type ChatMediaLoad,
  type ChatMediaSendFailure,
  type PersistedFailedMedia,
} from '@/lib/chatMedia';
import { convertHeicToJpeg } from '@/lib/chatMediaHeic';
import { ChatImage, CHAT_IMAGE_SLOT_WIDTH, CHAT_IMAGE_SLOT_WIDTH_ROOMY } from '@/components/ChatImage';
import { ackDelivery } from '@/lib/chatDeliveryAck';
import { httpAckPost } from '@/lib/chatDeliveryAckHttp';
import { syncChatRead } from '@/lib/chatReadSyncHttp';
import { endChatReadSync } from '@/lib/chatReadSync';
import { displayNickname } from '@/lib/defaultNickname';
import TopicMuteToggle from '@/components/TopicMuteToggle';
import { useTranslation } from '@/lib/i18n/I18nProvider';
import Link from 'next/link';
import { chatTierOf, usesTopicRootKey, type ChatTier } from '@/lib/chatTierPolicy';
import { chatClaimKey, TIER_CLAIM_VISIBLE_MS } from '@/lib/chatTierExplainer';
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
    } else if (raw.id) {
      /*
       * NO sealed body at all: the server has reclaimed the live copy now that
       * every device owed the message has acknowledged it (R-1).
       *
       * The plaintext may still be on THIS device from when it WAS delivered,
       * and `openCached` looks in the message cache before it looks at the
       * sealed body — so an empty one is enough to ask "do we already have
       * this?". Without it a purge would turn a user's own readable history
       * into a screen of locked placeholders after one reload.
       */
      try {
        text =
          (await getMlsSessionStore().openCached(topicId, raw.id, { ciphertext: '', epoch: 0 })) ?? '';
      } catch {
        text = '';
      }
    }
    /*
     * No plaintext from any source: LOCKED for this device, not blank.
     *
     * This check sits outside the sealed-body branch on purpose. It used to be
     * inside it, so a purged row — which has no sealed body by definition —
     * fell straight past it and returned `message: ''` with no flag: an EMPTY
     * BUBBLE, claiming the sender sent nothing. It is also the flag the archive
     * pass matches on (`catchUpArchive`) and the one the room hides while
     * history is still arriving (`isSyncingHistory`), so a row that skips it is
     * not merely mislabelled — it is invisible to the machinery that would have
     * resolved it, and stays blank forever.
     *
     * "Purged" and "locked" share one flag because the DEVICE cannot tell them
     * apart: both arrive as no readable body. What separates them is what
     * happens next — the archive resolves the first and leaves the second —
     * and that is precisely why the row has to be visible to that pass.
     */
    if (text === '') return { ...(raw as ChatMessage), message: '', undecryptable: true };
    return { ...(raw as ChatMessage), message: text };
  }
  return raw as ChatMessage;
}

// Match the mobile chat URL detector (ChatRoomScreen.tsx). Keep them in
// sync so the same message renders an OG card on both surfaces.
const URL_REGEX = /(https?:\/\/[^\s]+)/g;
const IMAGE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?.*)?$/i;

/**
 * How tall the composer may grow before it scrolls instead — about five lines.
 *
 * A composer that grows without a ceiling eats the conversation it is part of;
 * one that never grows hides everything but the last line of what is being
 * written. Mobile's chat composer draws the same line at `maxHeight: 120`.
 */
const COMPOSER_MAX_HEIGHT = 120;

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
  /**
   * For a failed ATTACHMENT: the object key its envelope names.
   *
   * The bytes are already stored by the time a send can fail, so Retry re-sends
   * this exact object rather than re-reading a file the user may no longer have
   * selected, and Discard deletes it rather than stranding it.
   */
  mediaKey?: string;
  /**
   * The attachment's bytes are gone — the collector took them before the user
   * came back. Retry is replaced by an explanation; the row still SHOWS,
   * because silence is the defect this whole path exists to fix.
   */
  mediaExpired?: boolean;
  /**
   * The sealed body, carried straight through from the server row.
   *
   * It is what lets a provisional row recognise its own echo: this tab knows
   * the ciphertext it sent, and the echo comes back carrying the same one, so
   * the two can be matched before the server's id is known.
   */
  sealed?: { ciphertext: string; epoch: number } | null;
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
/*
 * PER TIER, and derived — never a fixed sentence.
 *
 * A `public` topic's archive root is held by the SERVER, so that a member who
 * joins later reads history without waiting on anyone. That is a deliberate
 * trade, and it means the old single claim ("the server cannot read this") was
 * false in exactly the tier most people are in. `chatClaimKey` computes which
 * sentence applies from `serverMayHoldKey`, so the banner cannot drift from the
 * policy: change the policy and the copy follows, or the test fails.
 *
 * PRESENT TENSE, deliberately: "new messages and images ARE encrypted". Images
 * sent before R-3 are still plaintext objects at public URLs, so a claim about
 * the ROOM would be false about its own history while a claim about what
 * happens NOW is true. Do not widen it.
 */
function E2eeBanner({ connected, tier }: { connected?: boolean; tier: ChatTier }) {
  const { t } = useTranslation();
  const state = connected ? t('chat.connected') : t('chat.reconnecting');
  const claim = chatClaimKey(tier);
  /*
   * The SENTENCE withdraws; the strip does not.
   *
   * Three lines of standing notice above every conversation is furniture, and
   * furniture goes unread — which is worst in `serverReadable`, where the
   * sentence is a warning rather than a reassurance. So it says its piece on
   * entry and then folds back to the marker.
   *
   * What stays is the marker itself: same strip, same per-tier colour, and a
   * button carrying 🔒 or ℹ️. A room the service can read therefore still looks
   * unlike one it cannot at every moment, including for a reader who never
   * read the sentence — and the connection dot, which lives in this strip,
   * keeps its place instead of appearing and disappearing with the text.
   */
  const [open, setOpen] = useState(true);
  useEffect(() => {
    // Keyed on the claim: `tier` is derived from a topic lookup, so a room can
    // resolve after its first frames, and the sentence it lands on deserves
    // its own reading time rather than the tail of the previous one's.
    setOpen(true);
    const timer = setTimeout(() => setOpen(false), TIER_CLAIM_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [claim]);
  return (
    <div
      style={{
        ...e2eeStyle,
        // A tier the service can read is not an accent-coloured reassurance.
        // Same strip, warning tone, so the difference is visible before the
        // sentence is read.
        ...(claim === 'serverReadable'
          ? {
              color: 'var(--color-status-warning)',
              background: 'color-mix(in srgb, var(--color-status-warning) 10%, transparent)',
            }
          : null),
      }}
      data-testid="chat-e2ee-banner"
      data-claim={claim}
      data-expanded={open ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-label={t(`chat.tierClaim.${claim}`)}
        data-testid="chat-tier-claim-button"
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          font: 'inherit',
          color: 'inherit',
          cursor: 'pointer',
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        <span aria-hidden="true">{claim === 'e2ee' ? '🔒' : 'ℹ️'}</span>
      </button>
      {open && <span style={{ minWidth: 0 }}>{t(`chat.tierClaim.${claim}`)}</span>}
      {open && (
        <Link
          href="/docs/tiers"
          style={{ color: 'inherit', textDecoration: 'underline', flexShrink: 0 }}
        >
          {t('chat.tierClaim.learnMore')}
        </Link>
      )}
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

/**
 * Right-click menu for a message.
 *
 * It only appears when the browser's own menu has nothing better to offer:
 * with text selected, or over a link or an image, the native menu is the one
 * the reader wants (Copy, Open in new tab, Save image) and this one stays out
 * of the way.
 *
 * Deliberately small. Copy is the whole feature. Delete is absent on purpose —
 * this client can only forget a message locally, and a "Delete" that leaves the
 * message on every other member's screen is a lie whichever way it is worded.
 */
function MessageMenu({
  at,
  targets,
  onClose,
}: {
  at: { x: number; y: number };
  targets: { message: string; link: string | null };
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Focus lands on the first item so the menu is operable from the keyboard
    // for anyone who opened it with the context-menu key.
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    onClose();
  };

  const item = (label: string, text: string) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => copy(text)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'none',
        border: 'none',
        color: 'var(--foreground)',
        fontSize: 'var(--text-body-sm)',
        padding: 'var(--space-2) var(--space-4)',
        cursor: 'pointer',
        minHeight: 'var(--touch-target-min)',
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="message-menu"
      style={{
        position: 'fixed',
        // Kept inside the viewport: a bubble near the right or bottom edge
        // would otherwise open a menu the reader cannot reach.
        left: Math.min(at.x, window.innerWidth - 200),
        top: Math.min(at.y, window.innerHeight - 100),
        zIndex: 1000,
        minWidth: 160,
        padding: 'var(--space-2) 0',
        background: 'var(--color-bg-primary)',
        border: '1px solid var(--color-border-default)',
        borderRadius: 'var(--radius-card)',
      }}
    >
      {item(t('chat.copyMessage'), targets.message)}
      {targets.link && item(t('chat.copyLink'), targets.link)}
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

/**
 * One end-to-end encrypted attachment: fetch the ciphertext, decrypt it here,
 * show the picture.
 *
 * The three failures get three different messages rather than one placeholder.
 * They mean genuinely different things — "the key has not reached this device
 * yet, it may still arrive", "the network or the object failed, try again", and
 * "these bytes are not what the message says they are, trying again will not
 * help" — and a reader who is shown the same dots for all three has been told
 * nothing about which one they are in.
 */
function ChatMediaAttachment({
  envelope,
  topicId,
  tier,
  roomy,
}: {
  envelope: ChatMediaEnvelope;
  topicId: string;
  /** Which key opens it — see `chatTierPolicy`. NOT the topic's visibility: a
   *  DM row says `'secret'` and a DM's attachments are sealed under its root. */
  tier: ChatTier;
  roomy?: boolean;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<ChatMediaLoad | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  /** Bumped by the retry button; re-runs the effect without remounting the row. */
  const [attempt, setAttempt] = useState(0);
  const { key, mediaId, takVersion, mime } = envelope;

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    setState(null);
    setObjectUrl(null);
    void (async () => {
      /*
       * THE SENDER'S OWN BUBBLE. This tab encrypted these bytes and uploaded
       * them moments ago; without this it downloads and decrypts them straight
       * back — 2441ms of a measured 8661ms on staging for a 7.7MB image, for a
       * picture the sender chose from their own disk.
       *
       * The bytes are the same bytes (`rememberSentChatMedia` stores what was
       * handed to `sealMedia`, and the size and mime are checked against this
       * envelope), so this bubble and the same bubble after a reload cannot
       * render differently. A miss just falls through to the reader path below,
       * which is what a reload, the recipient, and the sender's other device
       * all take.
       */
      const own = readSentChatMedia(mediaId, envelope.size, mime);
      if (own) {
        if (cancelled) return;
        created = URL.createObjectURL(new Blob([own.bytes as BlobPart], { type: own.mime }));
        setObjectUrl(created);
        setState({ status: 'ok', bytes: own.bytes, mime: own.mime });
        return;
      }
      const res = await loadEncryptedChatMedia(
        { v: 1, key, mediaId, takVersion, mime, size: envelope.size },
        {
          fetchCiphertext: async (objectKey) => {
            /*
             * BYTES. The route answers `application/octet-stream` and nothing
             * else now — the base64-in-JSON shape it used to offer existed for
             * React Native and is gone, so there is no `Accept` to negotiate.
             *
             * A browser was always the wrong place to pay for base64: the 4/3
             * expansion cost twice, once on the wire and once turning a
             * multi-megabyte string back into bytes on the main thread.
             */
            const r = await apiFetch(
              `/api/topics/${topicId}/chat/media?key=${encodeURIComponent(objectKey)}`,
              {
                credentials: 'include',
                // Megabytes of ciphertext coming DOWN. The ordinary 15s is a
                // deadline on the transfer itself here, not on an idle server:
                // an attachment that is arriving slowly gets cut off and
                // reported as a failure. Same budget as the upload of the same
                // file — see `MEDIA_DOWNLOAD_TIMEOUT_MS`.
                timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
              },
            );
            if (!r.ok) throw new Error(`fetch failed (${r.status})`);
            const bytes = new Uint8Array(await r.arrayBuffer());
            if (bytes.length === 0) throw new Error('empty attachment');
            return bytes;
          },
          open: (id, version, ciphertext) =>
            getTakSessionStore().openMedia(topicId, id, version, ciphertext, tier),
        },
      );
      if (cancelled) return;
      if (res.status === 'ok') {
        created = URL.createObjectURL(new Blob([res.bytes as BlobPart], { type: res.mime }));
        setObjectUrl(created);
      }
      setState(res);
    })();
    return () => {
      cancelled = true;
      // Revoke on unmount, not on every render: the <img> is still reading it.
      if (created) URL.revokeObjectURL(created);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicId, tier, key, mediaId, takVersion, mime, attempt]);

  const noticeStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    marginTop: 4,
    maxWidth: '85%',
    fontSize: roomy ? 14 : 13,
    color: 'var(--color-text-tertiary)',
    border: '1px dashed var(--color-border-default)',
    borderRadius: 'var(--radius-card)',
    padding: roomy ? '8px 12px' : '6px 10px',
  } as const;

  if (state === null) {
    return <div style={noticeStyle}>{t('chat.media.decrypting')}</div>;
  }
  if (state.status === 'locked') {
    return (
      <div style={noticeStyle}>
        <span aria-hidden="true">🔒</span>
        {t('chat.media.locked')}
      </div>
    );
  }
  if (state.status === 'fetch-failed') {
    return (
      <div style={noticeStyle}>
        <span>{t('chat.media.fetchFailed')}</span>
        {/*
          RELOAD, not "Retry" — a failed row renders its own Retry beside
          Discard, and two identical labels on one row cannot be told apart by a
          reader any more than they could by a test. This one re-fetches a
          picture; that one re-sends a message.
        */}
        <button
          type="button"
          onClick={() => setAttempt((a) => a + 1)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent)', textDecoration: 'underline' }}
        >
          {t('chat.media.reload')}
        </button>
      </div>
    );
  }
  if (state.status === 'decrypt-failed') {
    return <div style={noticeStyle}>{t('chat.media.decryptFailed')}</div>;
  }
  return (
    /*
     * Two actions on one picture: open it, and keep it.
     *
     * Saving was missing entirely — every other chat app has it, and here the
     * omission bites harder than usual, because an attachment is only readable
     * on a device that holds the topic's key. Without this the picture exists
     * nowhere the person can put it.
     *
     * The blob is what both use. It is the plaintext already decrypted for the
     * <img>, so saving costs no second fetch and no second decrypt — and no
     * round trip that could hand back the ciphertext by mistake.
     */
    <div style={{ position: 'relative', display: 'inline-block', marginTop: 4, maxWidth: '85%' }}>
      <a
        href={objectUrl ?? undefined}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        style={{ display: 'block' }}
      >
        {/*
          Sized by the shared rule, not by a `maxHeight`. The old cap capped the
          wrong axis: height was bounded and width fell out of the intrinsic
          ratio, so a 1179x2556 screenshot rendered 175px wide and nothing in it
          could be read. See `packages/mls/src/chatMediaLayout.ts`.
        */}
        <ChatImage
          src={objectUrl}
          alt={t('chat.media.alt')}
          slotWidth={roomy ? CHAT_IMAGE_SLOT_WIDTH_ROOMY : CHAT_IMAGE_SLOT_WIDTH}
          croppedLabel={t('chat.media.cropped')}
          data-testid="chat-media-image"
        />
      </a>
      {/*
        An anchor, not a button with script: `download` is what tells the
        browser to write the file instead of navigating to it, and it keeps the
        control working with a middle click and a context menu like any other
        link. `stopPropagation` because the row underneath is itself clickable.
      */}
      <a
        href={objectUrl ?? undefined}
        download={chatMediaFilename(mime, mediaId)}
        onClick={(e) => e.stopPropagation()}
        aria-label={t('chat.media.download')}
        title={t('chat.media.download')}
        data-testid="chat-media-download"
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 32,
          height: 32,
          borderRadius: 'var(--radius-pill, 999px)',
          // Legible over an unknown picture: a scrim rather than a theme
          // colour, because the thing behind it is somebody's photograph. The
          // token is theme-invariant on purpose — see globals.css.
          background: 'var(--scrim-strong)',
          color: 'var(--on-scrim)',
          textDecoration: 'none',
          fontSize: 16,
          lineHeight: 1,
        }}
      >
        <span aria-hidden="true">↓</span>
      </a>
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
  topicId,
  tier,
}: {
  msg: ChatMessage;
  grouped?: boolean;
  roomy?: boolean;
  own?: boolean;
  topicId: string;
  tier: ChatTier;
  /** The room key has not reached this device YET — locked rows are loading,
   *  not broken, and must not be dressed as a permanent failure. */
  syncing?: boolean;
  onRetry?: (msg: ChatMessage) => void;
  onDiscard?: (msg: ChatMessage) => void;
}) {
  const { t } = useTranslation();
  /*
   * Whether this row's link will get a card.
   *
   * Declared HERE, above the early returns below: a row that is undecryptable
   * one moment and readable the next takes a different path through this
   * function, and a hook further down would change the hook count between those
   * two renders — which React treats as a crash, not a warning.
   */
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
  /** Where the reader right-clicked, or null when no menu is open. */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  /*
   * An encrypted attachment, or null for an ordinary message.
   *
   * Parsed HERE, above the early returns, for the same reason `previewUnavailable`
   * is — and memoised so the attachment's decrypt effect does not re-run on
   * every unrelated re-render of the room.
   */
  const mediaEnvelope = useMemo(() => parseChatMediaBody(msg.message), [msg.message]);

  /**
   * Ours only when the browser's own menu would be less useful.
   *
   * With a selection live, or over a link or an image, the native menu carries
   * Copy / Open in new tab / Save image — taking that away to offer a smaller
   * menu is a downgrade, so we let it through.
   */
  const onContextMenu = (e: React.MouseEvent) => {
    // An attachment row has no text to copy — only the envelope, which is
    // machinery. The browser's own menu (Save image, Copy image) is the useful
    // one here, so let it through.
    if (mediaEnvelope) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().length > 0) return;
    if ((e.target as Element).closest('a, img, button')) return;
    e.preventDefault();
    setMenuAt({ x: e.clientX, y: e.clientY });
  };

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
  /*
   * The card replaces the link text — a card AND the raw URL above it is the
   * duplication every messenger avoids. But only while a card is actually
   * coming: `/api/og` answers 502 for anything that refuses server-side fetches,
   * and a message must never be left with neither.
   */
  // An attachment's body is an envelope, so there is never text to show — and
  // showing it would put a line of JSON in the conversation.
  const hideMessageText = mediaEnvelope !== null || inlineImage !== null || (urlOnly && !previewUnavailable);

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
      {/*
        An attachment whose bytes the collector already took cannot be retried:
        re-sending would post a message pointing at nothing, and every reader
        would see a permanently broken picture. It says so, and offers only the
        way out that works.
      */}
      {msg.mediaExpired ? (
        <span>{t('chat.media.expired')}</span>
      ) : (
        <button
          type="button"
          onClick={() => onRetry?.(msg)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', textDecoration: 'underline' }}
        >
          {t('chat.sendFailedRetry')}
        </button>
      )}
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
    <div
      onContextMenu={onContextMenu}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: own ? 'flex-end' : 'flex-start',
        lineHeight: roomy ? 1.5 : 1.4,
        marginTop: grouped ? -2 : 0,
        maxWidth: '100%',
      }}
    >
      {menuAt && (
        <MessageMenu at={menuAt} targets={copyTargets(msg.message ?? '')} onClose={() => setMenuAt(null)} />
      )}
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
          {displayNickname(msg.nickname ?? '')}
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
            // A message can now contain newlines (Shift+Enter in the composer),
            // and HTML collapses those to a single space by default — the line
            // break would survive the round trip, the encryption and the
            // render, and vanish in the last inch. `pre-wrap`, not `pre`: long
            // lines must still wrap inside the bubble.
            whiteSpace: 'pre-wrap' as const,
            wordBreak: 'break-word' as const,
            minWidth: 0,
            // Drag-selectable. It was not: the bubble inherited the panel's
            // chrome treatment, so a reader could not select part of a message
            // to quote it — the most basic thing you do with a chat message.
            userSelect: 'text' as const,
            WebkitUserSelect: 'text' as const,
            cursor: 'text' as const,
          }}>
            {renderLinkedText(msg.message, own ? 'var(--color-text-inverted)' : 'var(--accent)')}
          </span>
        )}
      </div>

      {mediaEnvelope && (
        <ChatMediaAttachment
          envelope={mediaEnvelope}
          topicId={topicId}
          tier={tier}
          roomy={roomy}
        />
      )}
      {/*
       * The plaintext image path stays for messages sent BEFORE R-3: their body
       * really is a public URL, and dropping the renderer would blank out every
       * picture already in every room. New sends never take it.
       */}
      {!mediaEnvelope && inlineImage && (
        <a
          href={inlineImage}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ display: 'block', marginTop: 4, maxWidth: '85%' }}
        >
          {/* The same rule as the encrypted path, through the same component. */}
          <ChatImage
            src={inlineImage}
            alt=""
            slotWidth={roomy ? CHAT_IMAGE_SLOT_WIDTH_ROOMY : CHAT_IMAGE_SLOT_WIDTH}
            croppedLabel={t('chat.media.cropped')}
            data-testid="chat-inline-image"
          />
        </a>
      )}
      {firstUrl && !inlineImage && !mediaEnvelope && (
        <div
          style={{
            marginTop: 6,
            marginBottom: 2,
            /*
             * An explicit WIDTH, not just a cap.
             *
             * This sits in a flex column aligned to one edge, so a block child
             * shrinks to its content — and a card that is still loading has no
             * content, so it collapsed to a sliver that `aspect-ratio` then
             * stretched into a tall thin pill. The card has to know how wide it
             * is before it knows what is in it.
             */
            width: 'min(320px, 85%)',
          }}
        >
          {/* Fixed-height: a chat list is bottom-anchored, so a card that
              grows, shrinks or vanishes drags the whole conversation. */}
          <LinkPreview url={firstUrl} compact onUnavailable={() => setPreviewUnavailable(true)} />
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

/**
 * The signed-in user's id, for the lifetime of the page.
 *
 * Which side a bubble sits on is decided by comparing against it, and it used
 * to arrive from `/api/auth/session` a moment AFTER the first paint — so every
 * message the reader had sent opened on the left, under someone else's name,
 * and jumped to the right when the request came back. One fetch per page rather
 * than per panel, and every panel after the first knows the answer before it
 * draws anything.
 */
let cachedUserId: string | null = null;


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
  /** Why the last attachment did not go out, or null. Cleared on the next try. */
  const [mediaError, setMediaError] = useState<ChatMediaSendFailure | null>(null);

  /*
   * Failed attachments outlive the tab.
   *
   * They used to live only in component state, so a reload lost the row and the
   * user was left with nothing — no picture, no error, and the uploaded bytes
   * collected within the hour. Storing a REFERENCE (the sealed body and the
   * object key, never the picture) is what lets the row still be there when
   * they come back. Rules — cap, retry window, TTL, validation — live in
   * `chatMedia.ts` so both clients keep the same ones.
   */
  const failedMediaStorageKey = `openstoa.failedMedia.${topicId}`;
  const readFailedMedia = useCallback((): PersistedFailedMedia[] => {
    if (typeof window === 'undefined') return [];
    try {
      return parseFailedMedia(window.localStorage.getItem(failedMediaStorageKey), Date.now());
    } catch {
      // Private mode, quota, a corrupt entry: a failed row is worth less than
      // the room it is in.
      return [];
    }
  }, [failedMediaStorageKey]);
  const writeFailedMedia = useCallback(
    (list: readonly PersistedFailedMedia[]) => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(failedMediaStorageKey, serializeFailedMedia(list));
      } catch {
        /* storage refused — the row still shows for this session */
      }
    },
    [failedMediaStorageKey],
  );
  const forgetFailedMedia = useCallback(
    (rowId: string) => writeFailedMedia(removeFailedMedia(readFailedMedia(), rowId)),
    [readFailedMedia, writeFailedMedia],
  );

  /*
   * Put back what the last session could not send.
   *
   * Returned as rows rather than pushed from an effect of its own: entering a
   * room CLEARS the message list (a previous room's messages must not carry
   * across), and that clear runs after any effect declared above it — so a
   * separate restore effect was wiped by it every time. Seeding the clear is
   * the one place where "start the room with these rows" is unambiguous.
   *
   * These rows come from storage, not the server; the server never saw these
   * messages, which is the whole reason they are here.
   */
  const restoredFailedRows = useCallback((): ChatMessage[] => {
    const rows = readFailedMedia();
    if (rows.length === 0) return [];
    const now = Date.now();
    // Persist what the parse kept, so rows it dropped (TTL, corrupt, over the
    // cap) are not re-read forever.
    writeFailedMedia(rows);
    return rows.map((r) => ({
      id: r.rowId,
      topicId,
      // `isOwnMessage` treats a failed row as this client's by construction, so
      // ownership does not wait on `/api/auth/session`.
      userId: '',
      nickname: '',
      message: r.body,
      type: 'message' as const,
      createdAt: new Date(r.createdAt).toISOString(),
      failed: true,
      draft: r.body,
      mediaKey: r.key,
      // Only a HINT here — the retry probes the object for real.
      mediaExpired: isFailedMediaExpired(r, now),
    }));
  }, [topicId, readFailedMedia, writeFailedMedia]);
  // Own-message alignment needs the caller's id. Same source the rest of the
  // web app uses for "is this me" checks (see topics/[topicId]/members).
  const [myUserId, setMyUserId] = useState<string | null>(cachedUserId);
  /*
   * Whether the session lookup has ANSWERED — which is not the same as
   * `myUserId === null`. A failed lookup also leaves it null, and gating the
   * list on the value rather than on "have we asked yet" would spin forever on
   * a session endpoint that is down. Seeded true when the id is already known,
   * because then there is nothing to wait for.
   */
  const [sessionProbed, setSessionProbed] = useState(cachedUserId !== null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
  /**
   * The bottom row's CONTENT, not its id. Decryption does not change an id —
   * `catchUpArchive` replaces bodies in place — so an id was a key that could
   * not see the one pass that matters. See the auto-scroll effect below.
   */
  const lastBottomKeyRef = useRef<string | null>(null);
  /** The message list's own box, for the growth observer below. */
  const contentRef = useRef<HTMLDivElement>(null);

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
  /*
   * The tier, for the CRYPTO — which is not the same question as the topic's
   * visibility and used to be answered with it. A DM row carries
   * `visibility: 'secret'`, so passing the visibility here asked the TAK layer
   * for per-epoch keys on a tier `chatTierPolicy` declares topic-root, and every
   * DM ended up sealed under a key that never left this browser. Kept as a ref
   * beside `visibilityRef` because the callbacks below read it outside render.
   */
  const tierRef = useRef<ChatTier>('public');
  // Same value as the ref, as state: an attachment row decrypts in an effect,
  // so it needs the tier as a PROP that changes when the lookup lands. A ref
  // read during render would pin the first row to the default forever.
  const [visibility, setVisibility] = useState<Visibility>('public');
  // A DM is a different KIND of room, not a visibility, so the banner needs both
  // to name the tier. Defaults false; resolved by the same topic lookup.
  const [isDm, setIsDm] = useState(false);
  /*
   * The tier the banner speaks for. Until the lookup lands this is `public` —
   * the tier that promises the LEAST — so a room can only ever be upgraded to
   * "the service cannot read this" once we know it is true, never downgraded
   * from a promise we already made on screen.
   */
  const tier: ChatTier = chatTierOf(visibility, isDm);
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
    setMessages((prev) => {
      /*
       * ACKNOWLEDGE IN PLACE.
       *
       * When one of these is the echo of a message this tab just sent, the row
       * for it is already on screen — put the server's id ON that row instead
       * of inserting a second one. Removing and re-inserting made the bubble
       * disappear and come back somewhere else, and while the echo and the POST
       * response raced, the same message was on screen twice.
       *
       * `createdAt` deliberately stays the client's. It is what the list is
       * ordered by, so adopting the server's would slide an acknowledged bubble
       * past its neighbours under the reader's eyes.
       */
      const acknowledged = new Set<string>();
      const renamed = prev.map((row) => {
        const mine = row.pending ? row.sealed?.ciphertext : undefined;
        if (!mine) return row;
        const echo = incoming.find((m) => m.sealed?.ciphertext === mine);
        if (!echo) return row;
        acknowledged.add(echo.id);
        return { ...row, id: echo.id, pending: false };
      });
      const rest = acknowledged.size === 0 ? incoming : incoming.filter((m) => !acknowledged.has(m.id));
      return mergeChronological(renamed, rest);
    });
    const newest = newestCreatedAt(incoming);
    // Older pages must never rewind the catch-up cursor.
    if (newest && (!lastSeenIsoRef.current || new Date(newest) > new Date(lastSeenIsoRef.current))) {
      lastSeenIsoRef.current = newest;
    }
    /*
     * Tell the server what this DEVICE now holds (R-1).
     *
     * Here rather than in each caller because this is the one point every path
     * converges on — the SSE stream, the reconnect catch-up and the `?before=`
     * history pages all end here — and the server's copy should be released
     * once, from wherever the rows arrived. Never throws (see
     * `chatDeliveryAck`), so a failed acknowledgement costs some server storage
     * and nothing else.
     */
    void ackDelivery(topicId, incoming, {
      deviceId: () => getTakSessionStore().myDeviceId(topicId),
      post: httpAckPost,
    });
    /*
     * ...and how far this ACCOUNT has now read it.
     *
     * Same convergence point, deliberately: having the panel open with rows in
     * it is what "read" means, and every route that puts rows in it ends here.
     * The previous version of this idea on the mini-app was written from a list
     * row's `onPress`, which made the marker a property of TAPPING A ROW — so a
     * push-notification tap recorded nothing and re-badged everything the user
     * had just read.
     *
     * Note the two calls disagree about a locked row on purpose: `ackDelivery`
     * refuses one, this accepts it. See `chatReadSync`'s header — refusing here
     * would strand the badge on a message that can never be cleared.
     *
     * Older `?before=` pages cannot rewind it: the sync sends the newest mark it
     * has seen and skips anything at or behind what it already sent.
     */
    syncChatRead(topicId, incoming);
  }, [topicId]);

  /*
   * Flush the read cursor when this panel goes away.
   *
   * The write is debounced, and closing the room is both the moment it is most
   * likely to still be sitting in that window and the moment the user most
   * expects the badge to be gone on their phone. `endChatReadSync`, not a plain
   * flush: one last attempt and no retry timer left running for a room nobody
   * is looking at. Never rejects.
   */
  useEffect(() => {
    return () => {
      endChatReadSync(topicId);
    };
  }, [topicId]);

  // Seal the push-preview copy (design §13.6 strategy A) so the recipient's iOS
  // NSE has something it can decrypt without consuming an MLS ratchet key. Sent
  // INSIDE the POST because push fan-out happens there — the separate
  // archiveOnSend upload only lands after the response. Best-effort: any failure
  // just omits the field and the recipient gets the content-free push.
  const buildPushArchive = useCallback(async (text: string) => {
    const seal = await getTakSessionStore().sealForPush(topicId, text, tierRef.current).catch(() => null);
    return seal ? { ct: seal.ct, takVersion: seal.takVersion } : undefined;
  }, [topicId]);

  /**
   * Attach an image — encrypted end to end (R-3).
   *
   * It used to POST the raw file to `/api/upload`, which stored it at a public
   * unauthenticated URL and sealed only that URL string. The message was
   * encrypted; the picture in it was not. Now the file is encrypted on this
   * device under the topic's TAK, the CIPHERTEXT is uploaded, and the sealed
   * body carries only a reference — so a secret topic's images are as private
   * as its words, and the operator holds bytes it cannot open.
   *
   * `sendEncryptedChatMedia` owns the ordering, including deleting the uploaded
   * object if the message POST fails.
   */
  const sendImage = useCallback(async (file: File) => {
    setUploading(true);
    setMediaError(null);
    try {
      const picked = new Uint8Array(await file.arrayBuffer());
      /*
       * An iPhone photo becomes a JPEG HERE, in the tab, before anything is
       * sealed.
       *
       * This is the last point at which the plaintext exists: once `sealMedia`
       * runs, the bytes are opaque to everything downstream, so a HEIC that no
       * browser can render would stay unrenderable forever. Converting first
       * means the ciphertext carries a JPEG and the server still sees only
       * bytes it cannot read.
       *
       * A conversion that cannot happen is a REFUSAL, never a send of the
       * original — an unviewable picture and an unencrypted one are both worse
       * than a clear "no".
       */
      let bytes = picked;
      if (isHeicBytes(bytes)) {
        const jpeg = await convertHeicToJpeg(bytes);
        if (!jpeg) throw new ChatMediaError('heic-unsupported');
        bytes = jpeg;
      }
      /*
       * The BYTES decide the type, not `file.type` — and after a conversion
       * they are the CONVERTED bytes, so the type, the size cap and everything
       * downstream describe what is actually being sent.
       *
       * This used to be `if (!file.type.startsWith('image/')) return;` — a
       * silent return, and browsers report an empty `file.type` routinely (an
       * extension they do not know, some drag-and-drop sources, some pickers).
       * A real photo could therefore vanish with no upload, no error and no
       * bubble: the sender was simply told nothing. Everything from here on
       * reports, including "this is not an image I can send".
       */
      const mime = resolveChatMediaMime(bytes, bytes === picked ? file.type : 'image/jpeg', file.name);
      if (!mime) throw new ChatMediaError('unsupported-type');
      await sendEncryptedChatMedia(
        { bytes, mime },
        {
          seal: async (mediaId, plain) => {
            const sealed = await getTakSessionStore().sealMedia(topicId, mediaId, plain, tierRef.current);
            // Only once the seal succeeded: a send that never happens must not
            // leave bytes in the cache under an id nothing will ever name.
            // `plain` is post-strip and post-conversion — exactly what the
            // recipient will decrypt — so the sender's bubble renders the same
            // picture the archive holds.
            if (sealed) rememberSentChatMedia(mediaId, plain, mime);
            return sealed;
          },
          upload: async (ciphertext, mediaId) => {
            /*
             * The ciphertext IS the body. It used to be base64 inside a JSON
             * object, which turned a 7MB picture into a 9.3MB request against a
             * 10MB transport ceiling — a third of the budget spent re-encoding
             * bytes that were already bytes, and the reason the advertised cap
             * could not be reached. The id rides in the query string because a
             * raw body has nowhere to put it.
             */
            const res = await apiFetch(
              `/api/topics/${topicId}/chat/media?mediaId=${encodeURIComponent(mediaId)}`,
              {
                method: 'POST',
                headers: { 'Content-Type': CHAT_MEDIA_CONTENT_TYPE },
                credentials: 'include',
                body: ciphertext as BodyInit,
                // Megabytes of ciphertext going up: the deadline covers the
                // whole exchange, so the ordinary 15s would abort a transfer
                // that is making perfectly good progress.
                timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
              },
            );
            if (!res.ok) throw new Error(`upload failed (${res.status})`);
            const { key } = (await res.json()) as { key?: string };
            if (!key) throw new Error('upload returned no key');
            return key;
          },
          send: async (body) => {
            const sealed = await getMlsSessionStore().seal(topicId, body);
            rememberOwnPlaintext(sealed.ciphertext, body);
            /*
             * An attachment gets the push preview too (P-1).
             *
             * It was omitted here because the preview is a copy of the BODY and
             * this body is an envelope, so the notification read as a line of
             * JSON. That removed the preview rather than teaching the recipient's
             * handler to read it. Both handlers now parse the envelope — iOS
             * fetches the object and shows the picture, Android shows a caption
             * — and neither can render an envelope as text.
             */
            const pushArchive = await buildPushArchive(body);
            const res = await apiFetch(`/api/topics/${topicId}/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ciphertext: sealed.ciphertext, epoch: sealed.epoch, pushArchive }),
            });
            if (!res.ok) throw new Error(`send failed (${res.status})`);
            const { message: payload } = await res.json();
            if (!payload?.id) return;
            const own: ChatMessage = { ...payload, message: body };
            // Pre-seed the decrypt memo so the SSE echo of our own message never
            // reaches MLS at all (a sender cannot open its own message).
            decryptOnceRef.current.set(payload.id, own);
            applyIncoming([own]);
            // Cache own plaintext so it survives a restart (sender can't self-decrypt).
            void getMlsSessionStore().cachePlaintext(topicId, payload.id, body);
            // Re-encrypt the ENVELOPE for the archive so later members can read
            // it (Phase 3). The bytes it points at are sealed under the same
            // key, so a member who gets the archive gets the picture too.
            void getTakSessionStore().archiveOnSend(topicId, payload.id, body, tierRef.current).catch(() => {});
          },
          discard: async (key) => {
            await apiFetch(`/api/topics/${topicId}/chat/media?key=${encodeURIComponent(key)}`, {
              method: 'DELETE',
              credentials: 'include',
            });
          },
          claim: async (key) => {
            await apiFetch(`/api/topics/${topicId}/chat/media?key=${encodeURIComponent(key)}`, {
              method: 'PATCH',
              credentials: 'include',
            });
          },
          // The bytes stay put when only the SEND fails, so the failed row
          // below can retry them. See `retainForRetry`.
          retainForRetry: true,
        },
      );
    } catch (err) {
      /*
       * WHERE a failure is reported depends on whether a message exists yet.
       *
       * Before the bytes are on the server — an unsupported file, no room key,
       * a refused upload — there is no message to attach the failure to, so it
       * belongs in the composer, next to the control that started it.
       *
       * Once the object is stored, the failure is about a MESSAGE, and people
       * watch the conversation rather than the input box. It gets a row there,
       * with Retry and Discard, exactly as a failed text message does. The
       * inconsistency was itself a bug: a failed text was recoverable in place
       * while a failed picture vanished and had to be found on disk again.
       */
      const stored = err instanceof ChatMediaError && err.reason === 'send-failed' ? err.envelope : undefined;
      if (stored) {
        const body = buildChatMediaBody(stored);
        const rowId = nextPendingId();
        // Written BEFORE the row is drawn: a crash between the two would
        // otherwise lose exactly what this is here to keep.
        writeFailedMedia(
          addFailedMedia(readFailedMedia(), { rowId, body, key: stored.key, createdAt: Date.now() }),
        );
        setMessages((prev) =>
          mergeChronological(prev, [
            {
              id: rowId,
              topicId,
              userId: myUserId ?? '',
              nickname: '',
              message: body,
              type: 'message',
              createdAt: new Date().toISOString(),
              failed: true,
              draft: body,
              mediaKey: stored.key,
            },
          ]),
        );
      } else {
        setMediaError(err instanceof ChatMediaError ? err.reason : 'send-failed');
      }
    } finally {
      setUploading(false);
    }
  }, [topicId, rememberOwnPlaintext, applyIncoming, myUserId, buildPushArchive]);

  async function handleSend() {
    const text = inputValue.trim();
    if (!text) return;
    // Clear FIRST. Waiting for the server round-trip left the sent text sitting
    // in the box, so the next keystrokes landed after it and a fast second
    // message read as an edit of the first. The composer belongs to the user,
    // not to the request.
    setInputValue('');
    // The box grew with the message; an emptied composer that stays five rows
    // tall is the same bug from the other side.
    if (inputRef.current) inputRef.current.style.height = 'auto';
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
      // Stamp the row with what we just sealed. The echo can outrun the POST
      // response, and this is the only thing the two have in common before the
      // server assigns an id.
      setMessages((prev) => prev.map((m) => (m.id === pendingId ? { ...m, sealed } : m)));
      const pushArchive = await buildPushArchive(text);
      const res = await apiFetch(`/api/topics/${topicId}/chat`, {
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
            // Pre-seed the decrypt memo so the SSE echo of our own message never
            // reaches MLS at all (a sender cannot open its own message).
            decryptOnceRef.current.set(payload.id, { ...payload, message: text });
            /*
             * Rename the row that is already on screen — id only.
             *
             * It used to be removed and re-merged, which redrew the bubble from
             * the server row: it vanished, came back at the position the
             * SERVER's timestamp put it in, and while this raced the SSE echo
             * the same message was on screen twice. Nothing about the row needs
             * to change except the id it is filed under.
             *
             * If the echo got here first it has already done this, and there is
             * nothing left matching the provisional id — so this is a no-op.
             */
            setMessages((prev) =>
              prev.map((m) => (m.id === pendingId ? { ...m, id: payload.id, pending: false } : m)),
            );
            // Cache own plaintext so it survives a restart (sender can't self-decrypt).
            void getMlsSessionStore().cachePlaintext(topicId, payload.id, text);
            // Re-encrypt for the archive so later members can read it (Phase 3).
            void getTakSessionStore().archiveOnSend(topicId, payload.id, text, tierRef.current).catch(() => {});
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
    /*
     * An attachment retries ITSELF — it never goes back through the composer.
     *
     * The object is already stored, so this re-sends the same envelope rather
     * than re-uploading: the user cannot be asked to find the file again, and
     * on the failure this was built for (an MLS epoch conflict) the retry
     * succeeds as soon as the group settles, with no new bytes anywhere.
     */
    const envelope = parseChatMediaBody(msg.draft ?? msg.message);
    if (envelope) {
      void resendAttachment(msg.id, envelope);
      return;
    }
    const text = msg.draft ?? msg.message;
    setMessages((prev) => prev.filter((m) => m.id !== msg.id));
    setInputValue(text);
    // Next tick: handleSend reads `inputValue`, which has not committed yet.
    setTimeout(() => {
      void handleSend();
    }, 0);
  }

  /**
   * Re-send a stored attachment under its existing row.
   *
   * The row keeps its place in the conversation while this runs, so a retry
   * does not make the picture jump to the bottom — the message was sent when
   * the user sent it, not when the network finally cooperated.
   */
  async function resendAttachment(rowId: string, envelope: ChatMediaEnvelope) {
    const body = buildChatMediaBody(envelope);
    setMessages((prev) => prev.map((m) => (m.id === rowId ? { ...m, failed: false, pending: true } : m)));
    /*
     * Does the object still exist?
     *
     * A row restored from storage can outlive its bytes: an unclaimed
     * attachment is collected an hour after upload. Re-sending regardless would
     * post a message pointing at nothing — every reader would see a permanently
     * broken picture — so this asks first and says so plainly instead. Checked
     * rather than assumed from the row's age, because the collector is
     * request-triggered and an object may well outlive the window.
     */
    try {
      const probe = await apiFetch(
        `/api/topics/${topicId}/chat/media?key=${encodeURIComponent(envelope.key)}`,
        { credentials: 'include' },
      );
      if (probe.status === 404) {
        setMessages((prev) =>
          prev.map((m) => (m.id === rowId ? { ...m, pending: false, failed: true, mediaExpired: true } : m)),
        );
        return;
      }
    } catch {
      // The probe itself failed — that is a network problem, not an expiry.
      // Fall through and let the send report it.
    }
    try {
      const sealed = await getMlsSessionStore().seal(topicId, body);
      rememberOwnPlaintext(sealed.ciphertext, body);
      // A retry is a send: it carries the push preview like the first attempt
      // did, or a picture that failed once would be the only one that never
      // notifies anybody.
      const pushArchive = await buildPushArchive(body);
      const res = await apiFetch(`/api/topics/${topicId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ciphertext: sealed.ciphertext, epoch: sealed.epoch, pushArchive }),
      });
      if (!res.ok) throw new Error(`send failed (${res.status})`);
      const { message: payload } = await res.json();
      setMessages((prev) => prev.filter((m) => m.id !== rowId));
      forgetFailedMedia(rowId);
      if (!payload?.id) return;
      const own: ChatMessage = { ...payload, message: body };
      decryptOnceRef.current.set(payload.id, own);
      applyIncoming([own]);
      void getMlsSessionStore().cachePlaintext(topicId, payload.id, body);
      void getTakSessionStore().archiveOnSend(topicId, payload.id, body, tierRef.current).catch(() => {});
      // Only NOW is the object referenced by a real message.
      void apiFetch(`/api/topics/${topicId}/chat/media?key=${encodeURIComponent(envelope.key)}`, {
        method: 'PATCH',
        credentials: 'include',
      }).catch(() => {});
    } catch {
      // Back to failed, same row, same place. The object is still there.
      setMessages((prev) =>
        prev.map((m) => (m.id === rowId ? { ...m, pending: false, failed: true } : m)),
      );
    }
  }

  function discardFailed(msg: ChatMessage) {
    setMessages((prev) => prev.filter((m) => m.id !== msg.id));
    forgetFailedMedia(msg.id);
    /*
     * Deleting the row is not enough for an attachment: its bytes are on the
     * server, and nothing else will ever mention them. Abandoning a failed send
     * must not leave one behind — the M-1 collector would eventually take it,
     * but an hour of paid-for storage for a message the user just cancelled is
     * not a design, it is a leak with a timer.
     */
    if (msg.mediaKey) {
      void apiFetch(`/api/topics/${topicId}/chat/media?key=${encodeURIComponent(msg.mediaKey)}`, {
        method: 'DELETE',
        credentials: 'include',
      }).catch(() => {});
    }
  }

  /**
   * Grow the composer to fit what has been typed, up to `COMPOSER_MAX_HEIGHT`.
   *
   * Height has to be cleared before it is read: `scrollHeight` on an element
   * that is already tall enough reports the CURRENT height, so without the
   * reset the box can only ever grow and a deleted line never gives its row
   * back. A zero measurement (jsdom, or a box that is not laid out yet) is
   * left alone rather than written as `0px` — nothing is known at that point,
   * and a guess would collapse the composer.
   */
  function autoGrow(el: HTMLTextAreaElement | null) {
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) {
      el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    /*
     * An Enter that is COMMITTING an IME composition is not a send.
     *
     * Typing Korean (or Japanese, or Chinese) leaves the last syllable in the
     * IME's buffer, and Enter first commits it — the browser fires keydown with
     * `isComposing` set, then fires a SECOND Enter once the commit lands. The
     * old code treated both as sends: the first sent the message and emptied
     * the composer, the IME then wrote the committed jamo back into the empty
     * box, and the second sent that as a message of its own. Every Korean
     * message arrived as two, the second one a single stray letter.
     *
     * `keyCode === 229` is the same signal from browsers that do not set
     * `isComposing` — it is the standard "the IME is handling this" code.
     */
    const composing =
      (e.nativeEvent as KeyboardEvent).isComposing || (e.nativeEvent as KeyboardEvent).keyCode === 229;
    if (composing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  useEffect(() => {
    if (isGuest) return;
    let alive = true;
    apiFetch('/api/auth/session')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.userId) return;
        cachedUserId = d.userId;
        if (alive) setMyUserId(d.userId);
      })
      .catch(() => {})
      // Settled either way: an unanswered lookup must not hold the room shut.
      .finally(() => {
        if (alive) setSessionProbed(true);
      });
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
      const res = await apiFetch(
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
  // timer while the room is open. `distributeRootWhenGroupChanged` is a
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
          .distributeRootWhenGroupChanged(topicId, tierRef.current)
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
    const bottom = messages.length > 0 ? messages[messages.length - 1] : null;
    /*
     * KEYED ON CONTENT, not on the bottom row's id.
     *
     * The id was the bug. Decryption never changes ids — `catchUpArchive`
     * replaces bodies in place on the rows already in state — so the pass that
     * finally makes a room readable produced an unchanged id and returned here
     * before scrolling. The reader was left looking at wherever the locked,
     * empty rows had happened to put them.
     *
     * It compounded with `initialScrolledRef`, which the FIRST paint sets while
     * the list is still `syncing` (a centred spinner, no rows at all) or every
     * row is locked and renders nothing. So the scroll that was recorded as
     * "done" was a scroll over no content, and every row then grew twice: once
     * as it decrypted, once as its <img> loaded. The second growth is the
     * observer below; this handles the first.
     *
     * `lockedCount` and `syncing` are in the key because a decrypt anywhere in
     * the list — not only in the last row — changes how far the bottom is, and
     * `syncing` flipping false swaps a spinner for the whole conversation.
     */
    const bottomKey = bottom
      ? [
          bottom.id,
          bottom.undecryptable ? 'locked' : 'open',
          bottom.message.length,
          lockedCount,
          syncing ? 'syncing' : 'live',
        ].join('|')
      : null;
    if (bottomKey === lastBottomKeyRef.current) return;
    lastBottomKeyRef.current = bottomKey;
    if (!bottom) return;
    if (!initialScrolledRef.current || userNearBottomRef.current) {
      const isFirstPaint = !initialScrolledRef.current;
      initialScrolledRef.current = true;
      scrollToBottom(!isFirstPaint);
    }
  }, [messages, lockedCount, syncing, scrollToBottom]);

  /**
   * Re-pin to the bottom when the list GROWS under a reader who is already
   * there — an `<img>` that finished loading, a row that decrypted after paint,
   * a late web font.
   *
   * A React effect cannot see any of those: they change the layout without
   * changing the state the effect above is keyed on. An image is the loud case,
   * because its box is zero until the bytes arrive and then it is hundreds of
   * pixels, so every attachment silently pushed the conversation below the fold
   * of a scroller that had already been told it was at the bottom.
   *
   * Observing the CONTENT box rather than hooking each image keeps this out of
   * `ChatImage` and covers the other two causes for free. Deliberately narrow:
   * growth only (a shrink is a row being removed, and chasing it would fight
   * the reader), never while a page of older history is mid-prepend (that path
   * restores its own anchor), and never unless the reader was already at the
   * bottom — so reading history is not interrupted by a picture two screens up.
   */
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    let lastHeight = content.getBoundingClientRect().height;
    const ro = new ResizeObserver(() => {
      const height = content.getBoundingClientRect().height;
      const grew = height > lastHeight;
      lastHeight = height;
      if (!grew) return;
      if (!initialScrolledRef.current || !userNearBottomRef.current) return;
      if (pendingScrollAnchorRef.current != null) return;
      scrollToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom]);

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
        await getTakSessionStore().backfillMissingArchive(topicId, tierRef.current, readable);
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
  /**
   * Bring the ratchet tree back in line with who the topic's members actually
   * are, evicting the leaves of anyone who left or was removed.
   *
   * Best-effort and silent: an unreachable member list, or a lost epoch-CAS
   * race, means the next member to open the room repairs it instead. A DM needs
   * no special case — both parties are members, so it finds nothing to do.
   */
  const reconcileGroupMembership = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/topics/${topicId}/members`);
      if (!res.ok) return;
      const data = (await res.json()) as { members?: Array<{ userId?: string }> };
      const ids = (data.members ?? []).map((m) => m.userId).filter((id): id is string => !!id);
      // An EMPTY list is refused rather than acted on. It is far more likely to
      // be a response shape we failed to read than a topic that genuinely has
      // no members, and acting on it would evict everyone.
      if (ids.length === 0) return;
      await getMlsSessionStore().reconcileMembership(topicId, ids);
    } catch {
      /* the next member to open the room tries again */
    }
  }, [topicId]);

  const catchUpArchive = useCallback(async () => {
    let recovered: Array<{ messageId: string; plaintext: string }> = [];
    try {
      recovered = await getTakSessionStore().backfill(topicId, tierRef.current);
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
      const currentTier = tierRef.current;
      if (currentTier === 'public') {
        const deviceId = await tak.myDeviceId(topicId);
        // Only a device that HOLDS the root may take the role, because the
        // holder is who everyone else receives the root from. A device still
        // waiting for it that claims anyway makes itself the one party nobody
        // will ever send a bundle to — and blocks every newer device behind it.
        const rootFingerprint = await tak.publicRootFingerprint(topicId);
        if (!rootFingerprint) {
          // Waiting for the root. If a previous visit already took the lease,
          // hand it back now rather than idling on it for the full 15 minutes.
          await apiFetch(`/api/topics/${topicId}/tak/holder?deviceId=${encodeURIComponent(deviceId)}`, {
            method: 'DELETE',
            credentials: 'include',
          });
          return;
        }
        await apiFetch(`/api/topics/${topicId}/tak/holder`, {
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
        await tak.distributeRootWhenGroupChanged(topicId, currentTier);
      } else if (usesTopicRootKey(currentTier)) {
        /*
         * A DM. Same delivery as public — the root wrapped to every member leaf
         * — minus the holder lease, which is a public-tier mechanism: a DM has
         * two participants and nobody to elect. This is the ONLY way a DM's key
         * travels, because the server is not allowed to hold it.
         */
        await tak.distributeRootWhenGroupChanged(topicId, currentTier);
      } else if (currentTier === 'private') {
        await tak.grantPrivateHistory(topicId);
      } else if (currentTier === 'secret' && roleRef.current === 'owner') {
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
        // Ask the SERVER, every tick — the resolver caches a 'waiting' answer
        // for fifteen seconds, and a device polling because it is waiting is
        // exactly the caller that must not be answered from that cache.
        getTakSessionStore().forgetUnsettledRoot(topicId);
        const state = await getTakSessionStore().archiveRootState(topicId, tierRef.current);
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
        /*
         * Re-read AFTER catching up, and report THAT. `state` was read before
         * the catch-up that ingests the bundle and adopts the root, so the pass
         * that actually unlocked the room reported the state from before it did
         * — spinner up, work already done.
         */
        const settled =
          (await getTakSessionStore().archiveRootState(topicId, tierRef.current)) ?? state;
        if (alive) setRootState(settled);
        return settled === 'verified';
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
          // Capped low while the room is open and its history is locked — the
          // reader is watching a spinner.
          delay = Math.min(delay * 2, 5_000);
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
    // Not empty: a room opens holding whatever the last session failed to send.
    setMessages(restoredFailedRows());
    setHasMoreHistory(false);
    hasMoreHistoryRef.current = false;
    loadingOlderRef.current = false;
    setLoadingOlder(false);
    decryptOnceRef.current = new DecryptOnce<ChatMessage>();
    lastSeenIsoRef.current = null;
    oldestIdRef.current = null;
    lastBottomKeyRef.current = null;
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
        apiFetch(`/api/topics/${topicId}`, { credentials: 'include' })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        apiFetch(`/api/topics/${topicId}/chat?limit=${HISTORY_PAGE_LIMIT}`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      const v = (topicMeta?.topic?.visibility ?? topicMeta?.visibility) as Visibility | undefined;
      if (v === 'public' || v === 'private' || v === 'secret') {
        visibilityRef.current = v;
        setVisibility(v);
      }
      // `kind` decides the tier alongside visibility: a DM carries whatever
      // visibility its row happens to have, and the banner must not read it.
      const dm = (topicMeta?.topic?.kind ?? topicMeta?.kind) === 'dm';
      setIsDm(dm);
      tierRef.current = chatTierOf(visibilityRef.current, dm);
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

      // Make removals real. A kick, a leave and an account deletion all end as
      // a missing membership row; the ratchet tree only catches up when some
      // member's client commits the Remove. Doing it here rather than in the
      // acting admin's request is what keeps the group correct when that admin
      // closes the tab mid-kick — any member repairs it on their next visit.
      void reconcileGroupMembership();
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
            const r = await apiFetch(
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
  }, [topicId, isGuest, isMember, provisionArchiveAccess, ingest, applyIncoming, restoredFailedRows]);

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
        <E2eeBanner tier={tier} />
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
      <E2eeBanner connected={connected} tier={tier} />
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
        <div ref={contentRef} style={{
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
          {/* Only when there is something WRONG. While the room key is still on
              its way the centred spinner below is the whole story — a notice
              under the header said the same thing twice and pushed the first
              message up behind it. */}
          {!syncing && <LockedHistoryNotice syncing={false} lockedCount={lockedCount} />}
          {!isGuest && isMember && !sessionProbed ? (
            /* Which side a bubble belongs on is not yet knowable. Drawing now
               would put the reader's own messages under someone else's name and
               then move them across the panel a moment later. */
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0' }}>
              <Spinner size={20} />
            </div>
          ) : syncing ? (
            /* Every row is sealed until the key lands, so a list is the wrong
               thing to draw. One spinner, centred, and the messages when they
               are readable. */
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0' }}>
              <Spinner size={20} />
            </div>
          ) : messages.length === 0 ? (
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
                  topicId={topicId}
                  tier={tier}
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
      {mediaError && (
        <div
          role="alert"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-2)',
            padding: roomy ? '8px 20px' : '6px 10px',
            fontSize: 'var(--text-label)',
            color: 'var(--color-status-danger, var(--color-text-tertiary))',
            background: 'var(--color-bg-secondary)',
          }}
        >
          {/* `limit` from the constant, so the sentence cannot claim a size
              the transport will refuse — it used to say 10MB while anything
              over ~7.4MB failed in the body parser. */}
          <span>
            {t(`chat.media.error.${mediaError}`, {
              limit: Math.floor(MAX_CHAT_MEDIA_BYTES / (1024 * 1024)),
            })}
          </span>
          <button
            type="button"
            onClick={() => setMediaError(null)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', textDecoration: 'underline' }}
          >
            {t('chat.offline.dismiss')}
          </button>
        </div>
      )}
      <div style={{
        display: 'flex',
        // `flex-end`, not `center`: the composer is a textarea that grows with
        // the message, and centred buttons would drift up its side as it does.
        // Identical to `center` at the resting single-row height.
        alignItems: 'flex-end',
        gap: 6,
        padding: roomy ? '12px 20px' : '8px 10px',
        ...measureStyle,
      }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          // `multiple` and the loop below are one change, not two. The mini-app
          // has picked several photos at once for a while; the web could pick
          // exactly one, and adding the attribute on its own would have made the
          // picker accept three and send the first — a worse bug than the one it
          // was fixing, because nothing on screen says the other two were
          // dropped. `sendPickedFiles` is what makes three picks three messages.
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            // Read BEFORE the input is cleared: `FileList` is live, and
            // resetting `value` empties it.
            void sendPickedFiles(files, sendImage);
            // Allow selecting the same files again later.
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
        {/* A TEXTAREA, not an `<input>`.
            Shift+Enter was already excluded from the send path below, and it
            still did nothing: `<input type="text">` cannot hold a newline at
            all, so the browser had nothing to insert and the guard was
            unreachable in practice. The element was the defect, not the
            handler. `rows={1}` keeps the resting shape identical to the old
            single-line pill; `autoGrow` gives the extra rows back as they are
            typed. */}
        <textarea
          ref={inputRef}
          rows={1}
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            autoGrow(e.target);
          }}
          onKeyDown={handleKeyDown}
          onPaste={(e) => {
            /*
             * EVERY image on the clipboard, not the first — the same rule as
             * the file input above, and broken here in the same way: `.find()`
             * took one and the rest went nowhere, with nothing on screen
             * saying so.
             *
             * `getAsFile()` runs HERE, synchronously, before anything is
             * awaited. `clipboardData.items` is only alive for the duration of
             * the event, so reading it from inside the async send hands back
             * null and the paste vanishes.
             */
            const files = Array.from(e.clipboardData.items)
              .filter((i) => i.type.startsWith('image/'))
              .map((i) => i.getAsFile())
              .filter((f): f is File => f !== null);
            // No image on the clipboard — an ordinary text paste, which is the
            // browser's to handle. Calling `preventDefault` unconditionally
            // here would stop text pasting into the composer altogether.
            if (files.length === 0) return;
            e.preventDefault();
            void sendPickedFiles(files, sendImage);
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
            // The three that a textarea needs and an <input> never did:
            //   • the drag handle a textarea draws by default is a second,
            //     worse way to resize something that already sizes itself;
            //   • the extra rows are given by `autoGrow`, and past the
            //     ceiling the box scrolls rather than growing further;
            //   • `font: inherit` — a bare textarea falls back to the
            //     browser's monospace default, which the <input> did not.
            resize: 'none',
            overflowY: 'auto',
            maxHeight: COMPOSER_MAX_HEIGHT,
            fontFamily: 'inherit',
            lineHeight: 1.4,
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
