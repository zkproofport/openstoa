/** The invite fragment stays local and is imported only after membership succeeds. */
import React from 'react';
import {act} from 'react-test-renderer';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {TopicsHomeScreen} from '../screens/topics/TopicsHomeScreen';
import {InvitePromptModal} from '../components/InvitePromptModal';
import {renderScreen, hostDouble} from './harness/screen';
import {flushUntil, type Rendered} from './harness/render';
import {useOpenStoaSession} from '../stores/sessionStore';
import {buildInviteUrl} from '../lib/inviteLink';

const imported = vi.hoisted(() => vi.fn(async () => 1));
vi.mock('../crypto/mobileTransport', () => ({getTakSessionStore: () => ({importInviteHistory: imported})}));
const proof = {proof: '0x1234', publicInputs: ['0x01']};
const scope = 'zkproofport-community:topic:me';
const key = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';
const invite = buildInviteUrl('https://openstoa.test/topics/join/invite-code', {1: key}, 'topic');
let mounted: Rendered | undefined;
const wire: {path: string; body: unknown}[] = [];
let requirement: Record<string, unknown>;
let retryStatus: number;
beforeEach(() => {
  imported.mockClear(); wire.length = 0; retryStatus = 201;
  requirement = {type: 'country', allowedCountries: ['KR'], domain: null};
  useOpenStoaSession.setState({mode: 'authenticated', token: 'test-token', userId: 'me'});
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    let status = 200;
    let data: unknown = {topics: [], categories: []};
    if (init?.method === 'POST') wire.push({path, body});
    if (path === '/api/auth/challenge') data = {scope};
    if (path === '/api/topics/join/invite-code') {
      expect(imported).not.toHaveBeenCalled();
      status = body ? retryStatus : 402;
      data = status === 402 ? {error: 'Proof required to join this topic', proofRequirement: requirement}
        : status === 201 ? {success: true, topicId: 'topic'} : {error: 'Proof verification failed'};
    }
    return {ok: status >= 200 && status < 300, status, json: async () => data, text: async () => JSON.stringify(data)} as Response;
  });
});
afterEach(() => {mounted?.unmount(); mounted = undefined; vi.unstubAllGlobals(); useOpenStoaSession.setState({mode: 'guest', token: null, userId: null});});
async function screen(generateProof = vi.fn(async () => proof)) {
  const harness = await renderScreen(<TopicsHomeScreen />, {host: hostDouble({generateProof})});
  mounted = harness.rendered;
  const header = harness.nav.setOptions.calls.at(-1)?.[0] as {headerRight: () => React.ReactElement};
  await act(async () => (header.headerRight().props as any).children[0].props.onPress());
  return {...harness, generateProof};
}
async function submit(rendered: Rendered) {
  await act(async () => rendered.root.findByType(InvitePromptModal).props.onSubmit(invite));
}

it('generates the requested proof, retries, and only then imports fragment history', async () => {
  const {rendered, generateProof, nav} = await screen();
  await submit(rendered);
  expect(generateProof).toHaveBeenCalledWith({scope, circuit: 'coinbase_country_attestation', countryList: ['KR'], isIncluded: true});
  expect(wire).toEqual([
    {path: '/api/topics/join/invite-code', body: undefined},
    {path: '/api/auth/challenge', body: undefined},
    {path: '/api/topics/join/invite-code', body: proof},
  ]);
  expect(imported).toHaveBeenCalledExactlyOnceWith('topic', {1: key});
  expect(nav.navigate.calls).toContainEqual(['TopicDetail', {topicId: 'topic'}]);
  expect(JSON.stringify(wire)).not.toContain(key);
});

it.each(['native-failed', 'server-rejected'])('does not import keys or navigate when %s', async failure => {
  retryStatus = 400;
  const generateProof = vi.fn(async () => {
    if (failure === 'native-failed') throw new Error('Proof failed');
    return proof;
  });
  const {rendered, nav} = await screen(generateProof);
  await submit(rendered);
  expect(generateProof).toHaveBeenCalled();
  expect(imported).not.toHaveBeenCalled();
  expect(nav.navigate.calls).toEqual([]);
});

it('lets an either-provider invite joiner choose Microsoft before retrying', async () => {
  requirement = {type: 'workspace', domain: null};
  const {rendered, generateProof} = await screen();
  await submit(rendered);
  expect(generateProof).not.toHaveBeenCalled();
  await flushUntil(() => Boolean(rendered.pressableWith('openstoa.topicCreate.proofTypes.microsoft365')));
  await rendered.press(rendered.pressablesWith('openstoa.topicCreate.proofTypes.microsoft365').find(choice => choice.props.accessibilityRole === 'radio')!);
  await submit(rendered);
  expect(generateProof).toHaveBeenCalledWith({scope, circuit: 'oidc_domain_attestation', provider: 'microsoft'});
  expect(imported).toHaveBeenCalledExactlyOnceWith('topic', {1: key});
});
