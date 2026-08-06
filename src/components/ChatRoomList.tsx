'use client';

/**
 * The unified two-tab conversation list — Topics (`GET /api/topics`, joined
 * only) and Direct (`GET /api/dm`) — extracted from `ChatRail.tsx` so the rail
 * and the standalone `/chat` page render the SAME rows from the same source.
 *
 * The extraction is deliberate: `/chat` is the rail's "open in new tab" target
 * for the LIST (the room-level equivalents are `/chat/{id}` and `/dm/{id}` —
 * see `newTabHref` in `src/lib/chatRail.ts`). A second hand-written list would
 * drift from the rail's the first time either side gained a field.
 *
 * This component owns rendering only. Fetching, tab state, and what a row
 * click DOES are the caller's, because the two callers answer that last
 * question differently: the rail opens the room in place, the standalone page
 * navigates to the room's own full page.
 *
 * SI-1 — nothing here can show message content. The server holds ciphertext,
 * so a row's second line is a locked placeholder, never a preview; see
 * `RoomRow` below.
 */
import Link from 'next/link';
import Avatar from './Avatar';
import Spinner from './Spinner';
import { relativeTime } from '@/lib/utils';
import type { DmChannel } from '@/lib/dm';
import { useTranslation } from '@/lib/i18n/I18nProvider';

export interface RailTopic {
  id: string;
  title: string;
  memberCount?: number;
  /** Topic-level activity timestamp from `GET /api/topics` — see `RoomRow`. */
  lastActivityAt?: string | null;
  /** When this room last had CHAT activity, from `GET /api/topics`. This — not
   *  `lastActivityAt`, which posts bump — is what the list is ordered by. */
  lastChatAt?: string | null;
  /** Creation time, the ranking key for a room nobody has spoken in yet. */
  createdAt?: string | null;
  /** Optional, and currently never sent by any route — see `RoomRow`. */
  unreadCount?: number;
}

/** `DmChannel` plus the same optional unread field, kept LOCAL rather than
 *  widened in `src/lib/dm.ts`: nothing outside the chat list consumes it yet. */
export type RailDm = DmChannel & { unreadCount?: number };

export type ListTab = 'topics' | 'dms';

export const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '10px var(--space-4)',
  background: 'transparent',
  border: 'none',
  borderBottom: '1px solid var(--border)',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'inherit',
  font: 'inherit',
  minHeight: 'var(--touch-target-min)',
};

export const emptyStateStyle: React.CSSProperties = {
  padding: '32px var(--space-5)',
  textAlign: 'center',
  fontSize: 'var(--text-caption)',
  color: 'var(--muted)',
  lineHeight: 1.6,
};

/**
 * Tabs + the active tab's list. `topics`/`dms` are `null` while loading and
 * `[]` for a legitimately empty list — the two states render differently
 * (spinner vs. empty copy), so they must not be collapsed by the caller.
 */
export default function ChatRoomList({
  tab,
  onTabChange,
  topics,
  dms,
  onOpenTopic,
  onOpenDm,
}: {
  tab: ListTab;
  onTabChange: (tab: ListTab) => void;
  topics: RailTopic[] | null;
  dms: RailDm[] | null;
  onOpenTopic: (topic: RailTopic) => void;
  onOpenDm: (dm: RailDm) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div role="tablist" aria-label={t('chatRail.tabsAriaLabel')} style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <TabButton active={tab === 'topics'} onClick={() => onTabChange('topics')} label={t('chatRail.tabs.topics')} />
        <TabButton active={tab === 'dms'} onClick={() => onTabChange('dms')} label={t('chatRail.tabs.direct')} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {tab === 'topics' ? <TopicList topics={topics} onOpen={onOpenTopic} /> : <DmList dms={dms} onOpen={onOpenDm} />}
      </div>
    </>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      // `.os-label` supplies size/weight/family and gates uppercase+tracking
      // to :lang(en) — the tab labels translate ("토픽"), and Hangul must not
      // get the Latin tracking treatment.
      className="os-label"
      style={{
        flex: 1,
        background: 'none',
        border: 'none',
        borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
        color: active ? 'var(--accent)' : 'var(--muted)',
        fontWeight: active ? 700 : 500,
        padding: '9px 0',
        cursor: 'pointer',
        minHeight: 'var(--touch-target-min)',
      }}
    >
      {label}
    </button>
  );
}

/**
 * Badge text for an unread count, or `null` when there is nothing to show.
 *
 * Absent, zero, negative, non-finite and non-numeric all mean "no badge" —
 * a JSON payload that happens to carry `unreadCount: null` must not render an
 * empty pill. Above 999 the literal count would widen the row past the title,
 * so it caps; the true number still goes to the accessible label.
 */
export function formatUnreadBadge(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return null;
  const n = Math.floor(value);
  return n > 999 ? '999+' : String(n);
}

