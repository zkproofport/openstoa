import { describe, it, expect } from 'vitest';
import { evaluateBurnGuard, BURN_CONFIRM_EXPECTED } from '../../scripts/burn-plaintext-chat';

/**
 * Dev plan M1: the chat burn is destructive + irreversible, so the guard is
 * the only defense. It must proceed iff at least one of three conditions holds
 * (non-prod / operator token / already-empty) and REFUSE otherwise.
 */
describe('evaluateBurnGuard', () => {
  it('proceeds in development regardless of row count', () => {
    const g = evaluateBurnGuard({ nodeEnv: 'development', rowCount: 999, confirmToken: undefined });
    expect(g.canBurn).toBe(true);
    expect(g.reason).toContain('non-production');
  });

  it('proceeds in staging (any non-production env)', () => {
    expect(evaluateBurnGuard({ nodeEnv: 'staging', rowCount: 50, confirmToken: undefined }).canBurn).toBe(true);
  });

  it('proceeds when NODE_ENV is undefined (treated as non-production)', () => {
    expect(evaluateBurnGuard({ nodeEnv: undefined, rowCount: 5, confirmToken: undefined }).canBurn).toBe(true);
  });

  it('REFUSES in production with a non-empty table and no token', () => {
    const g = evaluateBurnGuard({ nodeEnv: 'production', rowCount: 1, confirmToken: undefined });
    expect(g.canBurn).toBe(false);
    expect(g.reason).toContain('production');
  });

  it('proceeds in production when the operator token matches', () => {
    const g = evaluateBurnGuard({ nodeEnv: 'production', rowCount: 100, confirmToken: BURN_CONFIRM_EXPECTED });
    expect(g.canBurn).toBe(true);
    expect(g.hasToken).toBe(true);
    expect(g.reason).toContain('operator');
  });

  it('REFUSES in production when the operator token is wrong', () => {
    expect(
      evaluateBurnGuard({ nodeEnv: 'production', rowCount: 100, confirmToken: 'wrong-token' }).canBurn,
    ).toBe(false);
  });

  it('proceeds in production when the table is already empty (no-op burn)', () => {
    const g = evaluateBurnGuard({ nodeEnv: 'production', rowCount: 0, confirmToken: undefined });
    expect(g.canBurn).toBe(true);
    expect(g.isEmpty).toBe(true);
    expect(g.reason).toContain('empty');
  });

  // Boundary: rowCount 0 vs 1 is the exact prod refuse/allow edge.
  it('flips at the 0->1 row boundary in production without a token', () => {
    expect(evaluateBurnGuard({ nodeEnv: 'production', rowCount: 0, confirmToken: undefined }).canBurn).toBe(true);
    expect(evaluateBurnGuard({ nodeEnv: 'production', rowCount: 1, confirmToken: undefined }).canBurn).toBe(false);
  });
});
