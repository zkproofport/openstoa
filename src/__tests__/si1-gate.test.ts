import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { evaluatePlaintextRows, checkChatRouteGuard, isStrictMode } from '../../scripts/check-no-plaintext-chat';

/**
 * SI-1 plaintext-absence gate — unit tests (P2-01).
 *
 * Tests the pure helpers that the gate script exposes so regressions are
 * caught without a live DB connection, plus the strict-mode predicate that
 * decides whether a skipped DB check fails the build, plus the CI wiring that
 * runs the gate at all.
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

// ---------------------------------------------------------------------------
// isStrictMode — whether a skipped DB check fails the build
// ---------------------------------------------------------------------------

describe('isStrictMode', () => {
  it('is OFF by default so a local run with the DB down still completes', () => {
    expect(isStrictMode([], {})).toBe(false);
    expect(isStrictMode(['--verbose'], {})).toBe(false);
  });

  it('is ON with an explicit --strict, whatever the environment says', () => {
    expect(isStrictMode(['--strict'], {})).toBe(true);
    expect(isStrictMode(['--strict'], { CI: 'false' })).toBe(true);
    expect(isStrictMode(['-x', '--strict', '-y'], {})).toBe(true);
  });

  it('is ON whenever CI is set — a workflow that forgets the flag still gets the real gate', () => {
    expect(isStrictMode([], { CI: 'true' })).toBe(true);
    expect(isStrictMode([], { CI: '1' })).toBe(true);
    expect(isStrictMode([], { CI: 'yes' })).toBe(true);
  });

  it('treats the falsy CI spellings as not-CI, so a local shell exporting CI=false is unaffected', () => {
    expect(isStrictMode([], { CI: '' })).toBe(false);
    expect(isStrictMode([], { CI: 'false' })).toBe(false);
    expect(isStrictMode([], { CI: '0' })).toBe(false);
    expect(isStrictMode([], { CI: undefined })).toBe(false);
  });

  it('ignores a look-alike argument — only the exact flag counts', () => {
    expect(isStrictMode(['--strictly'], {})).toBe(false);
    expect(isStrictMode(['strict'], {})).toBe(false);
    expect(isStrictMode(['--no-strict'], {})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CI wiring — the gate is worthless if nothing runs it
// ---------------------------------------------------------------------------

describe('CI wiring', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8');

  it('the CI workflow actually invokes the gate', () => {
    // The original defect was not a broken script — it was a correct script no
    // job ever ran.
    expect(workflow).toContain('verify:no-plaintext-chat');
  });

  it('invokes it in STRICT mode, so an unreachable DB fails instead of warning', () => {
    // Without this the DB half self-skips and the step goes green having
    // verified nothing — protection in appearance only.
    expect(workflow).toMatch(/verify:no-plaintext-chat\s+--\s+--strict/);
  });

  it('runs it AFTER migrations, so chat_messages exists when the query fires', () => {
    expect(workflow.indexOf('db:migrate:apply')).toBeGreaterThan(-1);
    expect(workflow.indexOf('verify:no-plaintext-chat')).toBeGreaterThan(
      workflow.indexOf('db:migrate:apply'),
    );
  });

  it('the npm script the workflow calls exists and points at this script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    expect(pkg.scripts['verify:no-plaintext-chat']).toContain('check-no-plaintext-chat.ts');
  });
});
