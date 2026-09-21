/** Regressions: signed-in scope, proof body, circuit restrictions, open topics,
 * and failed proof generation. Network/native proof generation are boundaries;
 * screens, auth gate, query mutations and authenticated API client are real. */
import React from 'react';
import { Alert } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushUntil, type Rendered } from './harness/render';
import { renderScreen, hostDouble } from './harness/screen';
import { TopicDetailScreen } from '../screens/topics/TopicDetailScreen';
import { TopicCreateScreen } from '../screens/topics/TopicCreateScreen';
import { useOpenStoaSession } from '../stores/sessionStore';

const scope = 'zkproofport-community:topic:me';
const proof = { proof: '0xabcd', publicInputs: ['0x01'] };
const calls: { path: string; body: any; authorization: string | null }[] = [];
let topic: Record<string, unknown>;
const mounted: Rendered[] = [];
async function ready(rendered: Rendered, label: string) {
  mounted.push(rendered);
  await flushUntil(() => Boolean(rendered.pressableWith(label)), { label });
}
beforeEach(() => {
  calls.length = 0;
  (Alert as unknown as { reset(): void }).reset();
  topic = { id: 'topic', title: 'A topic', proofType: 'kyc', visibility: 'public', isMember: false };
  useOpenStoaSession.setState({ mode: 'authenticated', token: 'test-token', userId: 'me', needsNickname: false });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (init?.method === 'POST') calls.push({ path, body: init.body ? JSON.parse(String(init.body)) : undefined, authorization: new Headers(init.headers).get('Authorization') });
    const json = path === '/api/auth/challenge' ? { scope, challengeId: 'challenge' }
      : path === '/api/categories' ? { categories: [{ id: 'category', name: 'General', slug: 'general' }] }
      : path.endsWith('/posts') ? { posts: [] } : { topic, currentUserRole: null };
    return { ok: true, status: 200, json: async () => json, text: async () => '' } as Response;
  }));
});
afterEach(() => { mounted.splice(0).forEach(rendered => rendered.unmount()); vi.unstubAllGlobals(); useOpenStoaSession.setState({ mode: 'guest', token: null, userId: null }); });

it.each([
  ['kyc', {}, { circuit: 'coinbase_attestation' }],
  ['country', { allowedCountries: ['KR'], countryMode: 'include' }, { circuit: 'coinbase_country_attestation', countryList: ['KR'], isIncluded: true }],
  ['google_workspace', { requiredDomain: 'example.com' }, { circuit: 'oidc_domain_attestation', domain: 'example.com', provider: 'google' }],
  ['microsoft_365', { requiredDomain: 'example.com' }, { circuit: 'oidc_domain_attestation', domain: 'example.com', provider: 'microsoft' }],
  ['google_workspace', {}, { circuit: 'oidc_domain_attestation', provider: 'google' }],
  ['microsoft_365', { requiredDomain: null }, { circuit: 'oidc_domain_attestation', provider: 'microsoft' }],
])('join submits %s proof using authenticated challenge and restrictions', async (proofType, restrictions, inputs) => {
  Object.assign(topic, { proofType }, restrictions);
  const generateProof = vi.fn(async () => proof);
  const { rendered } = await renderScreen(<TopicDetailScreen />, { host: hostDouble({ generateProof }), params: { topicId: 'topic' } });
  await ready(rendered, 'openstoa.topics.join');
  await rendered.press(rendered.pressableWith('openstoa.topics.join')!);
  expect(generateProof).toHaveBeenCalledWith({ scope, ...inputs });
  expect(calls).toEqual([
    { path: '/api/auth/challenge', body: undefined, authorization: 'Bearer test-token' },
    { path: '/api/topics/topic/join', body: proof, authorization: 'Bearer test-token' },
  ]);
});

it('does not post a membership when the native proof is incomplete', async () => {
  const { rendered } = await renderScreen(<TopicDetailScreen />, { host: hostDouble({ generateProof: async () => ({ proof: '', publicInputs: [] }) }), params: { topicId: 'topic' } });
  await ready(rendered, 'openstoa.topics.join');
  await rendered.press(rendered.pressableWith('openstoa.topics.join')!);
  expect(calls.some(call => call.path.endsWith('/join'))).toBe(false);
});

it('joins an open topic without generating a proof', async () => {
  topic.proofType = 'none';
  const generateProof = vi.fn();
  const { rendered } = await renderScreen(<TopicDetailScreen />, { host: hostDouble({ generateProof }), params: { topicId: 'topic' } });
  await ready(rendered, 'openstoa.topics.join');
  await rendered.press(rendered.pressableWith('openstoa.topics.join')!);
  expect(generateProof).not.toHaveBeenCalled();
  expect(calls.map(call => call.path)).toEqual(['/api/topics/topic/join']);
});

