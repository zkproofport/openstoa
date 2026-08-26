/**
 * Whether the web client shows anything about chat at all.
 *
 * ## KEEP THIS `false`. DO NOT FLIP IT.
 *
 * This is not a toggle to try. It stays `false` until a person decides
 * otherwise and says so — not because a test needs it, not because a page
 * looks empty, not because an agent is "restoring" something it found gated.
 * If you are reading this while wondering whether to turn it on, the answer is
 * no. Chat on the web is off, and a change here is a product decision that
 * belongs to the repo owner.
 *
 * ## Why it is off
 *
 * Chat is end-to-end encrypted and the keys live on one device — the mobile
 * app. A browser is the one place that cannot hold that line: signing out
 * cleared the session but left the MLS state, the leaf identity and the
 * decrypted-picture cache behind, so the next person at a shared computer
 * could read the previous person's conversation.
 *
 * `middleware.ts` already refuses every `/api/topics/{id}/chat|archive|keys|
 * mls|tak` call from a browser session with `403 CHAT_MOBILE_ONLY`, and that
 * refusal is correct. What was left behind was the UI. `Header` and
 * `BottomTabBar` had each been closed by hand, but the rail and the standalone
 * pages had not — so the rail still listed rooms, still showed
 * "🔒 Encrypted message · 1d" previews, and opening a room drew
 * **"No messages yet"** over the refusal while the SSE subscription retried the
 * same permanent 403 every three seconds, leaving the panel on "Reconnecting to
 * the chat server…" for as long as it was open. A person was told a message
 * existed, then told there were none, then watched a spinner.
 *
 * Four places, two closed and two open, is how that happened. This constant is
 * the single answer for all of them.
 *
 * ## Nothing was deleted
 *
 * Every call site is gated, not removed — `ChatRail`, `ChatPanel`, the four
 * `/chat` and `/dm` pages and their whole machinery still compile and are still
 * type-checked, which commented-out code would not be. Search `CHAT_ON_WEB` to
 * see all of them.
 *
 * ## When it does come back
 *
 * Not as a room list. A single Chat control that says chat is in the mobile app
 * and points at it — `ChatNotOnWeb.tsx` is that screen already. Flipping this
 * constant is not the whole job: the control has to be added back at the sites
 * that say so.
 */
export const CHAT_ON_WEB = false;
