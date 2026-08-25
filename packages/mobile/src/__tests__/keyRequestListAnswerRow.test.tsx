/**
 * When a grant is answered, the ANSWER is the row.
 *
 * THE DEFECT, seen on a real phone (SM-A235N). A member tapped "Unlock for
 * them" in a room where their device did not hold the missing stretch. The
 * honest answer — "This device does not have that stretch either." — was drawn
 * BESIDE the description that had explained why the button was there, and the
 * two texts fought over one line: the description collapsed to "A member c…"
 * while the answer kept its full width. Neither half could be read, and the
 * member was left looking at three characters and a sentence with no subject.
 *
 * Nothing was broken underneath — the grant correctly reported it could not
 * help, and the request was correctly left unanswered. Only the row was
 * unreadable, which on a screen a member glances at is the whole feature.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract  → a waiting row shows the description AND the button
 *   contract  → once answered, the description is gone and the answer shows
 *   boundary  → both answers (granted, cannot-help) behave the same way
 *   integrity → the row is never left showing two competing texts
 *   race      → a failed grant returns a retry, not a settled answer
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import KeyRequestList, { type PendingKeyRequest } from '../components/KeyRequestList';
import { render } from './harness/render';
import { ThemeProvider } from '../theme/ThemeContext';
import { HostProvider } from '@openstoa/miniapp-bridge';
import { hostDouble } from './harness/screen';

const REQ: PendingKeyRequest = {
  id: 'req-1',
  requesterUserId: '0xasker',
  requesterDeviceId: 'their-phone',
  haveFromEpoch: null,
  createdAt: '2026-08-26T01:00:00.000Z',
};

const DESCRIPTION = 'openstoa.keyRequest.pendingRow';
const GRANT = 'openstoa.keyRequest.grant';
const CANNOT = 'openstoa.keyRequest.cannotHelp';
const GRANTED = 'openstoa.keyRequest.granted';
const RETRY = 'openstoa.keyRequest.retryGrant';

async function mount(onGrant: (r: PendingKeyRequest) => Promise<number>) {
  // The theme reads colours through the host, so the list needs one even
  // though nothing here touches the bridge.
  return render(
    <HostProvider api={hostDouble().api as never}>
      <ThemeProvider>
        <KeyRequestList requests={[REQ]} onGrant={onGrant} />
      </ThemeProvider>
    </HostProvider>,
  );
}

describe('the grant row before and after it is answered', () => {
  it('CONTRACT: while waiting, the description explains the button', async () => {
    const rendered = await mount(async () => 1);
    const out = rendered.text();
    expect(out).toContain(DESCRIPTION);
    expect(out).toContain(GRANT);
    rendered.unmount();
  });

  it('REGRESSION: the cannot-help answer REPLACES the description', async () => {
    // Both on one line is the defect: the description collapsed to "A member c…"
    // beside a full-width answer, and neither could be read.
    const rendered = await mount(async () => 0);
    await rendered.press(rendered.pressableWith(GRANT)!);
    const out = rendered.text();
    expect(out).toContain(CANNOT);
    expect(out).not.toContain(DESCRIPTION);
    rendered.unmount();
  });

  it('BOUNDARY: a successful grant answers the same way', async () => {
    const rendered = await mount(async () => 3);
    await rendered.press(rendered.pressableWith(GRANT)!);
    const out = rendered.text();
    expect(out).toContain(GRANTED);
    expect(out).not.toContain(DESCRIPTION);
    rendered.unmount();
  });

  it('RACE: a grant that THROWS offers a retry, not a settled answer', async () => {
    /*
     * A failure is not an answer. Returning to a plain button would be
     * indistinguishable from not having tapped, so the row keeps its
     * description and offers Retry — which means the description must still be
     * there, unlike the settled cases above.
     */
    const rendered = await mount(vi.fn(async () => { throw new Error('network'); }));
    await rendered.press(rendered.pressableWith(GRANT)!);
    const out = rendered.text();
    expect(out).toContain(RETRY);
    expect(out).toContain(DESCRIPTION);
    expect(out).not.toContain(CANNOT);
    rendered.unmount();
  });
});
