'use client';

/**
 * Handing out a way into a topic — and, for the invite-only tiers, deciding how
 * much of the conversation goes with it.
 *
 * Two things this replaces. The button used to copy `/topics/{id}/join`, which
 * mints nothing: `private` and `secret` are invite-only now and that route
 * answers 403 to exactly the tiers whose members reach for an invite. And the
 * history keys had no way out of the device at all.
 *
 * The choice is shown BEFORE the link is copied, in messages rather than in
 * epochs, because a link that quietly hands over three sessions of a private
 * room is the kind of thing people should not discover afterwards. The bound is
 * still counted in epochs — `inviteHistoryEpochs` explains why it cannot
 * honestly be counted in anything else — so the number of messages is read back
 * off the archive rows those epochs actually open.
 *
 * The keys never touch the server: they are appended to the URL FRAGMENT after
 * the token comes back, and the only thing that is displayed or logged is
 * `stripInviteHistory(url)`. The token can be revoked; the keys cannot.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/lib/i18n/I18nProvider';
import {
  chatTierOf,
  inviteHistoryEpochs,
  INVITE_HISTORY_EPOCHS_DEFAULT,
  INVITE_HISTORY_EPOCHS_MAX,
} from '@/lib/chatTierPolicy';
import { buildInviteUrl, summarizeInviteHistory, type InviteArchiveRow } from '@/lib/inviteLink';
import { stripInviteHistory } from '@/lib/inviteHistoryLink';
import { getTakSessionStore, getTakTransport } from '@/lib/mls/webTransport';

export interface InviteDialogProps {
  topicId: string;
  /** Topic visibility; anything unrecognised is treated as `public` (fewest promises). */
  visibility?: string | null;
  open: boolean;
  onClose: () => void;
}

/** Epoch numbers, newest first, capped at `count`. */
function newestEpochs(taks: Record<number, string>, count: number): number[] {
  return Object.keys(taks)
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, count);
}

function subset(taks: Record<number, string>, epochs: number[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const e of epochs) out[e] = taks[e];
  return out;
}

