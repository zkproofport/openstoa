import { getBatchUserBadges, type Badge } from './verification-cache';
import { logger } from './logger';

/** Add current, public badges once per response; proof gating never filters identity metadata. */
export async function withPublicIdentityBadges<T>(
  rows: T[],
  identityId: (row: T) => string | null | undefined,
): Promise<(T & { badges: Badge[] })[]> {
  const publicId = (row: T) => {
    const id = identityId(row);
    return id && !id.startsWith('withdrawn:') ? id : null;
  };
  const ids = [...new Set(rows.map(publicId).filter((id): id is string => !!id))];
  let badgeMap = new Map<string, Badge[]>();
  if (ids.length) {
    try {
      badgeMap = await getBatchUserBadges(ids);
    } catch (error) {
      // Badges are optional public metadata. Fail closed: no cached fallback
      // may revive an OFF/expired badge, and a badge outage must not break auth/chat.
      logger.warn('lib/identity-badges', 'Public badges unavailable', { error: String(error) });
    }
  }
  return rows.map(row => ({ ...row, badges: badgeMap.get(publicId(row) ?? '') ?? [] }));
}
