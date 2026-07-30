/**
 * Peer profile card logic — `canDm` (DM-button visibility), `initialFor`
 * (avatar-fallback initial), and `dmUnavailableReason` (the three-state
 * card's self / AI-not-DM-able decomposition of `canDm`'s "no button").
 *
 * Edge-case matrix rows covered here:
 *   authz        — self-exclusion, missing/empty viewer id, AI target
 *   boundary     — empty / whitespace-only nickname
 *   UTF-8        — Korean and emoji nicknames (surrogate-pair safety)
 *   contract     — dmUnavailableReason agrees with canDm: non-null reason
 *                  iff canDm would hide the button for a RESOLVED pair;
 *                  an unresolved pair answers null (no premature note)
 */
import { describe, it, expect } from 'vitest';
import { canDm, dmUnavailableReason, initialFor } from '../lib/peerProfile';

describe('canDm', () => {
  it('hides the button for self', () => {
    expect(canDm('user-1', { userId: 'user-1' })).toBe(false);
  });

  it('shows the button for a different real user', () => {
    expect(canDm('user-1', { userId: 'user-2' })).toBe(true);
  });

  it('hides the button when the viewer id is missing (null, undefined, empty)', () => {
    expect(canDm(null, { userId: 'user-2' })).toBe(false);
    expect(canDm(undefined, { userId: 'user-2' })).toBe(false);
    expect(canDm('', { userId: 'user-2' })).toBe(false);
  });

  it('hides the button when the target id is empty', () => {
    expect(canDm('user-1', { userId: '' })).toBe(false);
  });

  it('hides the button for an AI member even when ids differ', () => {
    expect(canDm('user-1', { userId: 'ai-bot', isAI: true })).toBe(false);
  });

  it('shows the button for a non-AI target explicitly flagged isAI: false', () => {
    expect(canDm('user-1', { userId: 'user-2', isAI: false })).toBe(true);
  });
});

describe('dmUnavailableReason', () => {
  it('SELF: returns "self" when viewer and target are the same resolved id', () => {
    expect(dmUnavailableReason('user-1', { userId: 'user-1' })).toBe('self');
  });

  it('AI: returns "ai" for a different, resolved, AI-flagged target', () => {
    expect(dmUnavailableReason('user-1', { userId: 'ai-bot', isAI: true })).toBe('ai');
  });

  it('ELIGIBLE: returns null for a different, resolved, non-AI target', () => {
    expect(dmUnavailableReason('user-1', { userId: 'user-2' })).toBeNull();
    expect(dmUnavailableReason('user-1', { userId: 'user-2', isAI: false })).toBeNull();
  });

  it('UNRESOLVED: returns null (no premature note) when the viewer id is missing', () => {
    expect(dmUnavailableReason(null, { userId: 'user-2' })).toBeNull();
    expect(dmUnavailableReason(undefined, { userId: 'user-2' })).toBeNull();
    expect(dmUnavailableReason('', { userId: 'user-2' })).toBeNull();
  });

  it('UNRESOLVED: returns null when the target id is empty', () => {
    expect(dmUnavailableReason('user-1', { userId: '' })).toBeNull();
  });

  it('CONTRACT: agrees with canDm on every resolved pair — non-null reason iff canDm is false', () => {
    const pairs: Array<[string, { userId: string; isAI?: boolean }]> = [
      ['user-1', { userId: 'user-1' }],
      ['user-1', { userId: 'user-2' }],
      ['user-1', { userId: 'ai-bot', isAI: true }],
      ['user-1', { userId: 'user-2', isAI: false }],
    ];
    for (const [viewer, target] of pairs) {
      expect(dmUnavailableReason(viewer, target) !== null).toBe(!canDm(viewer, target));
    }
  });
});

describe('initialFor', () => {
  it('uppercases a plain ASCII first letter', () => {
    expect(initialFor('kim')).toBe('K');
  });

  it('falls back to "?" for an empty string', () => {
    expect(initialFor('')).toBe('?');
  });

  it('falls back to "?" for a whitespace-only nickname', () => {
    expect(initialFor('   ')).toBe('?');
  });

  it('takes the first Korean syllable without corruption', () => {
    expect(initialFor('김철수')).toBe('김');
  });

  it('keeps a leading emoji intact instead of splitting its surrogate pair', () => {
    // '😀' is a surrogate pair (2 UTF-16 code units, 1 code point).
    // charAt(0)/slice(0,1) would return a lone unpaired surrogate here.
    const result = initialFor('😀builder');
    expect(Array.from(result).length).toBe(1);
    expect(result).toBe('😀');
  });

  it('trims leading whitespace before taking the initial', () => {
    expect(initialFor('  Ada')).toBe('A');
  });
});