it('creator submits the generated proof before entering a proof-gated topic', async () => {
  const generateProof = vi.fn(async () => proof);
  const { rendered } = await renderScreen(<TopicCreateScreen />, { host: hostDouble({ generateProof }) });
  await ready(rendered, 'openstoa.topicCreate.submit');
  const title = rendered.root.findAll(n => (n.type as unknown as string) === 'TextInput')[0];
  await act(async () => title.props.onChangeText('Proof topic'));
  await rendered.press(rendered.pressableWith('openstoa.topicCreate.proofTypes.kyc')!);
  await rendered.press(rendered.pressableWith('openstoa.topicCreate.submit')!);
  expect(generateProof).toHaveBeenCalledWith({ scope, circuit: 'coinbase_attestation' });
  expect(calls.find(call => call.path === '/api/topics')?.body).toMatchObject(proof);
});

it('offers only supported inclusion criteria for country creation', async () => {
  const generateProof = vi.fn(async () => proof);
  const { rendered } = await renderScreen(<TopicCreateScreen />, { host: hostDouble({ generateProof }) });
  await ready(rendered, 'openstoa.topicCreate.submit');
  const title = rendered.root.findAll(n => (n.type as unknown as string) === 'TextInput')[0];
  await act(async () => title.props.onChangeText('Country topic'));
  await rendered.press(rendered.pressableWith('openstoa.topicCreate.proofTypes.country')!);
  expect(Boolean(rendered.pressableWith('openstoa.topicCreate.countryExclude'))).toBe(false);
  const countries = rendered.root.findAll(n => (n.type as unknown as string) === 'TextInput' && n.props.placeholder === 'US, KR, JP')[0];
  await act(async () => countries.props.onChangeText('KR'));
  await rendered.press(rendered.pressableWith('openstoa.topicCreate.submit')!);
  expect(generateProof).toHaveBeenCalledWith({ scope, circuit: 'coinbase_country_attestation', countryList: ['KR'], isIncluded: true });
  expect(calls.find(call => call.path === '/api/topics')?.body).toMatchObject({ countryMode: 'include', allowedCountries: ['KR'], ...proof });
});

it.each(['example.com', undefined])('lets a workspace joiner select Microsoft (domain: %s)', async requiredDomain => {
  Object.assign(topic, { proofType: 'workspace', requiredDomain });
  const generateProof = vi.fn(async () => proof);
  const { rendered } = await renderScreen(<TopicDetailScreen />, { host: hostDouble({ generateProof }), params: { topicId: 'topic' } });
  await ready(rendered, 'openstoa.topics.join');
  expect(rendered.pressableWith('openstoa.topics.join')!.props.disabled).toBe(true);
  const microsoft = rendered.pressableWith('openstoa.topicCreate.proofTypes.microsoft365');
  expect(microsoft).toBeDefined();
  await rendered.press(microsoft!);
  await rendered.press(rendered.pressableWith('openstoa.topics.join')!);
  expect(generateProof).toHaveBeenCalledWith({ scope, circuit: 'oidc_domain_attestation', ...(requiredDomain ? { domain: requiredDomain } : {}), provider: 'microsoft' });
  expect(calls.find(call => call.path.endsWith('/join'))?.body).toEqual(proof);
});

it.each(['cancelled', 'unknown', 'missing-scope', 'challenge-offline'])('does not join or claim success for %s proof flow', async failure => {
  if (failure === 'unknown') topic.proofType = 'unknown-circuit';
  const generateProof = vi.fn(async () => {
    if (failure === 'cancelled') throw new Error('Cancelled');
    return proof;
  });
  if (failure === 'missing-scope' || failure === 'challenge-offline') {
    const original = global.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/auth/challenge')) {
        if (failure === 'challenge-offline') throw new TypeError('Offline');
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response;
      }
      return original(input, init);
    });
  }
  const { rendered, queryClient } = await renderScreen(<TopicDetailScreen />, { host: hostDouble({ generateProof }), params: { topicId: 'topic' } });
  await ready(rendered, 'openstoa.topics.join');
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  await rendered.press(rendered.pressableWith('openstoa.topics.join')!);
  await flushUntil(() => (Alert as unknown as { alerts: unknown[] }).alerts.length > 0);
  expect(calls.some(call => call.path.endsWith('/join'))).toBe(false);
  expect(invalidate).not.toHaveBeenCalled();
  expect((Alert as unknown as { alerts: { message: string }[] }).alerts[0].message).toBe(
    failure === 'challenge-offline' ? 'openstoa.errors.connection' : 'openstoa.common.errorFallback',
  );
  if (failure !== 'cancelled') expect(generateProof).not.toHaveBeenCalled();
});

