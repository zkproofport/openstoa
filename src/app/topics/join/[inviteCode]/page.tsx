'use client';

/**
 * Landing on an invite link.
 *
 * The web had no page for this at all — `/api/topics/join/{code}` existed and
 * nothing on the site pointed at it — so an invite to a private or secret topic
 * had nowhere to land.
 *
 * The one property that shapes every line below: for those tiers the link's
 * FRAGMENT carries the chat-history keys, and a fragment never reaches the
 * server. So the keys are read from `location.hash` in the browser, imported
 * only AFTER the join is real, and the hash is cleared afterwards — otherwise
 * it sits in the address bar for the next person who copies "the link I used",
 * and in history for anyone with the machine. The token can be revoked; the
 * keys cannot.
 *
 * The guest path is the one that is easy to get wrong. A signed-out visitor is
 * NOT redirected away by middleware (`/topics` is guest-accessible), so the
 * fragment is still on the URL when this page renders — but the sign-in link
 * must carry it forward by hand, and the landing page must put it back after
 * login. Lose it anywhere in that chain and the user joins, sees no history,
 * and is told nothing.
 */

import { apiFetch } from '@/lib/apiFetch';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import CommunityLayout from '@/components/CommunityLayout';
import Spinner from '@/components/Spinner';
import { useTranslation } from '@/lib/i18n/I18nProvider';
import { readInviteHistory } from '@/lib/inviteLink';
import { getTakSessionStore } from '@/lib/mls/webTransport';

interface TopicPreview {
  id: string;
  title: string;
  description?: string | null;
  visibility?: string | null;
}

/** What became of the keys that rode in with the link. */
type HistoryOutcome =
  | { kind: 'none' }
  | { kind: 'wrong-topic' }
  | { kind: 'imported'; epochs: number }
  | { kind: 'already' };

type Stage = 'loading' | 'guest' | 'invalid' | 'preview' | 'member' | 'joined';

