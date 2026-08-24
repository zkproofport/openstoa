/**
 * Nothing client-side survives between tests.
 *
 * The web reads through TanStack Query now, and a query client is created per
 * render by `harness/providers`, so there is no module-level cache left to
 * clear — that was the whole problem with the two bespoke modules this
 * replaced. What DOES persist is `localStorage`, which seeds the session, so a
 * suite that signs in would otherwise seed the next one.
 */
import { beforeEach } from 'vitest';

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // `environment: 'node'` suites have no storage, and need none.
  }
});
