'use client';

import { apiFetch } from '@/lib/apiFetch';
import { useSession } from '@/lib/useSession';
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
  /*
   * One query, shared with every other caller on the page.
   *
   * This header was the only component that cached the session — in
   * `localStorage`, under `os-session` — while sixteen other call sites fetched
   * the same endpoint themselves. `useSession` keeps the storage seed (that is
   * what stops the "Sign in" pill flashing for a signed-in reader) and hands
   * the de-duplication to the query layer the mini-app already uses.
   *
   * The hydration constraint above still holds and is why the seed happens in
   * an effect inside the hook rather than in a render-time initialiser.
   */
  const { session, isPending } = useSession();
  const user = session as UserSession | null;
  const sessionChecked = !isPending;

  return (
    // `has-app-shell` = "CommunityLayout is around this header, so a drawer, a
    // left sidebar and a tab bar carry navigation". `onMenuToggle` is only ever
    // passed from there, so its presence IS that signal. It was previously
    // named after the phone-width chrome alone, which stopped being true once
    // it also gated a desktop-width rule (the three nav links, which the
    // sidebar duplicates at every width) — the old name is gone entirely, and
    // `header.test.tsx` asserts no occurrence of it survives anywhere.
    <header className={`os-header${onMenuToggle ? ' has-app-shell' : ''}`} role="banner">
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', maxWidth: 1400, margin: '0 auto', padding: '0 var(--space-5)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Mobile hamburger -- visible below 768px only.
              `.os-header-btn-ghost`, not `.os-header-btn`: at phone widths this
              button and the logo mark are the only two things left in the row,
              and a bordered, filled box beside a bare 24px mark is the louder
              of the pair by a wide margin. Ghost keeps the hover ground, the
              focus ring and the 44px target — see globals.css. */}
          {onMenuToggle && (
            <button
              onClick={onMenuToggle}
              aria-label={menuOpen ? t('header.closeMenu') : t('header.openMenu')}
              className="header-hamburger os-header-btn-ghost"
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
            className="header-brand"
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

          {/* Explore / Recorded / Docs — rendered ONLY on the standalone pages.
              `LeftSidebar` carries all three at every width it is on screen
              (the desktop rail and, below 768px, `CommunityLayout`'s drawer),
              so inside the app shell these were a second copy of the same
              three destinations on desktop and a hidden-by-CSS overflow risk
              on a phone. They are now absent from the DOM there rather than
              hidden, which is the honest version of the same result.

              The gate is `!onMenuToggle`, i.e. NOT `.has-app-shell`: `/docs`,
              `/recovery` and `/profile` render this Header on their own, with
              no sidebar, no drawer and no tab bar. Deleting the links
              unconditionally would leave those three pages with no navigation
              at all — this is the ONE place they still exist. Below 768px the
              style block still hides them even here (the standalone row cannot
              fit three text links next to the wordmark, theme, language and
              the session chip at 320px); the logo mark remains the way home.
              Icons instead of text were considered and rejected — "explore" /
              "recorded" / "docs" have no glyph a user reads unambiguously. */}
          {!onMenuToggle && (
            <>
              <NavLink href="/topics/explore">{t('header.explore')}</NavLink>
              <NavLink href="/recorded">{t('header.recorded')}</NavLink>
              <NavLink href="/docs">{t('header.docs')}</NavLink>
            </>
          )}

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
          {/* NO CHAT TOGGLE. Chat is not on the web: a person's keys live on one
              device, the mobile app, and a browser cannot hold that line —
              signing out left the MLS state, the leaf identity and the
              decrypted-picture cache behind, so the next person at a shared
              computer could read the previous person's conversation. */}

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

             Inside the app shell the three text links are no longer rendered at
             ALL widths (see the JSX), so this rule now only reaches the
             standalone pages, where they ARE rendered and where the row still
             cannot fit them next to the wordmark, the theme toggle, the
             language select and the session chip at 320px. Their destinations
             are still one tap away there via the logo mark -> /topics. */
          .header-nav-link {
            display: none !important;
          }
          /* Centre the logo mark in the bar — the phone convention, and the
             fix for the specific complaint: with the right-hand nav emptied
             out, justify-content: space-between jammed the mark against the
             hamburger and left the rest of the bar void.

             Absolute against .os-header (which is position: sticky, so it IS
             the containing block) and NOT a flex trick, because the row's two
             sides are asymmetric by construction — a 44px hamburger on one
             side, nothing on the other. Centring inside the remaining flex
             space would therefore park the mark right of centre and, worse,
             move it again the moment anything is added back to either side.
             left: 50% is measured against the header, so it holds regardless.

             Only under .has-app-shell: the standalone header still has its
             wordmark, its nav links and a full search bar in the middle of the
             row, and an absolutely-positioned mark would sit on top of them.

             At 320px (the narrowest supported width) the hamburger's box ends
             68px in — 24px row padding + 44px target — and the centred 24px
             mark spans 148..172px, so the two cannot collide. */
          .has-app-shell .header-brand {
            position: absolute;
            left: 50%;
            top: 50%;
            transform: translate(-50%, -50%);
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

             Scoped to .has-app-shell: /docs, /recovery and /profile
             render this Header WITHOUT CommunityLayout, so they have neither a
             tab bar nor a drawer. Hiding these there would leave those pages
             with no navigation and no way to change theme or language at all. */
          .has-app-shell .header-dupe-mobile {
            display: none !important;
          }
          /* The wordmark TEXT only — the <img> logo mark stays, and the link's
             own aria-label carries the accessible name either way, so this
             costs no information. Separate from the rule above because the
             reason is different: nothing duplicates the wordmark, it is simply
             the widest thing in the row that is not an affordance. Same
             .has-app-shell scope, so standalone pages keep it. */
          .has-app-shell .header-wordmark {
            display: none !important;
          }
          .header-search-wrap {
            display: none !important;
          }
        }
        /* The @media (max-width: 380px) block that used to sit here shrank
           .header-nav-link's padding and tracking to buy width. It was dead
           code — 380px is inside the 767px range above, where those links are
           already display: none — and it survived only because nothing pointed
           that out. Shrinking a tap target to fit is also the approach the
           row's whole redesign rejected. */
      `}</style>
    </header>
  );
}
