'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMediaQuery, MOBILE_QUERY } from '@/hooks/useMediaQuery';
import { useChatRail } from '@/lib/chatRailContext';
import { useTranslation } from '@/lib/i18n/I18nProvider';
import { CommentIcon, LayersIcon, HashIcon, UserIcon, LogInIcon } from '@/components/icons';

/**
 * Phone-width bottom navigation — Feed / Topics / Chat / Profile, mirroring
 * the native app's 4 primary tabs (`OpenStoaTabNavigator.tsx`) so the web
 * mobile surface and the app read as one product (redesign spec, `.tabbar`).
 * Mounted once by `CommunityLayout` (see there) — every page that renders
 * that layout gets the bar for free; the bare full-page chat/DM shells
 * (`BareChatShell.tsx`) never render `CommunityLayout` and so never get one,
 * which is correct: those routes are themselves the full-screen destination
 * this bar's Chat tab opens (see below).
 *
 * ── Route model ──────────────────────────────────────────────────────────
 * `/topics` (exact) is the cross-topic Feed (`src/app/topics/page.tsx` hits
 * `/api/feed`) — distinct from `/topics/*`, which is "Topics" territory:
 * `/topics/explore` (the tab's own destination) plus every topic detail/
 * management page. Profile is `/my` (the nickname chip's target throughout
 * the header/chat), not `/profile` (the standalone no-CommunityLayout
 * nickname-setup step, where this bar never mounts anyway).
 *
 * Chat has no destination URL of its own to compare against `usePathname()`
 * for the common case: activating it calls `useChatRail()?.openRail(null)`,
 * the exact same module-level action `Header`'s chat toggle and
 * `LeftSidebar`'s "Chat" item already use, landing on the SAME unified
 * Topics+Direct room list (`ChatRail.tsx`) rather than inventing a second
 * "chat home". `/dm` (the standalone DM list page, still CommunityLayout-
 * hosted) is the one real routed destination in the same territory, so
 * `aria-current` for Chat keys off `pathname.startsWith('/dm')`.
 *
 * ── Hidden during the full-screen chat sheet ────────────────────────────
 * `CommunityLayout` renders `ChatRail` as a `position: fixed; inset: 0`
 * sheet on phone widths once the rail is open (its own `mobileRailOpen`).
 * That sheet owns the very bottom of the screen for its message composer —
 * literally matching the redesign prototype's "chat is a full-screen route"
 * phone frame, which renders NO `.tabbar` at all. `CommunityLayout` passes
 * that same boolean in as `hidden` so this bar unmounts (not just visually
 * hides) rather than sitting behind/under the composer inviting mis-taps.
 *
 * ── Guest vs member ──────────────────────────────────────────────────────
 * Chat and Profile both require a session (no chat to open, no `/my` to
 * view — middleware redirects a guest hitting `/my` straight to `/`
 * anyway). Rather than rendering 4 tabs with 2 that silently bounce to
 * login, a guest gets exactly the 3 tabs that make sense: Feed, Topics,
 * and a "Sign in" tab in the two slots' place — mirroring how `Header`
 * already swaps its own chat toggle + nickname chip for one "Sign in" CTA
 * for a guest, rather than showing a dead affordance.
 *
 * ── Hamburger + drawer still has a job ───────────────────────────────────
 * `CommunityLayout`'s off-canvas drawer (`LeftSidebar` inside it) is NOT
 * retired by this bar. The drawer's content — topic search, category/tag
 * filters, community stats, the on-chain-records link, the Docs link (which
 * has no tab here at all) — has no equivalent among these 4 destinations.
 * Its "Chat" group hides itself at exactly this bar's breakpoint
 * (`os-nav-mobile-dupe`, see `LeftSidebar.tsx`) since the Chat tab below
 * fires the same `openRail(null)`; its "Explore Topics" link is the one
 * remaining overlap, a single repeated affordance inside a much richer
 * secondary menu, not a second competing PRIMARY nav — this bar is the one
 * place all 4 top-level destinations live now. The prototype's mobile frames
 * keep BOTH the hamburger (`.mhdr .mtap`) and the bottom `.tabbar`
 * simultaneously, which is the same call being made here.
 */

interface BottomTabBarProps {
  isGuest: boolean;
  /** `CommunityLayout`'s own `mobileRailOpen` — see the file doc above. */
  hidden?: boolean;
}

function isFeedActive(pathname: string): boolean {
  return pathname === '/topics';
}

function isTopicsActive(pathname: string): boolean {
  return pathname.startsWith('/topics/');
}

function isChatActive(pathname: string): boolean {
  return pathname === '/dm' || pathname.startsWith('/dm/');
}

function isProfileActive(pathname: string): boolean {
  return pathname === '/my' || pathname.startsWith('/my/');
}