it('creator can select Microsoft for an either-provider workspace topic', async () => {
  const generateProof = vi.fn(async () => proof);
  const { rendered } = await renderScreen(<TopicCreateScreen />, { host: hostDouble({ generateProof }) });
  await ready(rendered, 'openstoa.topicCreate.submit');
  const title = rendered.root.findAll(n => (n.type as unknown as string) === 'TextInput')[0];
  await act(async () => title.props.onChangeText('Workspace topic'));
  await rendered.press(rendered.pressableWith('openstoa.topicCreate.proofTypes.workspace')!);
  const domain = rendered.root.findAll(n => (n.type as unknown as string) === 'TextInput' && n.props.placeholder === 'company.com')[0];
  await act(async () => domain.props.onChangeText('example.com'));
  expect(rendered.pressableWith('openstoa.topicCreate.submit')!.props.disabled).toBe(true);
  const choices = rendered.pressablesWith('openstoa.topicCreate.proofTypes.microsoft365');
  await rendered.press(choices.find(choice => choice.props.accessibilityRole === 'radio')!);
  await rendered.press(rendered.pressableWith('openstoa.topicCreate.submit')!);
  expect(generateProof).toHaveBeenCalledWith({ scope, circuit: 'oidc_domain_attestation', domain: 'example.com', provider: 'microsoft' });
  expect(calls.find(call => call.path === '/api/topics')?.body).toMatchObject({ proofType: 'workspace', ...proof });
});

it.each([
  ['google_workspace', 'googleWorkspace', 'google'],
  ['microsoft_365', 'microsoft365', 'microsoft'],
  ['workspace', 'workspace', 'microsoft'],
])('creates %s topics without pinning a domain', async (proofType, label, provider) => {
  const generateProof = vi.fn(async () => proof);
  const { rendered } = await renderScreen(<TopicCreateScreen />, { host: hostDouble({ generateProof }) });
  await ready(rendered, 'openstoa.topicCreate.submit');
  const title = rendered.root.findAll(n => (n.type as unknown as string) === 'TextInput')[0];
  await act(async () => title.props.onChangeText('Any organization'));
  await rendered.press(rendered.pressableWith(`openstoa.topicCreate.proofTypes.${label}`)!);
  if (proofType === 'workspace') {
    const choices = rendered.pressablesWith('openstoa.topicCreate.proofTypes.microsoft365');
    await rendered.press(choices.find(choice => choice.props.accessibilityRole === 'radio')!);
  }
  await rendered.press(rendered.pressableWith('openstoa.topicCreate.submit')!);
  expect(generateProof).toHaveBeenCalledWith({ scope, circuit: 'oidc_domain_attestation', provider });
  expect(calls.find(call => call.path === '/api/topics')?.body).toMatchObject({ proofType, ...proof });
  expect(calls.find(call => call.path === '/api/topics')?.body).not.toHaveProperty('requiredDomain');
});

it('creator proof failures use the localized fallback instead of native diagnostics', async () => {
  const { rendered } = await renderScreen(<TopicCreateScreen />, { host: hostDouble({ generateProof: async () => { throw new Error('HostApi.generateProof: not yet wired to mopro'); } }) });
  await ready(rendered, 'openstoa.topicCreate.submit');
  const title = rendered.root.findAll(n => (n.type as unknown as string) === 'TextInput')[0];
  await act(async () => title.props.onChangeText('Proof topic'));
  await rendered.press(rendered.pressableWith('openstoa.topicCreate.proofTypes.kyc')!);
  await rendered.press(rendered.pressableWith('openstoa.topicCreate.submit')!);
  await flushUntil(() => (Alert as unknown as { alerts: unknown[] }).alerts.length > 0);
  expect((Alert as unknown as { alerts: { message: string }[] }).alerts[0].message).toBe('openstoa.common.errorFallback');
  expect(calls.some(call => call.path === '/api/topics')).toBe(false);
});

it.each(['join', 'create'])('does not duplicate the host ErrorModal for %s failures', async action => {
  const hostError = Object.assign(new Error('Native diagnostic'), {kind: 'HOST_TOPIC_PROOF_REPORTED'});
  const host = hostDouble({generateProof: async () => { throw hostError; }});
  const {rendered, queryClient} = await renderScreen(action === 'join' ? <TopicDetailScreen /> : <TopicCreateScreen />, {host, params: {topicId: 'topic'}});
  const label = action === 'join' ? 'openstoa.topics.join' : 'openstoa.topicCreate.submit';
  await ready(rendered, label);
  if (action === 'create') {
    const title = rendered.root.findAll(n => (n.type as unknown as string) === 'TextInput')[0];
    await act(async () => title.props.onChangeText('Proof topic'));
    await rendered.press(rendered.pressableWith('openstoa.topicCreate.proofTypes.kyc')!);
  }
  await rendered.press(rendered.pressableWith(label)!);
  await flushUntil(() => queryClient.getMutationCache().getAll().some(mutation => mutation.state.status === 'error'));
  expect((Alert as unknown as {alerts: unknown[]}).alerts).toEqual([]);
  expect(calls.some(call => call.path === '/api/topics' || call.path.endsWith('/join'))).toBe(false);
});
