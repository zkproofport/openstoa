'use client';

/**
 * Minimal full-viewport shell for the standalone `/chat/[topicId]` and
 * `/dm/[topicId]` pages -- deliberately NOT `CommunityLayout`. Those routes
 * are the "open in new tab" target for a room selected in `ChatRail.tsx`
 * (`newTabHref` in `src/lib/chatRail.ts`), and the whole point is a focused,
 * self-contained chat window -- like the maximize/modal mode this redesign
 * removed, but as a real tab instead of an overlay. No `Header`, no left/right
 * sidebars, no feed chrome.
 *
 * Because these pages never render `CommunityLayout`, they never render
 * `ChatRail` either -- there is nothing else on the page that could mount a
 * second `ChatPanel` for the same room. The `isSameRoomAsPath` guard inside
 * `ChatRail.tsx` still exists (and stays pinned by its own tests): it defends
 * a different case, a normal `CommunityLayout` page whose OWN rail happens to
 * have this same room open at the same time.
 */
export default function BareChatShell({ children }: { children: React.ReactNode }) {
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
      <div
        style={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          maxWidth: 720,
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