export default function BottomTabBar({ isGuest, hidden }: BottomTabBarProps) {
  // usePathname() is documented as always returning a string in App Router,
  // but every consumer here does substring/equality work, so a defensive
  // '' rather than trusting that unconditionally.
  const pathname = usePathname() ?? '';
  const { t } = useTranslation();
  // `null` when no `CommunityLayout` instance is mounted (see useChatRail's
  // own doc) — the Chat tab's onClick guards this with `?.` rather than
  // assuming the rail is always reachable; that path is theoretical here
  // (this component IS mounted BY CommunityLayout) but the hook's own
  // contract requires every caller to handle `null`.
  const chatRail = useChatRail();
  // serverValue=false: assume desktop on the server/first paint rather than
  // this hook's own default of `true`. This is a `position: fixed` element,
  // so guessing wrong doesn't just cost a CSS reflow (the way the CSS-only
  // left-sidebar swap works) — it would flash the bar in, then out, on
  // every desktop page load.
  const isMobile = useMediaQuery(MOBILE_QUERY, false);

  if (!isMobile || hidden) return null;

  type Item =
    | { key: string; kind: 'link'; href: string; label: string; icon: React.ReactNode; current: boolean }
    | { key: string; kind: 'button'; onClick: () => void; label: string; icon: React.ReactNode; current: boolean };

  const items: Item[] = isGuest
    ? [
        { key: 'feed', kind: 'link', href: '/topics', label: t('tabbar.feed'), icon: <LayersIcon />, current: isFeedActive(pathname) },
        { key: 'topics', kind: 'link', href: '/topics/explore', label: t('tabbar.topics'), icon: <HashIcon />, current: isTopicsActive(pathname) },
        { key: 'signIn', kind: 'link', href: '/', label: t('header.signIn'), icon: <LogInIcon />, current: pathname === '/' },
      ]
    : [
        { key: 'feed', kind: 'link', href: '/topics', label: t('tabbar.feed'), icon: <LayersIcon />, current: isFeedActive(pathname) },
        { key: 'topics', kind: 'link', href: '/topics/explore', label: t('tabbar.topics'), icon: <HashIcon />, current: isTopicsActive(pathname) },
        {
          key: 'chat',
          kind: 'button',
          onClick: () => chatRail?.openRail(null),
          label: t('tabbar.chat'),
          icon: <CommentIcon size={20} />,
          current: isChatActive(pathname),
        },
        { key: 'profile', kind: 'link', href: '/my', label: t('tabbar.profile'), icon: <UserIcon />, current: isProfileActive(pathname) },
      ];

  return (
    <>
      {/* In-flow spacer, same height as the fixed bar below — reserves its
          space at the end of the page so the bar never covers the last bit
          of scrollable content (a `position: fixed` element occupies no
          space of its own). Rendered here rather than as a change to
          CommunityLayout's content column, which another change is
          actively restructuring. */}
      <div aria-hidden style={{ height: 'calc(var(--tabbar-h) + env(safe-area-inset-bottom, 0px))' }} />
      <nav className="os-tabbar" aria-label={t('tabbar.navLabel')} data-testid="bottom-tabbar">
        {items.map((item) =>
          item.kind === 'link' ? (
            <Link
              key={item.key}
              href={item.href}
              className="os-tabbar-item"
              aria-current={item.current ? 'page' : undefined}
              data-testid={`tabbar-${item.key}`}
            >
              <span className="os-tabbar-icon">{item.icon}</span>
              <span className="os-tabbar-label">{item.label}</span>
            </Link>
          ) : (
            <button
              key={item.key}
              type="button"
              className="os-tabbar-item"
              onClick={item.onClick}
              aria-current={item.current ? 'page' : undefined}
              data-testid={`tabbar-${item.key}`}
            >
              <span className="os-tabbar-icon">{item.icon}</span>
              <span className="os-tabbar-label">{item.label}</span>
            </button>
          ),
        )}
      </nav>

      <style>{`
        .os-tabbar {
          position: fixed;
          left: 0;
          right: 0;
          bottom: 0;
          z-index: 60;
          display: flex;
          background: var(--color-bg-primary);
          border-top: 1px solid var(--color-border-default);
          padding-bottom: env(safe-area-inset-bottom, 0px);
        }
        .os-tabbar-item {
          flex: 1 1 0;
          min-width: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 2px;
          min-height: var(--tabbar-h);
          padding: 6px 4px;
          color: var(--color-text-tertiary);
          text-decoration: none;
          background: none;
          border: none;
          font-family: var(--font-sans);
          font-size: var(--text-label);
          line-height: 1.2;
          white-space: nowrap;
          cursor: pointer;
        }
        .os-tabbar-item[aria-current='page'] {
          color: var(--color-brand-primary);
          font-weight: 650;
        }
        .os-tabbar-icon {
          display: flex;
        }
        .os-tabbar-item:focus-visible {
          outline: 2px solid var(--color-brand-primary);
          outline-offset: -2px;
        }
        /* Short (landscape) viewports: keep every tap target at the
           --touch-target-min floor, but drop the icon+label two-line
           layout down to icon-only so the bar doesn't eat a large share of
           a short screen's vertical space. */
        @media (max-height: 420px) {
          .os-tabbar-item {
            min-height: var(--touch-target-min);
            flex-direction: row;
          }
          .os-tabbar-label {
            display: none;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .os-tabbar-item {
            transition: none;
          }
        }
      `}</style>
    </>
  );
}
