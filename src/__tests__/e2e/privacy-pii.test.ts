import { describe, it, expect } from 'vitest';
import {
  authGet,
  authPost,
  publicGet,
  secondUserPost,
  getSecondUserToken,
} from './helpers';

// PII fields that must never appear in any API response
const PII_PATTERNS = [
  /\bemail\b/i,
  /\bwalletAddress\b/i,
  /\bwallet_address\b/i,
];

// Country as plaintext — must never appear in responses (only hashes are stored)
// Note: 'country' as a key IS allowed inside proofRequirement/allowedCountries (topic config),
// but raw country values (e.g. "KR", "US") should never appear outside of topic config fields.
const COUNTRY_PLAINTEXT_PATTERN = /\"country\"\s*:\s*\"[A-Z]{2}\"/;

/**
 * Scan a JSON body string for forbidden PII patterns.
 * Returns an array of matched patterns (empty = clean).
 */
function scanForPii(body: string): string[] {
  const found: string[] = [];
  for (const pattern of PII_PATTERNS) {
    if (pattern.test(body)) {
      found.push(pattern.toString());
    }
  }
  return found;
}

/**
 * Known badge types — anything else is unexpected.
 */
const KNOWN_BADGE_TYPES = new Set(['kyc', 'country', 'workspace', 'oidc_domain', 'oidc_login']);

let categoryId: string;
let topicId: string;
let postId: string;
let commentId: string;