/**
 * One conversation row: avatar, a two-line block (title + inline unread badge,
 * then a preview line), and a right-aligned relative time.
 *
 * SI-1 — the preview can NEVER come from the server. The server holds only
 * ciphertext; a plaintext preview field would mean the server had read the
 * message, which is the one thing this product promises it cannot do. So the
 * preview line is a locked placeholder, not content: "🔒 Encrypted message"
 * where the room has seen activity, and the plain "No messages yet" where it
 * has not. (A genuinely local preview would need this device's own decrypted
 * plaintext, which is cached per MESSAGE id — and the room lists carry no
 * message ids, so reaching it would mean a per-room chat fetch on every mount.
 * Not done; see the report.)
 *
 * `time` is the server's `lastActivityAt`. Note it is bumped by posts, not by
 * chat sends — for a topic room it therefore reads as "last topic activity",
 * not "last message". Left as-is deliberately: bumping it on send would push
 * chat activity into the public `sort=active` topic ordering, which is a
 * metadata channel out of this change's scope.
 *
 * `unreadCount` has no server source today — no route emits it (verified by
 * grep across `src/app/api`). The render path is wired and tested so that the
 * badge appears the day a route does emit it, and stays invisible until then.
 */
function RoomRow({
  name,
  profileImage,
  title,
  hasActivity,
  lastActivityAt,
  unreadCount,
  onClick,
  testId,
}: {
  name: string;
  profileImage?: string | null;
  title: string;
  /** False only when we positively know the room has never seen activity. */
  hasActivity: boolean;
  lastActivityAt?: string | null;
  unreadCount?: number;
  onClick: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const badge = formatUnreadBadge(unreadCount);
  return (
    <button type="button" style={rowStyle} onClick={onClick} data-testid={testId}>
      <Avatar src={profileImage ?? undefined} name={name} size={36} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 'var(--text-body-sm)',
              fontWeight: 600,
              color: 'var(--foreground)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </span>
          {badge && (
            <span
              data-testid="chat-rail-unread-badge"
              aria-label={t('chatRail.unreadCount', { count: String(Math.floor(unreadCount as number)) })}
              style={{
                flexShrink: 0,
                background: 'var(--accent)',
                color: 'var(--color-text-inverted)',
                borderRadius: 'var(--radius-pill)',
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-label)',
                fontWeight: 700,
                lineHeight: 1.7,
                padding: '0 7px',
              }}
            >
              {badge}
            </span>
          )}
        </span>
        <span
          data-testid="chat-rail-room-preview"
          style={{
            display: 'block',
            fontSize: 'var(--text-caption)',
            color: 'var(--color-text-tertiary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {hasActivity ? `🔒 ${t('chat.encryptedPreview')}` : t('chat.noMessagesYet')}
        </span>
      </span>
      {lastActivityAt && (
        <span
          data-testid="chat-rail-room-time"
          style={{
            fontSize: 'var(--text-label)',
            fontFamily: 'var(--font-mono)',
            color: 'var(--color-text-tertiary)',
            flexShrink: 0,
            alignSelf: 'flex-start',
          }}
        >
          {relativeTime(lastActivityAt)}
        </span>
      )}
    </button>
  );
}

function TopicList({ topics, onOpen }: { topics: RailTopic[] | null; onOpen: (t: RailTopic) => void }) {
  const { t } = useTranslation();
  if (topics === null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '28px 0' }}>
        <Spinner />
      </div>
    );
  }
  if (topics.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <p style={{ margin: '0 0 8px' }}>{t('chatRail.topicsEmptyBody')}</p>
        <Link href="/topics/explore" style={{ color: 'var(--accent)' }}>
          {t('chatRail.exploreTopics')}
        </Link>
      </div>
    );
  }
  return (
    <div>
      {topics.map((topic) => (
        <RoomRow
          key={topic.id}
          name={topic.title}
          title={topic.title}
          // A topic row always has activity to speak of: the server sets
          // `lastActivityAt` on creation, so there is no "never used" signal
          // to distinguish, unlike a DM channel.
          hasActivity
          lastActivityAt={topic.lastActivityAt}
          unreadCount={topic.unreadCount}
          onClick={() => onOpen(topic)}
          testId="chat-rail-topic-row"
        />
      ))}
    </div>
  );
}

function DmList({ dms, onOpen }: { dms: RailDm[] | null; onOpen: (d: RailDm) => void }) {
  const { t } = useTranslation();
  if (dms === null) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '28px 0' }}>
        <Spinner />
      </div>
    );
  }
  if (dms.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <p style={{ margin: 0 }}>{t('chatRail.dmsEmpty')}</p>
      </div>
    );
  }
  return (
    <div>
      {dms.map((d) => (
        <RoomRow
          key={d.topicId}
          name={d.peer.nickname}
          profileImage={d.peer.profileImage}
          title={d.peer.nickname}
          // A DM with no `lastActivityAt` has never been used — the one case
          // where "No messages yet" is a fact and not a guess.
          hasActivity={d.lastActivityAt != null}
          lastActivityAt={d.lastActivityAt}
          unreadCount={d.unreadCount}
          onClick={() => onOpen(d)}
          testId="chat-rail-dm-row"
        />
      ))}
    </div>
  );
}
