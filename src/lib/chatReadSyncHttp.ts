/**
 * The browser's transport for the read-cursor sync — its own module, for the
 * same reason `chatDeliveryAckHttp.ts` is: every ChatPanel test mocks
 * `webTransport` with an explicit factory, so an export added there arrives as
 * `undefined` in suites that have nothing to do with it.
 *
 * The rule it feeds — what may be recorded, the debounce, and that a failure is
 * silent — is in the twinned `chatReadSync`.
 */
import { apiFetch } from '@/lib/apiFetch';
import { scheduleChatReadSync, type ReadableRow, type ReadMark } from '@/lib/chatReadSync';

export function httpReadPut(topicId: string, mark: ReadMark): Promise<void> {
  return apiFetch(`/api/topics/${topicId}/chat/read`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mark),
  }).then(() => undefined);
}

/** One line for a call site inside a chat component. */
export function syncChatRead(topicId: string, rows: readonly ReadableRow[]): void {
  scheduleChatReadSync(topicId, rows, { put: httpReadPut });
}
