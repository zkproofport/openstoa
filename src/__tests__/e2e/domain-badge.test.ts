import { describe, it, expect } from 'vitest';
import { authGet, authPost, authDelete, publicGet } from './helpers';

/**
 * Domain Badge Opt-in/Opt-out E2E Tests (Multi-domain)
 *
 * Prerequisites:
 * - User A must be logged in (E2E_AUTH_TOKEN set)
 * - User A should have a valid oidc_domain verification (workspace proof completed)
 *
 * If no workspace verification exists, opt-in will return 400 and those tests
 * are handled gracefully (skipped with a warning).
 */
describe('Domain Badge (Multi-domain)', () => {
  let hasWorkspaceVerification = false;
  let optedInDomain: string | null = null;

  // ── GET status ──────────────────────────────────────────────────────

  it('GET /api/profile/domain-badge — returns multi-domain status', async () => {
    const res = await authGet('/api/profile/domain-badge');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toHaveProperty('domains');
    expect(Array.isArray(data.domains)).toBe(true);
    expect(data).toHaveProperty('availableDomain');

    if (data.availableDomain) {
      hasWorkspaceVerification = true;
      console.log(`[E2E] Workspace verification found, domain: ${data.availableDomain}`);
    } else {
      console.log('[E2E] No workspace verification — opt-in tests will verify 400 response');
    }
  });

  it('GET /api/profile/domain-badge — 401 without auth', async () => {
    const res = await publicGet('/api/profile/domain-badge');
    expect(res.status).toBe(401);
  });

  // ── POST opt-in ─────────────────────────────────────────────────────

  it('POST /api/profile/domain-badge — opt-in adds domain to set', async () => {
    const res = await authPost('/api/profile/domain-badge');

    if (!hasWorkspaceVerification) {
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('workspace verification');
      console.log('[E2E] Opt-in correctly rejected — no workspace verification');
      return;
    }

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.domain).toBeTruthy();
    expect(Array.isArray(data.domains)).toBe(true);
    expect(data.domains).toContain(data.domain);
    optedInDomain = data.domain;
    console.log(`[E2E] Domain badge opted in: ${optedInDomain}, total: ${data.domains.length}`);
  });

  it('POST again — idempotent (same domain not duplicated)', async () => {
    if (!hasWorkspaceVerification) return;

    const res = await authPost('/api/profile/domain-badge');
    expect(res.status).toBe(200);
    const data = await res.json();

    // Redis SET guarantees no duplicates
    const count = data.domains.filter((d: string) => d === optedInDomain).length;
    expect(count).toBe(1);
    console.log('[E2E] Idempotent opt-in confirmed — no duplicate');
  });

  it('GET /api/profile/domain-badge — verify domain in set', async () => {
    if (!hasWorkspaceVerification) return;

    const res = await authGet('/api/profile/domain-badge');
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.domains).toContain(optedInDomain);
  });

  // ── Badge display in posts ──────────────────────────────────────────

  it('Feed posts show domain in workspace badge when opted in', async () => {
    if (!hasWorkspaceVerification) return;

    const res = await authGet('/api/feed?limit=10');
    expect(res.status).toBe(200);
    const data = await res.json();

    const myPosts = data.posts?.filter((p: { badges?: Array<{ type: string; domain?: string }> }) =>
      p.badges?.some((b: { type: string; domain?: string }) => b.type === 'workspace' && b.domain),
    );

    if (myPosts && myPosts.length > 0) {
      const badge = myPosts[0].badges.find((b: { type: string }) => b.type === 'workspace');
      expect(badge.domain).toBe(optedInDomain);
      console.log(`[E2E] Feed post badge shows domain: ${badge.domain}`);
    } else {
      console.log('[E2E] No posts by current user in feed — skipping badge content check');
    }
  });

  // ── DELETE specific domain ──────────────────────────────────────────

  it('DELETE /api/profile/domain-badge — remove specific domain', async () => {
    if (!hasWorkspaceVerification || !optedInDomain) return;

    const res = await authDelete('/api/profile/domain-badge', { domain: optedInDomain });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.domains)).toBe(true);
    expect(data.domains).not.toContain(optedInDomain);
    console.log(`[E2E] Removed domain: ${optedInDomain}, remaining: ${data.domains.length}`);
  });

  it('GET /api/profile/domain-badge — verify domain removed', async () => {
    const res = await authGet('/api/profile/domain-badge');
    expect(res.status).toBe(200);

    const data = await res.json();
    if (hasWorkspaceVerification && optedInDomain) {
      expect(data.domains).not.toContain(optedInDomain);
    }
    // availableDomain should still be present if verification exists
    if (hasWorkspaceVerification) {
      expect(data.availableDomain).toBeTruthy();
    }
  });

  it('Feed posts show generic badge after opt-out', async () => {
    if (!hasWorkspaceVerification) return;

    const res = await authGet('/api/feed?limit=10');
    expect(res.status).toBe(200);
    const data = await res.json();

    const workspaceBadges = data.posts?.flatMap((p: { badges?: Array<{ type: string; domain?: string }> }) =>
      (p.badges ?? []).filter((b: { type: string }) => b.type === 'workspace'),
    ) ?? [];

    for (const badge of workspaceBadges) {
      if (badge.domain === optedInDomain) {
        throw new Error(`Domain ${optedInDomain} still visible in badge after opt-out`);
      }
    }
    console.log('[E2E] Workspace badges no longer show domain after opt-out');
  });

  // ── DELETE all domains ──────────────────────────────────────────────

  it('DELETE /api/profile/domain-badge — remove all (no body)', async () => {
    // Re-add first, then remove all
    if (hasWorkspaceVerification) {
      await authPost('/api/profile/domain-badge');
    }

    const res = await authDelete('/api/profile/domain-badge');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.domains).toEqual([]);
    console.log('[E2E] All domain badges removed');
  });

  // ── Privacy checks ──────────────────────────────────────────────────

  it('Unauthenticated cannot access domain badge endpoint', async () => {
    const postRes = await fetch(`${process.env.E2E_BASE_URL || 'https://stg-community.zkproofport.app'}/api/profile/domain-badge`, {
      method: 'POST',
    });
    expect(postRes.status).toBe(401);

    const delRes = await fetch(`${process.env.E2E_BASE_URL || 'https://stg-community.zkproofport.app'}/api/profile/domain-badge`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(401);
  });

  // ── Members list badge check ────────────────────────────────────────

  it('Member list includes badges', async () => {
    const topicsRes = await authGet('/api/topics?limit=1');
    if (topicsRes.status !== 200) return;
    const topicsData = await topicsRes.json();
    if (!topicsData.topics?.length) return;

    const topicId = topicsData.topics[0].id;
    const membersRes = await authGet(`/api/topics/${topicId}/members`);
    expect(membersRes.status).toBe(200);

    const membersData = await membersRes.json();
    expect(membersData.members).toBeDefined();

    for (const member of membersData.members) {
      expect(member).toHaveProperty('badges');
      expect(Array.isArray(member.badges)).toBe(true);
    }
    console.log(`[E2E] Members list has badges (${membersData.members.length} members checked)`);
  });

  // ── Domain extraction validation ────────────────────────────────────

  it('Extracted domain is a valid domain format', async () => {
    if (!hasWorkspaceVerification) return;

    const res = await authGet('/api/profile/domain-badge');
    const data = await res.json();
    const domain = data.availableDomain;
    if (!domain) return;

    // Domain must contain at least one dot and no spaces
    expect(domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/i);
    // Domain must not be truncated (previous bug: first 2 chars missing)
    expect(domain.length).toBeGreaterThanOrEqual(3);
    console.log(`[E2E] Domain format valid: ${domain}`);
  });

  it('Opted-in domain matches availableDomain', async () => {
    if (!hasWorkspaceVerification) return;

    // Opt in
    const optInRes = await authPost('/api/profile/domain-badge');
    if (optInRes.status !== 200) return;
    const optInData = await optInRes.json();

    // Get status
    const statusRes = await authGet('/api/profile/domain-badge');
    const statusData = await statusRes.json();

    // The opted-in domain should match availableDomain
    expect(statusData.domains).toContain(optInData.domain);
    expect(optInData.domain).toBe(statusData.availableDomain);
    console.log(`[E2E] Domain consistency check: opted=${optInData.domain}, available=${statusData.availableDomain}`);

    // Cleanup: opt out
    await authDelete('/api/profile/domain-badge');
  });

  it('Domain badge appears in post badges with correct domain', async () => {
    if (!hasWorkspaceVerification || !optedInDomain) return;

    // Re-opt-in for this test
    await authPost('/api/profile/domain-badge');

    const res = await authGet('/api/feed?limit=20');
    expect(res.status).toBe(200);
    const data = await res.json();

    // Find workspace badges with domain
    const domainBadges = data.posts?.flatMap((p: { badges?: Array<{ type: string; domain?: string }> }) =>
      (p.badges ?? []).filter((b: { type: string; domain?: string }) => b.type === 'workspace' && b.domain),
    ) ?? [];

    if (domainBadges.length > 0) {
      for (const badge of domainBadges) {
        // Every domain badge should be a valid domain format
        expect(badge.domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/i);
      }
      console.log(`[E2E] Found ${domainBadges.length} domain badges in feed, all valid format`);
    } else {
      console.log('[E2E] No domain badges in feed posts — user may not have posts');
    }

    // Cleanup
    await authDelete('/api/profile/domain-badge');
  });
});
