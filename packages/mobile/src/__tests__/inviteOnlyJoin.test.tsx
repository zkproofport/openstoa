/**
 * A topic you cannot join this way does not offer a Join button.
 *
 * `POST /api/topics/:id/join` answers 403 to everything that is not public, and
 * that is deliberate: for `private` and `secret` the invite LINK is the door,
 * because its fragment is also what carries the chat history keys. An approval
 * flow would admit a member nobody ever handed keys to — which is precisely the
 * locked-history problem the rest of this work has been chasing.
 *
 * The button was offered anyway. Pressing it showed a spinner, snapped back,
 * and logged a 403 nobody saw: it reads as a broken control rather than a
 * locked door. Saying what the topic IS costs the same row and is true.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage here
 *   contract   → a public topic still offers Join; an invite-only one says so
 *   boundary   → every tier: public, private, secret
 *   empty      → visibility absent (an older payload) keeps the button, because
 *                the server is still the authority and refusing to render a
 *                control on missing data would hide a working one
 *   integrity  → a member sees neither — the card is not a join surface at all
 *                once you are in
 *   authz / hostile / UTF-8 / race → N/A: one field, from the server, chosen
 *                between two static renderings.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import type { Topic } from '@openstoa/api-types';
import { render } from './harness/render';
import { TopicCard } from '../components/TopicCard';

const BASE = {
  id: '11111111-2222-4333-8444-555555555555',
  title: 'Test topic',
  memberCount: 2,
} as unknown as Topic;

function topic(visibility?: string): Topic {
  return { ...BASE, visibility } as Topic;
}

const JOIN = 'openstoa.topics.join';
const INVITE_ONLY = 'openstoa.topics.inviteOnly';

describe('TopicCard — what a non-member is offered', () => {
  it('CONTRACT: a public topic still offers Join', async () => {
    const r = await render(
      <TopicCard topic={topic('public')} onPress={() => {}} isJoined={false} onJoin={() => {}} />,
    );

    expect(r.root.findAll((n) => n.props?.testID === 'card-join').length).toBeGreaterThan(0);
    expect(r.text()).not.toContain(INVITE_ONLY);
  });

  it.each(['private', 'secret'])('CONTRACT: a %s topic says invite only instead', async (v) => {
    const r = await render(
      <TopicCard topic={topic(v)} onPress={() => {}} isJoined={false} onJoin={() => {}} />,
    );

    expect(r.text()).toContain(INVITE_ONLY);
    expect(
      r.root.findAll((n) => n.props?.testID === 'card-join'),
      'offered a Join that the server always refuses',
    ).toHaveLength(0);
    expect(r.root.findAll((n) => n.props?.testID === 'card-invite-only').length).toBeGreaterThan(0);
  });

  it('EMPTY: an unknown visibility keeps the button', async () => {
    /*
     * A payload without the field is an OLDER payload, not a private topic.
     * Hiding the control on missing data would break joining a public topic the
     * moment a response shape lagged — and the server refuses what it must
     * anyway, which is now reported rather than swallowed.
     */
    const r = await render(
      <TopicCard topic={topic(undefined)} onPress={() => {}} isJoined={false} onJoin={() => {}} />,
    );

    expect(r.root.findAll((n) => n.props?.testID === 'card-join').length).toBeGreaterThan(0);
  });

  it('INTEGRITY: a member is offered neither', async () => {
    for (const v of ['public', 'private', 'secret']) {
      const r = await render(
        <TopicCard topic={topic(v)} onPress={() => {}} isJoined onJoin={() => {}} />,
      );
      // By CONTROL, not by substring: the whole card is pressable and the
      // joined badge's own key contains the join key, so a text search reports
      // a button that is not there.
      expect(
        r.root.findAll((n) => n.props?.testID === 'card-join'),
        `${v}: a member was offered Join`,
      ).toHaveLength(0);
      expect(r.root.findAll((n) => n.props?.testID === 'card-invite-only')).toHaveLength(0);
    }
  });
});
