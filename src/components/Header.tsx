'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import HeaderSearchBar from '@/components/HeaderSearchBar';
import LocaleSwitcher from '@/components/LocaleSwitcher';
import ThemeToggle from '@/components/ThemeToggle';
import { useTranslation } from '@/lib/i18n/I18nProvider';

interface UserSession {
  nickname?: string;
  userId?: string;
}

interface HeaderProps {
  onMenuToggle?: () => void;
  menuOpen?: boolean;
  /** Toggles the chat rail (`ChatRail.tsx`, owned by `CommunityLayout`).
   *  Omitted on pages that render `Header` standalone (recovery/docs/profile),
   *  which have no rail to toggle — the button only renders when both this
   *  AND a resolved signed-in session are present (see render below). */
  onChatToggle?: () => void;
  chatOpen?: boolean;
}

function getCachedSession(): UserSession | null {
  try {
    const cached = localStorage.getItem('os-session');
    return cached ? JSON.parse(cached) : null;
  } catch { return null; }
}

function setCachedSession(data: UserSession | null) {
  try {
    if (data) localStorage.setItem('os-session', JSON.stringify(data));
    else localStorage.removeItem('os-session');
  } catch {}
}

/**
 * One header nav link. Extracted because the three links were three verbatim
 * copies of the same 20-line inline style plus a pair of onMouseEnter/
 * onMouseLeave handlers that hand-simulated `:hover` — which meant no keyboard
 * focus state existed at all. Hover and focus now come from `.os-header-link`
 * in globals.css.
 *
 * `os-label` carries the uppercase + letter-spacing idiom, and it is gated to
 * `:lang(en)`: these labels render Korean ("탐색", "문서") under the ko locale,
 * where uppercase is a no-op and tracking reads as broken kerning.
 */
function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="os-header-link header-nav-link os-label">
      {children}
    </Link>
  );
}

