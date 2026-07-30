'use client';

/**
 * Minimal full-viewport shell for the standalone `/chat/[topicId]` and
 * `/dm/[topicId]` pages -- deliberately NOT `CommunityLayout`. Those routes
 * are the "open in new tab" target for a room selected in `ChatRail.tsx`
 * (`newTabHref` in `src/lib/chatRail.ts`), and the whole point is a focused,
 * self-contained chat window -- like the maximize/modal mode this redesign
 * removed, but as a real tab instead of an overlay. No `Header`, no left/right
 * sidebars, no feed chrome -- except the slim control bar below, which is
 * this shell's own chrome (width + close), not the app's.
 *
 * Because these pages never render `CommunityLayout`, they never render
 * `ChatRail` either -- there is nothing else on the page that could mount a
 * second `ChatPanel` for the same room. The `isSameRoomAsPath` guard inside
 * `ChatRail.tsx` still exists (and stays pinned by its own tests): it defends
 * a different case, a normal `CommunityLayout` page whose OWN rail happens to
 * have this same room open at the same time.
 *
 * Width control (P-1): the content column defaults to filling the window --
 * it's a separate tab, so the window itself is already the size control --
 * with narrow/wide/full presets for a reader who prefers a shorter reading
 * line. Persisted via `src/lib/chatWidth.ts`.
 *
 * Close, not back (P-2): a popped-out tab has no meaningful browser "back" --
 * it was either opened fresh via `target="_blank"` (see `newTabHref` in
 * `ChatRail.tsx`, which sets `rel="noopener noreferrer"`, so `window.opener`
 * is deliberately unavailable to us) or loaded directly from a bookmarked/
 * pasted URL. Both cases share one property this shell can act on: a tab that
 * has not navigated anywhere else has a session history of exactly one entry,
 * which is precisely the case the HTML spec allows `window.close()` to close
 * even without script-openership. So Close always tries `window.close()`
 * first. Some browsers refuse anyway (e.g. a tab whose history grew, or a
 * policy that blocks it outright) -- if that happens the tab is still here
 * after a beat, so the fallback sends it to a real in-app destination instead
 * of leaving a control that silently does nothing.
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  chatWidthPx,
  readChatWidthPreference,
  writeChatWidthPreference,
  type ChatWidthMode,
} from '@/lib/chatWidth';

const WIDTH_OPTIONS: { mode: ChatWidthMode; label: string }[] = [
  { mode: 'narrow', label: 'Narrow' },
  { mode: 'wide', label: 'Wide' },
  { mode: 'full', label: 'Full' },
];

const CloseIcon = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

export default function BareChatShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  // SSR-safe default ('full', matching the read helper's own fallback) --
  // localStorage does not exist on the server. The persisted preference is
  // applied client-side right after, same pattern `CommunityLayout` uses for
  // the rail's open/closed preference.
  const [width, setWidth] = useState<ChatWidthMode>('full');
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setWidth(readChatWidthPreference());
  }, []);

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const chooseWidth = useCallback((mode: ChatWidthMode) => {
    setWidth(mode);
    writeChatWidthPreference(mode);
  }, []);

  const handleClose = useCallback(() => {
    window.close();
    // Still here after a beat → the browser refused to close this tab (see
    // module doc). A dead button is worse than landing somewhere useful.
    closeTimer.current = setTimeout(() => {
      router.push('/topics');
    }, 300);
  }, [router]);

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--background)',
        color: 'var(--foreground)',
      }}
    >
      {/* Shell chrome: width presets + close. Deliberately thin and separate
          from the page's own identity row (topic/peer header) below it. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          padding: '6px 10px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <div role="group" aria-label="Chat width" style={{ display: 'flex', gap: 2 }}>
          {WIDTH_OPTIONS.map((opt) => (
            <button
              key={opt.mode}
              type="button"
              onClick={() => chooseWidth(opt.mode)}
              aria-pressed={width === opt.mode}
              style={{
                background: width === opt.mode ? 'rgba(120,140,255,0.14)' : 'transparent',
                color: width === opt.mode ? 'var(--accent)' : 'var(--muted)',
                border: 'none',
                borderRadius: 6,
                padding: '4px 10px',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                cursor: 'pointer',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'none',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            padding: 5,
            borderRadius: 6,
          }}
        >
          {CloseIcon}
        </button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          maxWidth: chatWidthPx(width) ?? '100%',
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {children}
      </div>
    </div>
  );
}
