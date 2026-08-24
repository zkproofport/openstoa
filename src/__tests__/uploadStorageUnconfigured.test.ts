/**
 * A deployment with no object storage must SAY so, and the E2E suite must be
 * able to hear it.
 *
 * This closes a guard that existed, read correctly, and could never fire.
 * `src/lib/r2.ts` threw a sentence naming five environment variables;
 * `src/__tests__/e2e/helpers.ts` matched that literal to decide the suite should
 * SKIP rather than fail; and a comment in the first file warned that rewording
 * it would turn a blocked case into a silent pass. Every word of that was true
 * and all of it was already moot — `/api/upload` sends every failure through
 * `unhandledRouteError`, whose body is deliberately generic, so the literal
 * never arrived. The BLOCK was unreachable and an unconfigured environment could
 * only ever report as ten unexplained failures across eight files.
 *
 * Note what this does and does not buy, because the word matters and I got it
 * wrong once already: `requireObjectStorage` THROWS `ObjectStorageUnavailable`
 * — it never skips. Those cases fail either way. What changes is that they now
 * fail saying "this deployment has no object storage", with the restore steps,
 * instead of looking like application bugs. Ten mystery failures become ten
 * labelled ones; nobody gets a green suite out of it.
 *
 * The lesson that shaped this file: BOTH HALVES WERE INDIVIDUALLY CORRECT. A
 * test of the route alone, or of the helper alone, would have passed throughout.
 * Only the JOIN was broken. So the contract case below runs the REAL route and
 * feeds its ACTUAL response into the REAL helper — if the two ever stop
 * agreeing, this goes red, which is the one thing the old arrangement could not
 * do for itself.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract      → the real route answers 503 + the class message, and the real
 *                   helper recognises that exact response (the join)
 *   integrity     → the body names a CLASS and leaks no configuration: no
 *                   variable name, no value, no stack, no errorId
 *   contract      → the predicate matches what `getR2Config` actually throws,
 *                   so the route's narrow catch cannot miss it
 *   authorization → N/A: this is reached after the session check; an
 *                   unauthenticated caller never gets here (401 first)
 *   hostile       → the helper refuses every OTHER failure — 500, 502, a 503
 *                   from something else, an empty body, malformed JSON — because
 *                   a guard that excuses too much is worse than no guard
 *   boundary      → 500 (the old status) is explicitly NOT excused, which is the
 *                   regression that would silently restore the dead branch
 *   empty / null  → an empty and a non-JSON body are refused, not crashed on
 *   UTF-8 / large / race → N/A: one status code and one fixed sentence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OBJECT_STORAGE_UNCONFIGURED_MESSAGE,
  OBJECT_STORAGE_UNCONFIGURED_STATUS,
} from '@/lib/objectStorageStatus';
import { isMissingR2ConfigError } from '@/lib/r2';
import { isMissingR2Credentials } from './e2e/helpers';

// The route checks the session before it ever reaches storage; who the caller
// is has no bearing on this case, so it is stubbed rather than constructed.
vi.mock('@/lib/session', () => ({
  getSession: async () => ({ userId: '0xtest', nickname: 'tester' }),
}));

/** The R2 settings a configured deployment has, and this test removes. */
const R2_VARS = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET_NAME',
  'R2_PUBLIC_URL',
  'R2_ENDPOINT',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of R2_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of R2_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A 1x1 PNG — the smallest thing the route will accept as an image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function postUpload(): Promise<Response> {
  const { POST } = await import('@/app/api/upload/route');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'probe.png');
  form.append('purpose', 'post');
  // No `topicId`, deliberately: naming one would send the route through a
  // membership lookup, and the database is not this test's subject.
  const request = new Request('http://localhost/api/upload', { method: 'POST', body: form });
  return POST(request as never) as unknown as Promise<Response>;
}

describe('an unconfigured deployment reports storage as absent', () => {
  it('CONTRACT: the real route answers 503, and the real E2E helper recognises it', async () => {
    /*
     * THE JOIN, which is the only thing that was ever broken. Both halves are
     * the shipped ones: the route imported from its own module, and
     * `isMissingR2Credentials` imported from the e2e helpers the suite runs.
     * Nothing is re-implemented here, so the two cannot pass this test while
     * disagreeing with each other.
     */
    const res = await postUpload();
    const body = await res.text();

    expect(res.status).toBe(OBJECT_STORAGE_UNCONFIGURED_STATUS);
    expect(
      isMissingR2Credentials(res.status, body),
      'the suite would report this as an application bug instead of a missing dependency',
    ).toBe(true);
  });

  it('INTEGRITY: the body names a class and discloses no configuration', async () => {
    // The five variable names belong in the log. A response that names which
    // variable is missing tells an anonymous caller how the server is wired.
    const res = await postUpload();
    const body = await res.text();

    expect(JSON.parse(body)).toEqual({ error: OBJECT_STORAGE_UNCONFIGURED_MESSAGE });
    for (const leak of R2_VARS) expect(body, `body leaks ${leak}`).not.toContain(leak);
    for (const leak of ['environment variables are required', 'stack', 'errorId', 'at ']) {
      expect(body, `body leaks "${leak}"`).not.toContain(leak);
    }
  });

  it('CONTRACT: the predicate matches what getR2Config actually throws', async () => {
    // The route's narrow catch turns on this. If `r2.ts` ever throws something
    // else for a missing configuration, the catch silently stops firing and the
    // 503 above quietly becomes a 500 again.
    const { uploadToR2 } = await import('@/lib/r2');
    const thrown = await uploadToR2(PNG, 'image/png', '0xtest', 'post', 'probe.png', null).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown, 'an unconfigured upload should throw').toBeTruthy();
    expect(isMissingR2ConfigError(thrown)).toBe(true);
  });

  it.each([
    ['the OLD status, which is the regression that would re-kill the branch', 500, `{"error":"${OBJECT_STORAGE_UNCONFIGURED_MESSAGE}"}`],
    ['a generic 500', 500, '{"error":"Internal server error","errorId":"abc"}'],
    ['a 502 from a proxy', 502, 'Bad Gateway'],
    ['a 503 that means something else', 503, '{"error":"Rate limit exceeded"}'],
    ['a 503 with an empty body', 503, ''],
    ['a 503 with a non-JSON body', 503, '<html>503</html>'],
    ['a success', 200, '{"publicUrl":"/api/media/x.png"}'],
  ])('HOSTILE: %s is NOT excused', (_label, status, body) => {
    // The guard's value is what it REFUSES. One that excuses a real upload
    // fault turns a broken deployment into a green run, which is strictly worse
    // than the dead branch this replaced.
    expect(isMissingR2Credentials(status, body)).toBe(false);
  });
});
