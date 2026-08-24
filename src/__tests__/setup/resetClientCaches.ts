/**
 * Every test starts without a session this page has already verified.
 *
 * `sessionCache` memoises the server's answer for the LIFETIME OF THE PAGE,
 * which is exactly right in a browser — the value changes only at sign-in and
 * sign-out, and both write through it — and exactly wrong across a test file,
 * where one module instance spans dozens of "page loads". Without this, the
 * first test to resolve a signed-OUT session served that answer to every test
 * after it, and twenty-nine of them rendered "Sign in to participate".
 *
 * A global hook rather than a line in each file: a page-lifetime cache is a
 * property of the module, so the reset belongs where the boundary between tests
 * is defined, not in whichever suites happen to notice.
 */
import { beforeEach } from 'vitest';
import { resetSessionMemoForTests } from '@/lib/sessionCache';
import { resetRequestCache } from '@/lib/requestCache';

beforeEach(() => {
  resetSessionMemoForTests();
  /*
   * Same reasoning, same boundary. `requestCache` shares an in-flight GET for a
   * two-second window — sized for one mount — and a test file mounts dozens of
   * "pages" in far less than that, so one suite's response would be handed to
   * the next. Twenty tests failed exactly that way before this line existed.
   */
  resetRequestCache();
  try {
    localStorage.clear();
  } catch {
    // `environment: 'node'` suites have no storage, and need none.
  }
});
