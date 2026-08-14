/**
 * The browser's transport for the delivery ack — deliberately its own module.
 *
 * It started life inside `webTransport.ts`, which is the natural home for
 * browser wiring and was the wrong one: every ChatPanel test mocks that module
 * with an explicit factory, so adding an export to it silently handed those
 * suites an `undefined` where the panel expected a function. Eight tests went
 * red for a reason that had nothing to do with what they were testing.
 *
 * Living here means a component can depend on it without every existing mock
 * having to learn about it. The rule it feeds — which instant may be claimed,
 * and that a failure must be silent — is in the twinned `chatDeliveryAck`.
 */
export function httpAckPost(topicId: string, deviceId: string, through: string): Promise<void> {
  return fetch(`/api/topics/${topicId}/chat/delivered`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, through }),
  }).then(() => undefined);
}