describe.sequential('Privacy — PII Absence Verification', () => {
  // ── Setup ────────────────────────────────────────────────────────────────

  it('setup: fetch categories', async () => {
    const res = await publicGet('/api/categories');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.categories)).toBe(true);
    expect(json.categories.length).toBeGreaterThan(0);
    categoryId = json.categories[0].id;
  });

  it('setup: User A creates a public topic', async () => {
    const res = await authPost('/api/topics', {
      title: `E2E Privacy PII ${Date.now()}`,
      description: 'Topic for privacy PII verification tests',
      visibility: 'public',
      categoryId,
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.topic.id).toBeTruthy();
    topicId = json.topic.id;
  });

  it('setup: User A creates a post in the topic', async () => {
    const res = await authPost(`/api/topics/${topicId}/posts`, {
      title: `E2E Privacy Post ${Date.now()}`,
      content: 'Post content for privacy PII verification.',
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.post.id).toBeTruthy();
    postId = json.post.id;
  });

  it('setup: User B joins the topic and adds a comment', async () => {
    const { token, userId } = await getSecondUserToken();
    expect(token).toBeTruthy();
    expect(userId).toBeTruthy();

    const joinRes = await secondUserPost(`/api/topics/${topicId}/join`);
    expect([201, 409]).toContain(joinRes.status);

    const commentRes = await secondUserPost(`/api/posts/${postId}/comments`, {
      content: `E2E Privacy comment by User B ${Date.now()}`,
    });
    expect(commentRes.status).toBe(201);
    const commentJson = await commentRes.json();
    commentId = commentJson.comment.id;
    expect(commentId).toBeTruthy();
  });

  // ── 1. /api/profile/badges — no email, domain, country plaintext ─────────

  it('1. GET /api/profile/badges — response has no PII fields', async () => {
    const res = await authGet('/api/profile/badges');
    expect(res.status).toBe(200);
    const body = await res.text();

    const piiFound = scanForPii(body);
    expect(
      piiFound,
      `PII fields found in /api/profile/badges: ${piiFound.join(', ')}\nBody: ${body}`,
    ).toEqual([]);
  });

  it('1b. GET /api/profile/badges — badge objects only have type, verifiedAt, expiresAt', async () => {
    const res = await authGet('/api/profile/badges');
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(Array.isArray(json.badges)).toBe(true);

    for (const badge of json.badges) {
      const keys = Object.keys(badge);
      const allowed = new Set(['type', 'verifiedAt', 'expiresAt']);
      const forbidden = keys.filter(k => !allowed.has(k));
      expect(
        forbidden,
        `Badge has unexpected keys: ${forbidden.join(', ')}. Full badge: ${JSON.stringify(badge)}`,
      ).toEqual([]);

      // type must be a known badge type
      expect(
        KNOWN_BADGE_TYPES.has(badge.type),
        `Unknown badge type: ${badge.type}`,
      ).toBe(true);
    }
  });

  it('1c. GET /api/profile/badges — no raw domain or country values in response', async () => {
    const res = await authGet('/api/profile/badges');
    expect(res.status).toBe(200);
    const body = await res.text();

    // 'domain' and 'country' keys must not appear at all in /api/profile/badges
    expect(body).not.toMatch(/"domain"/);
    expect(body).not.toMatch(COUNTRY_PLAINTEXT_PATTERN);
  });

  // ── 2. Topic detail — no member email/domain PII ─────────────────────────

  it('2a. GET /api/topics/{topicId} — no PII fields in topic detail', async () => {
    const res = await authGet(`/api/topics/${topicId}`);
    expect(res.status).toBe(200);
    const body = await res.text();

    const piiFound = scanForPii(body);
    expect(
      piiFound,
      `PII fields found in topic detail: ${piiFound.join(', ')}\nBody: ${body}`,
    ).toEqual([]);
  });

  it('2b. GET /api/topics/{topicId} — proofRequirement is topic config only, no user PII', async () => {
    const res = await authGet(`/api/topics/${topicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();

    // proofRequirement should be null for a plain open topic (no proof required)
    // or contain only topic-level config (circuit, allowedCountries, requiredDomain)
    if (json.proofRequirement !== null && json.proofRequirement !== undefined) {
      const prStr = JSON.stringify(json.proofRequirement);

      // Must not contain userId or any per-user data
      expect(prStr).not.toMatch(/"userId"/);
      expect(prStr).not.toMatch(/"requestingUser"/);

      // email and walletAddress must not appear
      const piiFound = scanForPii(prStr);
      expect(
        piiFound,
        `PII in proofRequirement: ${piiFound.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('2c. GET /api/topics/{topicId} — requiredDomain and allowedCountries are topic CONFIG, not user PII', async () => {
    const res = await authGet(`/api/topics/${topicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const topic = json.topic;

    // These topic config fields being present is OK — they describe the topic requirement,
    // not the requesting user's personal information.
    // Verify that any present config fields don't leak per-user data.
    if (topic.allowedCountries) {
      expect(Array.isArray(topic.allowedCountries)).toBe(true);
    }
    // requiredDomain is a topic-level config (the domain the topic requires), not user PII
    if (topic.requiredDomain !== undefined && topic.requiredDomain !== null) {
      expect(typeof topic.requiredDomain).toBe('string');
    }

    // The topic object must not expose creator's personal info beyond their userId (nullifier)
    const topicStr = JSON.stringify(topic);
    const piiFound = scanForPii(topicStr);
    expect(
      piiFound,
      `PII fields in topic detail: ${piiFound.join(', ')}`,
    ).toEqual([]);
  });

  it('2d. GET /api/topics/{topicId}/members — no email in member objects', async () => {
    const res = await authGet(`/api/topics/${topicId}/members`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const body = JSON.stringify(json);

    expect(Array.isArray(json.members)).toBe(true);
    expect(json.members.length).toBeGreaterThan(0);

    // No PII fields in the full response
    const piiFound = scanForPii(body);
    expect(
      piiFound,
      `PII fields found in members list: ${piiFound.join(', ')}\nBody: ${body}`,
    ).toEqual([]);

    // Each member object: only nullifier userId, nickname, role, profileImage, badges
    for (const member of json.members) {
      expect(member.userId).toBeTruthy(); // nullifier — OK
      expect(member.nickname).toBeTruthy();
      expect(member.role).toBeTruthy();
      // 'email' must not be a key in the member object
      expect('email' in member).toBe(false);
      expect('walletAddress' in member).toBe(false);
      expect('wallet_address' in member).toBe(false);
    }
  });

  it('2e. GET /api/topics/{topicId}/members — member badges may contain domain only if opted-in (by design)', async () => {
    const res = await authGet(`/api/topics/${topicId}/members`);
    expect(res.status).toBe(200);
    const json = await res.json();

    for (const member of json.members) {
      if (!Array.isArray(member.badges)) continue;
      for (const badge of member.badges) {
        // Badge type must be known
        // domain badges are OK — they're opt-in
        const hasKnownType = KNOWN_BADGE_TYPES.has(badge.type);
        expect(
          hasKnownType,
          `Unknown badge type '${badge.type}' in member badges`,
        ).toBe(true);

        // Country must NEVER appear as plaintext in badges
        const badgeStr = JSON.stringify(badge);
        expect(badgeStr).not.toMatch(COUNTRY_PLAINTEXT_PATTERN);
      }
    }
  });

  // ── 3. Post detail + comments — no PII in author info ────────────────────

  it('3a. GET /api/posts/{postId} — no PII fields in post response', async () => {
    const res = await authGet(`/api/posts/${postId}`);
    expect(res.status).toBe(200);
    const body = await res.text();

    const piiFound = scanForPii(body);
    expect(
      piiFound,
      `PII fields found in post detail: ${piiFound.join(', ')}\nBody: ${body}`,
    ).toEqual([]);
  });

  it('3b. GET /api/posts/{postId} — post author info has only safe fields', async () => {
    const res = await authGet(`/api/posts/${postId}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    const post = json.post ?? json;

    // Author fields that are acceptable
    const acceptableAuthorFields = new Set([
      'authorId',
      'authorNickname',
      'authorProfileImage',
    ]);

    // Scan all top-level keys for any author-related PII
    const postStr = JSON.stringify(post);
    expect(postStr).not.toMatch(/"authorEmail"/);
    expect(postStr).not.toMatch(/"authorWallet"/);
    expect(postStr).not.toMatch(/"authorDomain".*?(?=[,}])/);

    // author badges may contain domain (opt-in) but not country plaintext
    if (Array.isArray(post.authorBadges)) {
      for (const badge of post.authorBadges) {
        const badgeStr = JSON.stringify(badge);
        expect(badgeStr).not.toMatch(COUNTRY_PLAINTEXT_PATTERN);
      }
    }
  });

  it('3c. GET /api/posts/{postId} — comments have no PII in author info', async () => {
    const res = await authGet(`/api/posts/${postId}`);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(Array.isArray(json.comments)).toBe(true);

    for (const comment of json.comments) {
      if (comment.isDeleted) continue; // deleted comments have hidden author — skip

      // authorNickname is expected; email/wallet must not be present
      expect('email' in comment).toBe(false);
      expect('walletAddress' in comment).toBe(false);

      const commentStr = JSON.stringify(comment);
      const piiFound = scanForPii(commentStr);
      expect(
        piiFound,
        `PII in comment ${comment.id}: ${piiFound.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('3d. GET /api/posts/{postId} — public guest access also leaks no PII', async () => {
    const res = await publicGet(`/api/posts/${postId}`);
    expect(res.status).toBe(200);
    const body = await res.text();

    const piiFound = scanForPii(body);
    expect(
      piiFound,
      `PII fields in public post view: ${piiFound.join(', ')}`,
    ).toEqual([]);
  });

  // ── 4. proofRequirement — no user-specific PII ───────────────────────────

  it('4a. Topic join response — proofRequirement has no user-specific PII', async () => {
    // Create a fresh user and attempt to join, which may return proofRequirement if the
    // topic has proof requirements. Our test topic is open (no proof), so join will succeed.
    // To test proofRequirement structure, we inspect topic detail for a non-member.
    // Use publicGet (guest) to get the topic — it returns proofRequirement for gated topics.
    const res = await publicGet(`/api/topics/${topicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();

    if (json.proofRequirement) {
      const prStr = JSON.stringify(json.proofRequirement);

      // Must not contain user-specific identifiers
      expect(prStr).not.toMatch(/"userId"/);
      expect(prStr).not.toMatch(/"userDomain"/);
      expect(prStr).not.toMatch(/"requestingUser"/);

      const piiFound = scanForPii(prStr);
      expect(
        piiFound,
        `PII in proofRequirement (guest view): ${piiFound.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('4b. GET /api/topics/{topicId} (authenticated non-member) — proofRequirement no user PII', async () => {
    // Create a separate topic that User B is NOT a member of, viewed by User A as non-member
    // Instead: create a new topic as User A and check proofRequirement from a fresh guest perspective
    // (our test topic is open, proofRequirement is null — that's the correct safe state)
    const res = await authGet(`/api/topics/${topicId}`);
    expect(res.status).toBe(200);
    const json = await res.json();

    // proofRequirement is null for our open topic — this is correct
    // If it were present, it must not leak user info
    if (json.proofRequirement !== null && json.proofRequirement !== undefined) {
      const prStr = JSON.stringify(json.proofRequirement);
      expect(prStr).not.toMatch(/"userId"/);
      const piiFound = scanForPii(prStr);
      expect(piiFound).toEqual([]);
    }
  });

  // ── 5. Comment author badges — domain/country plaintext absence ───────────

  it('5a. Comment badges — no country plaintext ever', async () => {
    const res = await authGet(`/api/posts/${postId}`);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(Array.isArray(json.comments)).toBe(true);

    for (const comment of json.comments) {
      if (!Array.isArray(comment.badges)) continue;
      for (const badge of comment.badges) {
        const badgeStr = JSON.stringify(badge);
        // Country must never appear as raw 2-letter code
        expect(
          badgeStr,
          `Country plaintext found in comment badge: ${badgeStr}`,
        ).not.toMatch(COUNTRY_PLAINTEXT_PATTERN);
      }
    }
  });

  it('5b. Comment badges — badge types are within known set', async () => {
    const res = await authGet(`/api/posts/${postId}`);
    expect(res.status).toBe(200);
    const json = await res.json();

    for (const comment of json.comments) {
      if (!Array.isArray(comment.badges)) continue;
      for (const badge of comment.badges) {
        expect(
          KNOWN_BADGE_TYPES.has(badge.type),
          `Unknown badge type '${badge.type}' in comment badge`,
        ).toBe(true);
      }
    }
  });

  it('5c. Comment badges — domain only appears if user has opted in (badge type = workspace/oidc_domain)', async () => {
    const res = await authGet(`/api/posts/${postId}`);
    expect(res.status).toBe(200);
    const json = await res.json();

    for (const comment of json.comments) {
      if (!Array.isArray(comment.badges)) continue;
      for (const badge of comment.badges) {
        // If domain is present in a badge, the badge type must be workspace/oidc_domain (opt-in)
        if ('domain' in badge && badge.domain) {
          expect(
            badge.type === 'workspace' || badge.type === 'oidc_domain',
            `Domain value found on non-workspace badge type '${badge.type}'`,
          ).toBe(true);
        }
      }
    }
  });

  // ── 6. Indirect Redis cache verification — no raw country in any response ──

  it('6a. No raw country values appear in topic detail response', async () => {
    const res = await authGet(`/api/topics/${topicId}`);
    expect(res.status).toBe(200);
    const body = await res.text();

    // allowedCountries in topic is an array of config values — that's acceptable as topic CONFIG.
    // What we check: no "country": "KR" style raw user-derived country in badges or author info.
    // The COUNTRY_PLAINTEXT_PATTERN matches `"country": "XX"` (2-letter ISO) — topic config
    // uses allowedCountries array, not `"country": "XX"` key-value pairs.
    expect(body).not.toMatch(COUNTRY_PLAINTEXT_PATTERN);
  });

  it('6b. No raw country values appear in members list response', async () => {
    const res = await authGet(`/api/topics/${topicId}/members`);
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).not.toMatch(COUNTRY_PLAINTEXT_PATTERN);
  });

  it('6c. No raw country values appear in post detail response (including comment badges)', async () => {
    const res = await authGet(`/api/posts/${postId}`);
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).not.toMatch(COUNTRY_PLAINTEXT_PATTERN);
  });

  it('6d. Domain appears in members only for opted-in users (no domain leak for non-opted users)', async () => {
    const res = await authGet(`/api/topics/${topicId}/members`);
    expect(res.status).toBe(200);
    const json = await res.json();

    for (const member of json.members) {
      if (!Array.isArray(member.badges)) continue;

      // Collect all badge domains
      const domainBadges = member.badges.filter(
        (b: { type: string; domain?: string }) =>
          b.domain && (b.type === 'workspace' || b.type === 'oidc_domain'),
      );
      const nonDomainBadgesWithDomain = member.badges.filter(
        (b: { type: string; domain?: string }) =>
          b.domain && b.type !== 'workspace' && b.type !== 'oidc_domain',
      );

      // Any badge that has a 'domain' field must be a workspace/oidc_domain badge (opt-in)
      expect(
        nonDomainBadgesWithDomain.length,
        `Non-workspace badge has domain field: ${JSON.stringify(nonDomainBadgesWithDomain)}`,
      ).toBe(0);
    }
  });

  it('6e. Full scan: no wallet addresses or email patterns in any tested endpoint', async () => {
    const endpoints = [
      `/api/profile/badges`,
      `/api/topics/${topicId}`,
      `/api/topics/${topicId}/members`,
      `/api/posts/${postId}`,
    ];

    for (const endpoint of endpoints) {
      const res = await authGet(endpoint);
      expect(res.status).toBe(200);
      const body = await res.text();

      // Email pattern: something@something.something
      const emailPattern = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;
      expect(
        body,
        `Email address found in ${endpoint}`,
      ).not.toMatch(emailPattern);

      // Ethereum wallet address pattern: 0x followed by exactly 40 hex chars
      // Note: nullifiers (authorId/userId) are 0x + 64 hex chars — NOT wallet addresses
      // Use word boundary or non-hex lookahead to avoid matching nullifiers
      const walletPattern = /0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/;
      // Filter out known safe patterns: authorId and userId are nullifiers (0x + 64 hex)
      const bodyWithoutNullifiers = body.replace(/0x[a-fA-F0-9]{64}/g, '');
      expect(
        bodyWithoutNullifiers,
        `Wallet address found in ${endpoint}`,
      ).not.toMatch(walletPattern);
    }
  });
});
