/**
 * Peer profile card logic — `canDm` (DM-button visibility) and `initialFor`
 * (avatar-fallback initial).
 *
 * Edge-case matrix rows covered here:
 *   authz        — self-exclusion, missing/empty viewer id, AI target
 *   boundary     — empty / whitespace-only nickname
 *   UTF-8        — Korean and emoji nicknames (surrogate-pair safety)
 */
import { describe, it, expect } from 'vitest';
import { canDm, initialFor } from '../lib/peerProfile';

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