export default function InviteDialog({ topicId, visibility, open, onClose }: InviteDialogProps) {
  const { t, locale } = useTranslation();
  const tier = chatTierOf(visibility, false);
  // 0 for public and DM: their history does not travel in a link, so there is
  // no control to offer. Offering one that does nothing is worse than none.
  const offersHistory = inviteHistoryEpochs(tier, undefined) > 0;

  const [held, setHeld] = useState<Record<number, string>>({});
  const [rows, setRows] = useState<InviteArchiveRow[]>([]);
  const [chosen, setChosen] = useState(INVITE_HISTORY_EPOCHS_DEFAULT);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guards the double-click: `minting` is state and lags a synchronous second
  // click, so the ref is what actually makes it one POST.
  const [minting, setMinting] = useState(false);
  const mintingRef = useRef(false);

  useEffect(() => {
    if (!open) {
      // A closed dialog holds no link and no keys: reopening mints a fresh
      // token rather than re-sharing one the user may already have sent.
      setLink(null);
      setExpiresAt(null);
      setCopied(false);
      setError(null);
      return;
    }
    if (!offersHistory) return;
    let cancelled = false;
    setLoadingHistory(true);
    (async () => {
      // What this device can share is bounded by what it HOLDS — a member who
      // joined last week cannot hand over the month before it — so the offer is
      // read from the keychain, not assumed from the tier.
      const taks = await getTakSessionStore()
        .exportInviteHistory(topicId, INVITE_HISTORY_EPOCHS_MAX)
        .catch(() => ({} as Record<number, string>));
      // The archive index is what turns epochs into a number a person can act
      // on. It is the same read the chat panel does on open, and a failure here
      // only costs the sentence, never the invite.
      const archive = await getTakTransport()
        .getArchive(topicId)
        .catch(() => [] as InviteArchiveRow[]);
      if (cancelled) return;
      setHeld(taks);
      setRows(archive.map((r) => ({ takVersion: r.takVersion, createdAt: r.createdAt })));
      setLoadingHistory(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, offersHistory, topicId]);

  const heldCount = Object.keys(held).length;
  const sharedEpochs = offersHistory ? newestEpochs(held, chosen) : [];
  const offer = summarizeInviteHistory(rows, sharedEpochs);
  const formatDate = useCallback(
    (iso: string) => new Date(iso).toLocaleDateString(locale, { month: 'long', day: 'numeric' }),
    [locale],
  );

  const mint = useCallback(async () => {
    if (mintingRef.current) return;
    mintingRef.current = true;
    setMinting(true);
    setError(null);
    try {
      const res = await fetch(`/api/topics/${topicId}/invite`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // Deliberately no key material in this body — see the file header.
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t('invite.mintFailed'));
      const base = `${window.location.origin}/topics/join/${data.token}`;
      const url = buildInviteUrl(base, subset(held, sharedEpochs), topicId);
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        /*
         * Clipboard API denied (permissions, or an insecure context). Fall back
         * to the selection trick rather than giving up: the link on screen is
         * deliberately stripped of its keys, so a user who cannot copy has no
         * other way to get them.
         */
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setLink(url);
      setExpiresAt(typeof data.expiresAt === 'string' ? data.expiresAt : null);
      setCopied(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('invite.mintFailed'));
    } finally {
      mintingRef.current = false;
      setMinting(false);
    }
  }, [topicId, held, sharedEpochs, t]);

  if (!open) return null;

  const historySentence = !offersHistory
    ? t('invite.historyPublic')
    : heldCount === 0
    ? t('invite.historyUnavailable')
    : chosen === 0
    ? t('invite.historyNoneSummary')
    : offer.messages === 0
    ? t('invite.historyEmptySummary', { sessions: sharedEpochs.length })
    : offer.since
    ? t('invite.historySummary', { messages: offer.messages, date: formatDate(offer.since) })
    : t('invite.historySummaryNoDate', { messages: offer.messages });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('invite.title')}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-4)',
        background: 'color-mix(in srgb, var(--color-bg-primary) 72%, transparent)',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 460,
          background: 'var(--color-bg-secondary)',
          border: '1px solid var(--color-border-default)',
          borderRadius: 'var(--radius-modal)',
          padding: 'var(--space-5)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 'var(--text-heading-sm)', fontWeight: 800, letterSpacing: '-0.02em' }}>
          {t('invite.title')}
        </h2>

        {offersHistory && heldCount > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <label
              htmlFor="invite-history-epochs"
              style={{ fontSize: 'var(--text-body-sm)', fontWeight: 600, color: 'var(--color-text-primary)' }}
            >
              {t('invite.historyHeading')}
            </label>
            <select
              id="invite-history-epochs"
              value={chosen}
              onChange={(e) => setChosen(Number(e.target.value))}
              style={{
                background: 'var(--color-bg-primary)',
                color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-control)',
                padding: 'var(--space-2) var(--space-3)',
                fontSize: 'var(--text-body-sm)',
                minHeight: 'var(--touch-target-min)',
              }}
            >
              {/* Sharing nothing is a real choice, listed first so it reads as
                  one rather than as the absence of a decision. */}
              <option value={0}>{t('invite.historyNone')}</option>
              {Array.from({ length: Math.min(heldCount, INVITE_HISTORY_EPOCHS_MAX) }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {t('invite.historySessions', { count: n })}
                </option>
              ))}
            </select>
          </div>
        )}

        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-body-sm)',
            color: 'var(--color-text-secondary)',
            lineHeight: 'var(--leading-relaxed)',
          }}
        >
          {loadingHistory ? t('invite.historyLoading') : historySentence}
        </p>

        {offersHistory && chosen > 0 && heldCount > 0 && (
          <p
            style={{
              margin: 0,
              fontSize: 'var(--text-caption)',
              color: 'var(--color-text-tertiary)',
              lineHeight: 'var(--leading-relaxed)',
            }}
          >
            {t('invite.keysWarning')}
          </p>
        )}

        {link && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <code
              data-testid="invite-link"
              style={{
                display: 'block',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-caption)',
                color: 'var(--color-text-tertiary)',
                background: 'var(--color-bg-primary)',
                border: '1px solid var(--color-border-default)',
                borderRadius: 'var(--radius-control)',
                padding: 'var(--space-2) var(--space-3)',
                overflowWrap: 'anywhere',
              }}
            >
              {/* STRIPPED. The keys are in the copied link, not on the screen:
                  a screenshot of an invite should not be the whole room. */}
              {stripInviteHistory(link)}
            </code>
            <p style={{ margin: 0, fontSize: 'var(--text-caption)', color: 'var(--color-text-tertiary)' }}>
              {expiresAt
                ? t('invite.singleUseExpires', { date: formatDate(expiresAt) })
                : t('invite.singleUse')}
            </p>
          </div>
        )}

        {error && (
          <p role="alert" style={{ margin: 0, fontSize: 'var(--text-body-sm)', color: 'var(--color-status-danger)' }}>
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
          <button type="button" className="os-button" onClick={onClose}>
            {t('invite.close')}
          </button>
          <button
            type="button"
            className="os-button os-button-primary"
            onClick={mint}
            disabled={minting || loadingHistory}
          >
            {minting ? t('invite.minting') : copied ? t('invite.copied') : t('invite.copyLink')}
          </button>
        </div>
      </div>
    </div>
  );
}
