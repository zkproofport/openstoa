import React from 'react';
import { expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { PeerProfileCard } from '../components/PeerProfileCard';
import { renderScreen } from './harness/screen';
import en from '../i18n/locales/en.json';
import ko from '../i18n/locales/ko.json';
it('renders every public proof type in Korean and prints a workspace domain once', async () => {
  const i18n = createInstance();
  await i18n.init({ lng: 'ko', resources: { en: { translation: en }, ko: { translation: ko } } });
  const { rendered } = await renderScreen(<I18nextProvider i18n={i18n}><PeerProfileCard
    viewerUserId="viewer" onClose={() => {}} onMessage={() => {}}
    target={{ userId: 'peer', nickname: 'Alice', badges: [
      { type: 'kyc', label: 'KYC' }, { type: 'country', label: 'Country' },
      { type: 'oidc', label: 'OIDC' }, { type: 'workspace', label: 'example.com', domain: 'example.com' },
    ] }}
  /></I18nextProvider>);
  try {
    expect(rendered.text()).toContain('신원 인증');
    expect(rendered.text()).toContain('국가 인증');
    expect(rendered.text()).toContain('로그인 인증');
    expect(rendered.text().match(/example\.com/g)).toHaveLength(1);
  } finally { rendered.unmount(); }
});

import { act } from 'react-test-renderer';
import { QueryClient, skipToken, useQuery } from '@tanstack/react-query';
import { updateIdentityBadgeCaches } from '../lib/identityBadges';
import { UserIdentity, identityBadgesKey } from '../components/UserIdentity';
import { flush } from './harness/render';

it('new explicit empty badges supersede an old ON snapshot and no identity observer fetches', async () => {
  const queryClient = new QueryClient();
  const badges = [{ type: 'workspace', label: 'example.com', domain: 'example.com' }];
  queryClient.setQueryData(identityBadgesKey('me'), badges);
  let setBadges!: React.Dispatch<React.SetStateAction<typeof badges | undefined>>;
  function Probe() {
    const [value, setValue] = React.useState<typeof badges>();
    setBadges = setValue;
    return <UserIdentity identity={{ userId: 'me', nickname: 'Alice', badges: value }} />;
  }
  const { rendered } = await renderScreen(<Probe />, { queryClient });
  try {
    expect(rendered.text()).toContain('example.com');
    await act(async () => { setBadges([]); });
    expect(rendered.text()).not.toContain('example.com');
    expect(queryClient.isFetching()).toBe(0);
  } finally { rendered.unmount(); }
});

import { PostCard } from '../components/PostCard';
import type { Post } from '@openstoa/api-types';
it('a real feed post shows all public author badges and updates when their array becomes empty', async () => {
  const i18n = createInstance();
  await i18n.init({ lng: 'ko', resources: { ko: { translation: ko } } });
  const post: Post = { id: 'post', topicId: 'general-topic', authorId: 'peer', authorNickname: 'Alice',
    title: 'Hello', content: '', upvoteCount: 0, viewCount: 0, commentCount: 0, score: 0, isAI: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    badges: [{ type: 'kyc', label: 'KYC' }, { type: 'oidc', label: 'OIDC' }],
  };
  const queryClient = new QueryClient();
  queryClient.setQueryData(['feed'], { posts: [post] });
  function Feed() {
    const { data } = useQuery<{ posts: Post[] }>({ queryKey: ['feed'], queryFn: skipToken });
    return <PostCard post={data!.posts[0]} onPress={() => {}} />;
  }
  const { rendered } = await renderScreen(<I18nextProvider i18n={i18n}><Feed /></I18nextProvider>, { queryClient });
  try {
    expect(rendered.text()).toContain('신원 인증');
    expect(rendered.text()).toContain('로그인 인증');
    await act(async () => { updateIdentityBadgeCaches(queryClient, 'peer', []); });
    for (let i = 0; i < 30 && rendered.text().includes('신원 인증'); i++) await flush(2);
    expect(rendered.text()).not.toContain('신원 인증');
    expect(rendered.text()).not.toContain('로그인 인증');
  } finally { rendered.unmount(); }
});
