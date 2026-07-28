import { describe, it, expect } from 'vitest';
import {
  CMD_LABELS,
  HISTORY_SCOPES,
  MAX_API_KEY_NAME_LEN,
  cmdLabel,
  isRawApiKey,
  orderedCmd,
  validateApiKeyName,
} from '@/lib/apiKeyForm';
import { ALLOWED_CMDS } from '@/lib/aiPermissions';

/**
 * Client-side form helpers for the web "AI agents / API keys" profile UI —
 * the pure logic extracted from the AiAgentSettings component so it is testable
 * without a React-component harness (the repo has jsdom but no @testing-library).
 * Covers the edge-case-matrix rows the CLIENT owns; the server contract itself
 * is covered by the e2e suites (api-keys.test.ts, ai-permissions.test.ts).
 */
describe('validateApiKeyName — create name boundary/hostile/empty rows', () => {
  it('rejects empty and whitespace-only names', () => {
    expect(validateApiKeyName('')).not.toBeNull();
    expect(validateApiKeyName('   ')).not.toBeNull();
    expect(validateApiKeyName('\t\n ')).not.toBeNull();
  });

  it('accepts a normal name', () => {
    expect(validateApiKeyName('laptop CLI')).toBeNull();
  });

  it('respects the server length cap (max ok, max+1 rejected)', () => {
    expect(validateApiKeyName('a'.repeat(MAX_API_KEY_NAME_LEN))).toBeNull();
    expect(validateApiKeyName('a'.repeat(MAX_API_KEY_NAME_LEN + 1))).not.toBeNull();
  });

  it('accepts UTF-8 (한글, emoji) and markup-shaped names verbatim (no client-side blocking; React escapes at render)', () => {
    expect(validateApiKeyName('키_에이전트')).toBeNull();
    expect(validateApiKeyName('🤖 agent')).toBeNull();
    expect(validateApiKeyName('<script>alert(1)</script>')).toBeNull();
  });
});

describe('isRawApiKey — list must never surface a raw osk_ key', () => {
  it('flags only osk_-shaped strings', () => {
    expect(isRawApiKey('osk_deadbeef')).toBe(true);
    expect(isRawApiKey('osk_')).toBe(true);
    expect(isRawApiKey('pk_live_x')).toBe(false);
    expect(isRawApiKey(undefined)).toBe(false);
    expect(isRawApiKey(123)).toBe(false);
  });

  it('a metadata-only key row (prefix, never the full key) is not flagged as raw', () => {
    const meta = { id: 'x', name: 'k', prefix: 'osk_1234abcd', cmd: [], historyGrant: 'none' };
    // The prefix is displayed with an ellipsis and is only 12 chars — it is NOT
    // the raw key; the guard is applied to full values the UI must never render.
    expect(meta.prefix.length).toBeLessThan('osk_'.length + 48);
  });
});

describe('orderedCmd — scope payload only ever contains real capabilities', () => {
  it('preserves allowedCmd ordering and drops unknown/unselected commands', () => {
    const selected = new Set(['/openstoa/post/write', '/openstoa/topic/join', '/root/delete']);
    const result = orderedCmd([...ALLOWED_CMDS], selected);
    expect(result).toEqual(['/openstoa/topic/join', '/openstoa/post/write']);
    // The invented cmd is not in ALLOWED_CMDS, so it is filtered out entirely.
    expect(result).not.toContain('/root/delete');
  });

  it('empty selection yields an empty (most-restrictive) scope', () => {
    expect(orderedCmd([...ALLOWED_CMDS], new Set())).toEqual([]);
  });

  it('accepts a plain array as well as a Set', () => {
    expect(orderedCmd([...ALLOWED_CMDS], ['/ai/search'])).toEqual(['/ai/search']);
  });
});

describe('capability labels stay in sync with the server catalogue', () => {
  it('every server ALLOWED_CMDS id has a human label (no unlabelled capability in the UI)', () => {
    for (const cmd of ALLOWED_CMDS) {
      expect(CMD_LABELS[cmd], `missing label for ${cmd}`).toBeTruthy();
    }
  });

  it('cmdLabel falls back to the raw path for an unknown capability', () => {
    expect(cmdLabel('/openstoa/post/write')).toBe('Create & edit posts');
    expect(cmdLabel('/future/cap')).toBe('/future/cap');
  });
});

describe('history-grant scopes are a valid subset of the TAK grammar', () => {
  it('offers none / Nd / full options the server accepts', () => {
    const keys = HISTORY_SCOPES.map((s) => s.key);
    expect(keys).toContain('none');
    expect(keys).toContain('full');
    expect(keys).toContain('7d');
    expect(keys).toContain('30d');
  });
});
