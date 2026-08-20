/**
 * Turning a thrown request error into something a person can act on.
 *
 * This exists because the mini-app had the opposite: `openstoaClient` flattened
 * the status and the server's own sentence into one message string, screens
 * passed that string to `host.showError`, and the host's `showError` was a
 * `console.warn`. Three layers each did something reasonable-looking and the
 * result was that a refusal the server had explained in plain words — "That
 * name is reserved." — reached the person as a button that appeared not to
 * work. The host end is fixed separately; this is the client end.
 *
 * The point of the split below is that the remedy differs. A request that never
 * left the device is worth retrying and changed nothing. A 4xx means the server
 * understood and declined, and its sentence is the instruction. A 5xx means
 * neither, and inventing an explanation for it would be worse than admitting
 * there isn't one.
 */
import type { HostApi } from '@openstoa/miniapp-bridge';
import { OpenStoaApiError, OpenStoaNetworkError } from './openstoaClient';

/** The host error code for "the request never reached the server". */
export const NETWORK_ERROR_CODE = 'E9998';

export interface Failure {
  /** Which host error modal to open. */
  code: string;
  /** The modal's technical line. */
  detail: string;
  /**
   * Text to show next to the input that caused this, or null.
   *
   * Only set when the server explained itself: a refused value is corrected in
   * the field, so that is where the reason belongs — in addition to the modal,
   * not instead of it. An outage is not corrected in a field.
   */
  inline: string | null;
}

/**
 * Sort a thrown error into what the person should be told.
 *
 * `fallbackCode` names the action that failed, so the modal's title can say
 * which one. A network failure overrides it: nothing was attempted, so naming
 * the action would misdescribe what happened.
 */
export function describeFailure(e: unknown, fallbackCode: string): Failure {
  if (e instanceof OpenStoaNetworkError) {
    return { code: NETWORK_ERROR_CODE, detail: e.message, inline: null };
  }
  if (e instanceof OpenStoaApiError) {
    const explained = e.status < 500 ? e.serverMessage : null;
    return {
      code: fallbackCode,
      detail: explained ?? e.message,
      inline: explained,
    };
  }
  return { code: fallbackCode, detail: e instanceof Error ? e.message : String(e), inline: null };
}

/**
 * Show a failed write in the host's error modal, and hand back the parts a
 * screen may want to place itself (the inline reason).
 */
export function reportFailure(host: HostApi, e: unknown, fallbackCode: string): Failure {
  const failure = describeFailure(e, fallbackCode);
  host.showError(failure.code, { detail: failure.detail });
  return failure;
}