export default function Header({ onMenuToggle, menuOpen, onChatToggle, chatOpen }: HeaderProps = {}) {
  const { t } = useTranslation();
  // Initial render MUST match SSR (no localStorage on the server).
  // Reading `getCachedSession()` in the useState initializer caused React
  // #418: the server rendered the guest placeholder span while the client's
  // first paint rendered the cached <Link href="/my">{nickname}</Link>, so
  // the SSR vs CSR HTML structure diverged on every page load and React
  // tore down + retried hydration in a postMessage retry loop. The cache
  // is now applied AFTER mount so SSR and the first client render match.
  const [user, setUser] = useState<UserSession | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);

  useEffect(() => {
    // Hydrate from cache first (avoids flashing the "Sign in" pill for
    // already-signed-in users) and mark the session as checked so the
    // header switches from the placeholder span to the real chip.
    const cached = getCachedSession();
    if (cached?.userId) {
      setUser(cached);
      setSessionChecked(true);
    }

    fetch('/api/auth/session')
      .then((r) => r.json())
      .then((data) => {
        if (data?.userId) {
          setUser(data);
          setCachedSession(data);
        } else {
          setUser(null);
          setCachedSession(null);
        }
      })
      .catch(() => {})
      .finally(() => setSessionChecked(true));
  }, []);

  return (
    <header className={`os-header${onMenuToggle ? ' has-mobile-chrome' : ''}`} role="banner">
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', maxWidth: 1400, margin: '0 auto', padding: '0 var(--space-5)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Mobile hamburger -- visible below 768px only */}
          {onMenuToggle && (
            <button
              onClick={onMenuToggle}
              aria-label={menuOpen ? t('header.closeMenu') : t('header.openMenu')}
              className="header-hamburger os-header-btn"
              style={{ display: 'none' }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                {menuOpen ? (
                  <>
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </>
                ) : (
                  <>
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <line x1="3" y1="12" x2="21" y2="12" />
                    <line x1="3" y1="18" x2="21" y2="18" />
                  </>
                )}
              </svg>
            </button>
          )}

          <Link
            href="/topics"
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              textDecoration: 'none', color: 'inherit',
            }}
            aria-label={t('header.homeAriaLabel')}
          >
          {/* Logo mark */}
          <img src="/images/openstoa-logo-mark-transparent.png" alt="OpenStoa" width={24} height={24} style={{ objectFit: 'contain' }} />
          <span
            className="header-wordmark"
            style={{
              fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 'var(--text-body-lg)',
              letterSpacing: '-0.03em', color: 'var(--color-text-primary)',
            }}
          >
            Open<span style={{ color: 'var(--color-brand-primary)' }}>Stoa</span>
          </span>
        </Link>
        </div>

        {/* Sticky search — same affordance as mobile SearchBar. Wrapped
            in Suspense because next/navigation's useSearchParams suspends. */}
        <div className="header-search-wrap" style={{ flex: 1, display: 'flex', justifyContent: 'center', padding: '0 16px', minWidth: 0 }}>
          <Suspense fallback={<div style={{ height: 30 }} />}>
            <HeaderSearchBar />
          </Suspense>
        </div>

        <nav style={{ display: 'flex', alignItems: 'center', gap: 8 }} className="header-nav">
          {/* DISABLED 2026-05-25: AI Ask link hidden because LLM API providers deprecated.
              See docs/migration/third-party-services.md §4-6 and /api/ask routes (commented).
              Re-enable by uncommenting the <Link> below.
          <Link
            href="/ask"
            className="header-nav-link"
            style={{
              color: '#788cff', fontSize: 12, textDecoration: 'none',
              fontFamily: 'var(--font-mono)', fontWeight: 500,
              letterSpacing: '0.04em', textTransform: 'uppercase' as const,
              transition: 'all 0.15s',
              padding: '6px 14px', borderRadius: 6,
              border: '1px solid rgba(120,140,255,0.25)',
              display: 'flex', alignItems: 'center', gap: 5,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'rgba(120,140,255,0.1)';
              (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.5)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'none';
              (e.currentTarget as HTMLElement).style.borderColor = 'rgba(120,140,255,0.25)';
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Ask
          </Link>
          */}

          {/* Hidden below 768px (`.header-nav-link`, see the style block).
              Their destinations are not lost: Explore and Recorded are the
              tab bar's Topics tab and the drawer's on-chain-records row, and
              Docs was added to the drawer. Icons were considered and rejected
              — "explore" / "recorded" / "docs" have no glyph a user reads
              unambiguously, so that would trade an overflow for a guess. */}
          <NavLink href="/topics/explore">{t('header.explore')}</NavLink>
          <NavLink href="/recorded">{t('header.recorded')}</NavLink>
          <NavLink href="/docs">{t('header.docs')}</NavLink>

          {/* FIX7: the "Messages" text link that used to live here full-page-
              navigated to `/dm`, duplicating this chat toggle button — two
              controls for one destination, and only one of them opened the
              rail. Removed; the toggle below is now the SOLE chat/DM entry
              point in the header. `/dm` itself still resolves as a direct
              URL (bookmarks, the rail's own open-in-new-tab target) — it is
              just no longer linked from here.
              FIX8: the "Recovery" text link that used to sit next to it was
              removed the same way — recovery now lives in the profile/account
              area (`/my`'s Settings tab, mirroring mobile's `ProfileStack` ->
              `AccountRecoveryScreen`), not the top-level nav. `/recovery`
              itself still resolves as a direct URL. */}

          {/* Chat rail toggle — gated on a resolved signed-in session, same
              as the removed links above. `onChatToggle` is only passed by
              `CommunityLayout`, so standalone Header usages (recovery/docs/
              profile pages) never render a button with nothing to toggle. */}
          {user && onChatToggle && (
            <button
              type="button"
              onClick={onChatToggle}
              aria-pressed={chatOpen}
              aria-label={chatOpen ? t('chat.close') : t('header.openChat')}
              title={chatOpen ? t('chat.close') : t('header.openChat')}
              className="os-header-btn header-dupe-mobile"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
              </svg>
            </button>
          )}

          {/* FIX6: language is not an auth-gated preference — visible for
              guests and signed-in users alike, unlike every link above it.
              Both carry `header-dupe-mobile`: below 768px the drawer's
              Preferences group renders these same two controls (shared
              `useTranslation()` / `theme.ts` state, so they cannot disagree),
              and a preference the user changes once a month has no claim on
              a phone-width header row. */}
          <ThemeToggle className="header-dupe-mobile" />
          <LocaleSwitcher className="header-dupe-mobile" />

          {!sessionChecked ? (
            // Reserves the chip's footprint so the row does not reflow when the
            // session resolves — and is hidden at phone widths on the same
            // terms as the chip it stands in for, or it would reserve 88px of
            // nothing there.
            <span className="header-dupe-mobile" style={{ width: 88, height: 'var(--touch-target-min)' }} />
          ) : user ? (
            <Link
              href="/my"
              className="os-header-btn header-dupe-mobile"
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-label)',
                textDecoration: 'none',
                maxWidth: 180,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                display: 'block',
                lineHeight: 'var(--touch-target-min)',
              }}
            >
              {user.nickname ??
                (user.userId
                  ? `${user.userId.slice(0, 6)}…${user.userId.slice(-4)}`
                  : t('header.anonFallback'))}
            </Link>
          ) : (
            // The only brand-filled control in the header: signing in is the
            // one action a guest is here to take — on desktop. At phone
            // widths it carries `header-dupe-mobile` like the chip it
            // alternates with, because a guest there signs in at the point of
            // need (opening Profile, writing a post), which is where a member
            // would have acted too. A permanent header button would be the
            // one control whose presence announced "you are not signed in" on
            // every screen, while doing nothing the contextual prompt does
            // not already do.
            <Link href="/" className="os-header-btn os-header-cta os-label header-dupe-mobile">
              {t('header.signIn')}
            </Link>
          )}
        </nav>
      </div>

      <style>{`
        @media (max-width: 767px) {
          .header-hamburger {
            display: flex !important;
            align-items: center;
            justify-content: center;
          }
          .header-nav {
            gap: var(--space-1) !important;
          }
          /* The overflow fix is REMOVAL, not shrinking. This row carried nine
             controls at 390px with only a padding reduction to absorb them, so
             the wordmark overlapped EXPLORE and the nickname chip was clipped
             off-screen — and the shrunk targets broke the 44px minimum while
             not solving anything.

             The three text links go for good at this width: Explore is the tab
             bar's Topics tab, Recorded is the drawer's on-chain-records row,
             and Docs was added to the drawer. */
          .header-nav-link {
            display: none !important;
          }
          /* Controls the mobile chrome already provides — the chat toggle and
             the nickname chip (tab bar's Chat and Profile), the theme toggle
             and language select (drawer's Preferences group), and the guest
             Sign in CTA (a guest signs in at the point of need, the same
             moment a member would have acted).

             What is left at 390px is a hamburger and the logo mark, which is
             the whole point: every one of these has a home in the drawer or
             the tab bar, so keeping a second copy in the header was not
             redundancy the user could ignore — it was the row overflowing.

             Scoped to .has-mobile-chrome: /docs, /recovery and /profile
             render this Header WITHOUT CommunityLayout, so they have neither a
             tab bar nor a drawer. Hiding these there would leave those pages
             with no navigation and no way to change theme or language at all. */
          .has-mobile-chrome .header-dupe-mobile {
            display: none !important;
          }
          /* The wordmark TEXT only — the <img> logo mark stays, and the link's
             own aria-label carries the accessible name either way, so this
             costs no information. Separate from the rule above because the
             reason is different: nothing duplicates the wordmark, it is simply
             the widest thing in the row that is not an affordance. Same
             .has-mobile-chrome scope, so standalone pages keep it. */
          .has-mobile-chrome .header-wordmark {
            display: none !important;
          }
          .header-search-wrap {
            display: none !important;
          }
        }
        @media (max-width: 380px) {
          .header-nav-link {
            padding: 3px 4px !important;
            /* Was 9px, below the 12px floor. */
            font-size: var(--text-label) !important;
            letter-spacing: 0.01em !important;
          }
        }
      `}</style>
    </header>
  );
}
