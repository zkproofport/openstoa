import { describe, it, expect } from 'vitest';
import path from 'path';
import { evaluatePlaintextRows, checkChatRouteGuard } from '../../scripts/check-no-plaintext-chat';

/**
 * SI-1 plaintext-absence gate — unit tests (P2-01).
 *
 * Tests the pure helpers that the gate script exposes so regressions are
 * caught without a live DB connection.
 */

// ---------------------------------------------------------------------------
// evaluatePlaintextRows — DB result evaluator
// ---------------------------------------------------------------------------

describe('evaluatePlaintextRows', () => {
  it('returns ok when zero offending rows', () => {
    const result = evaluatePlaintextRows({ n: 0 });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns not-ok when one offending row exists', () => {
    const result = evaluatePlaintextRows({ n: 1 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('SI-1');
    expect(result.reason).toContain('1');
  });

  it('returns not-ok for any positive count and includes the count in the reason', () => {
    const result = evaluatePlaintextRows({ n: 42 });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('42');
  });

  // Boundary: 0 vs 1 is the exact pass/fail edge.
  it('flips exactly at the 0 -> 1 boundary', () => {
    expect(evaluatePlaintextRows({ n: 0 }).ok).toBe(true);
    expect(evaluatePlaintextRows({ n: 1 }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkChatRouteGuard — source-file guard check
// ---------------------------------------------------------------------------

describe('checkChatRouteGuard', () => {
  it('passes for the real chat route file (guard must be present)', () => {
    const routePath = path.resolve(__dirname, '../../src/app/api/topics/[topicId]/chat/route.ts');
    const result = checkChatRouteGuard(routePath);
    expect(result.ok).toBe(true);
    expect(result.filePath).toBe(routePath);
    expect(result.reason).toBeUndefined();
  });

  it('fails when the route file does not exist', () => {
    const result = checkChatRouteGuard('/nonexistent/path/route.ts');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not found');
  });

  it('fails when the guard string is absent from a file', () => {
    // Write a temp file without the guard and point the checker at it.
    const os = require('os');
    const fs = require('fs');
    const tmp = path.join(os.tmpdir(), 'si1-test-route.ts');
    fs.writeFileSync(tmp, '// no guard here\nexport async function POST() {}');
    const result = checkChatRouteGuard(tmp);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('MISSING');
    fs.unlinkSync(tmp);
  });
});
