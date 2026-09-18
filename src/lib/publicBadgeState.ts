/** Public identity data returned by the enclosing API; never fetched per row. */
export interface PublicBadge {
  type: string;
  label: string;
  domain?: string | null;
  country?: string | null;
}

// This is ONLY an in-flight session-read guard, never a rendered badge source.
// A read started before a successful OFF must not overwrite session cache/storage
// with the previous ON value. Fresh identity props always remain authoritative.
let revision = 0;
let mutation: { userId: string; badges: PublicBadge[] } | undefined;
export const publicBadgeRevision = () => revision;
export const publicBadgeSnapshot = (userId: string) => mutation?.userId === userId ? mutation.badges : undefined;

export function recordPublicBadgeMutation(userId: string, badges: PublicBadge[]) {
  revision++;
  mutation = { userId, badges };
}

/** Clear mutation state on an authoritative session read or account reset. */
export function resetPublicBadgeMutation() {
  revision++;
  mutation = undefined;
}
