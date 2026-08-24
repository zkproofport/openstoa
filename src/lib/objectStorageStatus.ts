/**
 * The one place that says how `/api/upload` reports "storage was never
 * configured" — the STATUS and the CLASS, defined once.
 *
 * It exists because the previous version of this contract lived in two files
 * that were kept carefully in sync with each other while a third quietly made
 * it unobservable. `src/lib/r2.ts` threw a sentence naming five environment
 * variables; `src/__tests__/e2e/helpers.ts` matched that literal to decide the
 * suite should SKIP rather than fail; and a comment in the first file warned
 * that rewording it would turn a blocked case into a silent pass. All true, and
 * already moot: every `/api/upload` failure goes through `unhandledRouteError`,
 * whose body is deliberately generic, so the literal never reached the test.
 * The skip could not fire, and a deployment with no storage reported as ten
 * hard failures across eight files, each pointing at application behaviour.
 *
 * Two rules follow, and they are why these are constants rather than literals
 * at three call sites:
 *
 *  1. The MESSAGE names a class and nothing else. No variable names, no values,
 *     no stack — those belong in the log, which is what `unhandledRouteError`
 *     is right to protect. Anything more specific here is a config disclosure.
 *  2. The STATUS is the contract. 503 says "this server was never able to serve
 *     that", which is the truth; 500 claimed a fault and sent whoever was
 *     debugging to hunt for one.
 */
export const OBJECT_STORAGE_UNCONFIGURED_STATUS = 503;
export const OBJECT_STORAGE_UNCONFIGURED_MESSAGE = 'Object storage is not configured';