export default function InviteJoinPage() {
  const params = useParams();
  const router = useRouter();
  const { t } = useTranslation();
  const inviteCode = String(params.inviteCode ?? '');

  const [stage, setStage] = useState<Stage>('loading');
  const [topic, setTopic] = useState<TopicPreview | null>(null);
  const [history, setHistory] = useState<HistoryOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  // A second synchronous click must not mint a second membership attempt —
  // state lags, a ref does not.
  const joiningRef = useRef(false);

  /**
   * Take the keys out of the URL and into this device, then remove them from
   * the URL.
   *
   * Called ONLY once membership is real. A link whose token expired can still
   * carry a perfectly good fragment, and importing from it would put keys for a
   * topic this device is not in — and cannot leave — into its keychain.
   */
  const absorbHistory = useCallback(async (topicId: string) => {
    const read = readInviteHistory(window.location.hash, topicId);
    let outcome: HistoryOutcome;
    if (read.status === 'none') {
      outcome = { kind: 'none' };
    } else if (read.status === 'wrong-topic') {
      // Say so rather than importing. A key written into the slot for
      // (topic, epoch) cannot be replaced by the right one later.
      outcome = { kind: 'wrong-topic' };
    } else {
      const added = await getTakSessionStore()
        .importInviteHistory(topicId, read.taks)
        .catch(() => 0);
      // Zero is not a failure: it is what re-opening the same link looks like.
      // "3 more" the second time would be a lie the user could act on.
      outcome = added > 0 ? { kind: 'imported', epochs: added } : { kind: 'already' };
    }
    // Clear the fragment whatever happened — including when it was refused.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setHistory(outcome);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/topics/join/${encodeURIComponent(inviteCode)}`, {
          credentials: 'include',
        });
        if (cancelled) return;
        if (res.status === 401) {
          setStage('guest');
          return;
        }
        if (!res.ok) {
          setStage('invalid');
          return;
        }
        const data = await res.json();
        setTopic(data.topic);
        if (data.isMember) {
          setStage('member');
          // Already in: the keys are for a room this device belongs to, so
          // there is nothing to withhold. An older member re-opening an invite
          // is how they pick up epochs from before they arrived.
          await absorbHistory(data.topic.id);
          return;
        }
        setStage('preview');
      } catch {
        if (!cancelled) setStage('invalid');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteCode, absorbHistory]);

  async function handleJoin() {
    if (joiningRef.current || !topic) return;
    joiningRef.current = true;
    setJoining(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/topics/join/${encodeURIComponent(inviteCode)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // No body. The keys are in the fragment and must never be sent.
        body: JSON.stringify({}),
      });
      if (res.status === 409) {
        // Somebody (or another tab) already joined with this account.
        setStage('member');
        await absorbHistory(topic.id);
        return;
      }
      if (res.status === 404) {
        setStage('invalid');
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? t('inviteJoin.joinFailed'));
      }
      await absorbHistory(topic.id);
      setStage('joined');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inviteJoin.joinFailed'));
    } finally {
      joiningRef.current = false;
      setJoining(false);
    }
  }

  const card = {
    padding: 'var(--space-5)',
    background: 'var(--color-bg-secondary)',
    border: '1px solid var(--color-border-default)',
    borderRadius: 'var(--radius-card)',
    marginBottom: 'var(--space-5)',
  } as const;

  const historyLine =
    history === null
      ? null
      : history.kind === 'imported'
      ? t('inviteJoin.historyImported', { count: history.epochs })
      : history.kind === 'already'
      ? t('inviteJoin.historyAlready')
      : history.kind === 'wrong-topic'
      ? t('inviteJoin.historyWrongTopic')
      : t('inviteJoin.historyNone');

  return (
    <CommunityLayout isGuest={stage === 'guest'} sessionChecked={stage !== 'loading'}>
      <div
        style={{
          minHeight: 'calc(100vh - 73px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--space-6) var(--space-5)',
        }}
      >
        <div style={{ width: '100%', maxWidth: 460 }}>
          {stage === 'loading' && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--space-7) 0' }}>
              <Spinner />
            </div>
          )}

          {stage === 'guest' && (
            <div style={card}>
              <h1 style={{ fontSize: 'var(--text-heading-sm)', fontWeight: 800, margin: '0 0 var(--space-2)' }}>
                {t('inviteJoin.guestTitle')}
              </h1>
              <p
                style={{
                  fontSize: 'var(--text-body-sm)',
                  color: 'var(--color-text-secondary)',
                  margin: '0 0 var(--space-4)',
                  lineHeight: 'var(--leading-relaxed)',
                }}
              >
                {t('inviteJoin.guestBody')}
              </p>
              {/*
                The hash is appended BY HAND. A signed-out visitor still holds the
                keys in their address bar, and this is the moment they are most
                easily dropped: `href` without it silently discards them, the user
                signs in, joins, and sees an empty room with no explanation.
              */}
              <SignInLink inviteCode={inviteCode} label={t('inviteJoin.signIn')} />
            </div>
          )}

          {stage === 'invalid' && (
            <div style={card}>
              <h1 style={{ fontSize: 'var(--text-heading-sm)', fontWeight: 800, margin: '0 0 var(--space-2)' }}>
                {t('inviteJoin.invalidTitle')}
              </h1>
              <p
                style={{
                  fontSize: 'var(--text-body-sm)',
                  color: 'var(--color-text-secondary)',
                  margin: 0,
                  lineHeight: 'var(--leading-relaxed)',
                }}
              >
                {t('inviteJoin.invalidBody')}
              </p>
            </div>
          )}

          {topic && (stage === 'preview' || stage === 'member' || stage === 'joined') && (
            <div style={card}>
              <p
                style={{
                  fontSize: 'var(--text-body-sm)',
                  color: 'var(--color-text-tertiary)',
                  fontFamily: 'var(--font-mono)',
                  margin: '0 0 var(--space-2)',
                }}
              >
                {stage === 'joined'
                  ? t('inviteJoin.joinedLabel')
                  : stage === 'member'
                  ? t('inviteJoin.memberLabel')
                  : t('inviteJoin.invitedLabel')}
              </p>
              <h1 style={{ fontSize: 'var(--text-heading-sm)', fontWeight: 800, margin: '0 0 var(--space-2)' }}>
                {topic.title}
              </h1>
              {topic.description && (
                <p
                  style={{
                    fontSize: 'var(--text-body-sm)',
                    color: 'var(--color-text-secondary)',
                    margin: 0,
                    lineHeight: 'var(--leading-relaxed)',
                  }}
                >
                  {topic.description}
                </p>
              )}
              {historyLine && (stage === 'joined' || stage === 'member') && (
                <p
                  data-testid="invite-history-line"
                  style={{
                    fontSize: 'var(--text-body-sm)',
                    color:
                      history?.kind === 'wrong-topic'
                        ? 'var(--color-status-warning)'
                        : 'var(--color-text-secondary)',
                    margin: 'var(--space-3) 0 0',
                    lineHeight: 'var(--leading-relaxed)',
                  }}
                >
                  {historyLine}
                </p>
              )}
            </div>
          )}

          {error && (
            <p role="alert" style={{ fontSize: 'var(--text-body-sm)', color: 'var(--color-status-danger)', marginBottom: 'var(--space-4)' }}>
              {error}
            </p>
          )}

          {stage === 'preview' && (
            <button
              type="button"
              className="os-button os-button-primary"
              style={{ width: '100%' }}
              onClick={handleJoin}
              disabled={joining}
            >
              {joining ? t('inviteJoin.joining') : t('inviteJoin.join')}
            </button>
          )}

          {(stage === 'joined' || stage === 'member') && topic && (
            <button
              type="button"
              className="os-button os-button-primary"
              style={{ width: '100%' }}
              onClick={() => router.push(`/topics/${topic.id}`)}
            >
              {t('inviteJoin.openTopic')}
            </button>
          )}

          <div style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
            <Link
              href="/topics"
              style={{ fontSize: 'var(--text-body-sm)', color: 'var(--color-text-tertiary)', textDecoration: 'none' }}
            >
              {t('inviteJoin.browseTopics')}
            </Link>
          </div>
        </div>
      </div>
    </CommunityLayout>
  );
}

/**
 * The sign-in link, with the fragment carried across.
 *
 * A plain `href` drops it, and so would `router.push`. Built at click time from
 * the live `location.hash` rather than at render time, because the hash can be
 * cleared underneath a rendered href.
 */
function SignInLink({ inviteCode, label }: { inviteCode: string; label: string }) {
  const returnTo = `/topics/join/${encodeURIComponent(inviteCode)}`;
  return (
    <a
      href={`/?returnTo=${encodeURIComponent(returnTo)}`}
      className="os-button os-button-primary"
      data-testid="invite-signin"
      onClick={(e) => {
        const hash = window.location.hash;
        if (!hash) return; // nothing to carry — let the href do its job
        e.preventDefault();
        window.location.href = `/?returnTo=${encodeURIComponent(returnTo)}${hash}`;
      }}
    >
      {label}
    </a>
  );
}
