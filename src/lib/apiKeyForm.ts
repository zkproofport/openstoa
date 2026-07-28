/**
 * Client-side form helpers for the web "AI agents / API keys" profile UI.
 *
 * Pure + dependency-free so it is safe to import into a client component
 * (never pulls the `@/lib/db` chain the way `@/lib/apiKeys` /
 * `@/lib/aiPermissions` do) and is unit-testable in isolation. Values mirror
 * the server contracts (`validateCreateApiKeyInput` in `@/lib/apiKeys`,
 * `ALLOWED_CMDS` / `isValidTakScope`) — the server is authoritative, this layer
 * only pre-validates for UX and reuses the mobile app's human labels for parity
 * (see packages/mobile/src/screens/profile/AiPermissionsScreen.tsx).
 */

// Mirror of server MAX_NAME_LEN in `@/lib/apiKeys` — keep in sync.
export const MAX_API_KEY_NAME_LEN = 100;

/**
 * Pre-validate an API-key name the same way the server does: non-empty after
 * trimming, and at most MAX_API_KEY_NAME_LEN chars. Unicode (한글, emoji) and
 * markup-shaped strings are ACCEPTED here (React escapes them at render time and
 * they are sent verbatim); only empty/whitespace and over-length are rejected.
 * Returns an error string, or null when the name is acceptable.
 */
export function validateApiKeyName(name: string): string | null {
  if (name.trim().length === 0) return 'Name is required';
  if (name.length > MAX_API_KEY_NAME_LEN) return `Name must be ${MAX_API_KEY_NAME_LEN} characters or fewer`;
  return null;
}

/** True if a string is shaped like a raw API key (must never appear in a list response). */
export function isRawApiKey(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('osk_');
}

/**
 * Build the `cmd` payload from a selected set, preserving the server's
 * `allowedCmd` ordering (matches the mobile app) and dropping anything not in
 * the catalogue — so only real capabilities are ever sent.
 */
export function orderedCmd(allowedCmd: string[], selected: Set<string> | string[]): string[] {
  const set = selected instanceof Set ? selected : new Set(selected);
  return allowedCmd.filter((c) => set.has(c));
}

/**
 * Human labels for capability paths, mirrored from the mobile AI permissions
 * screen. Any cmd not listed falls back to its raw path so a newly-added server
 * capability still renders.
 */
export const CMD_LABELS: Record<string, string> = {
  '/openstoa/topic/join': 'Join topics',
  '/openstoa/topic/leave': 'Leave / remove members',
  '/openstoa/post/read': 'Read posts',
  '/openstoa/post/write': 'Create & edit posts',
  '/openstoa/post/delete': 'Delete posts',
  '/openstoa/comment/read': 'Read comments',
  '/openstoa/comment/write': 'Write comments',
  '/openstoa/chat/read': 'Read chat & history',
  '/openstoa/chat/send': 'Send chat messages',
  '/openstoa/profile/read': 'Read profile',
  '/openstoa/profile/edit': 'Edit profile',
  '/ai/summarize': 'Summarize',
  '/ai/search': 'Search',
};

export function cmdLabel(cmd: string): string {
  return CMD_LABELS[cmd] ?? cmd;
}

/**
 * Chat-archive (history grant) scope choices — a subset of the server's
 * `isValidTakScope` grammar (none | Nd | since_epoch:N | full), mirrored from
 * the mobile app.
 */
export const HISTORY_SCOPES: { key: string; label: string }[] = [
  { key: 'none', label: 'No history' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'full', label: 'Full history' },
];
