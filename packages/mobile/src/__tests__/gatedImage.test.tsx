/**
 * `GatedImage` — the regression this exists for.
 *
 * Once `R2_PUBLIC_URL` pointed at `/api/media` (M-6), the web client kept
 * working because a browser attaches the session cookie to an `<img>` by
 * itself. React Native's `<Image>` issues its own request carrying neither a
 * cookie nor our Bearer, so every gated picture in the mini-app resolved as a
 * guest and 401'd — post images blank in the app, the same image fine on the
 * web, avatars fine everywhere (they are ungated server-side, which is what
 * made the shape of the bug so confusing).
 *
 * These tests assert the SOURCE OBJECT each call site hands React Native,
 * because that object is the whole fix: the uri resolved against our origin,
 * and `headers` present if and only if the uri is ours.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { act } from 'react-test-renderer';
import { HostProvider } from '@openstoa/miniapp-bridge';
import type { ReactTestInstance } from 'react-test-renderer';
import { GatedImage } from '../components/GatedImage';
import { PostContent } from '../components/PostContent';
import { render, flush } from './harness/render';
import { hostDouble } from './harness/screen';

const BASE = 'https://openstoa.test';
const STORED = '/api/media/topics/11111111-2222-4333-8444-555555555555/posts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/photo.jpg';

type Source = { uri?: string; headers?: Record<string, string> };

async function mount(element: React.ReactElement, over: Record<string, unknown> = {}) {
  const host = hostDouble(over);
  const rendered = await render(<HostProvider api={host.api as never}>{element}</HostProvider>);
  return { rendered, host };
}

/*
 * Host elements are matched BY NAME, the same widening the harness's own
 * `isPressable` does: the stand-in names its elements after the RN components
 * (`Image`), which is not a member of React's DOM element union, so a bare
 * `n.type === 'Image'` is a type error rather than a false comparison.
 */
function hostsNamed(root: ReactTestInstance, name: string): ReactTestInstance[] {
  return root.findAll((n) => typeof n.type === 'string' && (n.type as string) === name);
}

function imageSource(root: ReactTestInstance): Source {
  const images = hostsNamed(root, 'Image');
  expect(images).toHaveLength(1);
  return images[0].props.source as Source;
}

describe('GatedImage', () => {
  it('resolves a stored relative path and attaches the Bearer', async () => {
    const { rendered } = await mount(<GatedImage uri={STORED} />);
    expect(imageSource(rendered.root)).toEqual({
      uri: `${BASE}${STORED}`,
      headers: { Authorization: 'Bearer test-token' },
    });
  });

  it('sends no headers at all for a guest with no token', async () => {
    const { rendered } = await mount(<GatedImage uri={STORED} />, {
      getOpenStoaToken: async () => null,
    });
    const source = imageSource(rendered.root);
    expect(source).toEqual({ uri: `${BASE}${STORED}` });
    // Not `headers: undefined` — RN keys its image cache on the source, and
    // the un-credentialed case must stay the exact source it was before.
    expect('headers' in source).toBe(false);
  });

  it('leaves a third-party url completely untouched', async () => {
    const foreign = 'https://images.example.com/a/b/c.png';
    const { rendered } = await mount(<GatedImage uri={foreign} />);
    const source = imageSource(rendered.root);
    expect(source).toEqual({ uri: foreign });
    expect('headers' in source).toBe(false);
  });

  it('leaves a local file and a data uri untouched', async () => {
    for (const uri of ['file:///var/mobile/tmp/pick.jpg', 'data:image/png;base64,iVBORw0KGgo=']) {
      const { rendered } = await mount(<GatedImage uri={uri} />);
      expect(imageSource(rendered.root)).toEqual({ uri });
    }
  });

  it('renders null and undefined as the undefined uri the call sites always passed', async () => {
    for (const uri of [null, undefined]) {
      const { rendered } = await mount(<GatedImage uri={uri} />);
      expect(imageSource(rendered.root)).toEqual({ uri: undefined });
    }
  });

  it('passes an empty string through as an empty string, exactly as before', async () => {
    // Checked as its own case rather than lumped in with null/undefined,
    // because it is NOT the same value: `absolutizeMediaUrl('')` returns `''`
    // and `'' ?? undefined` is still `''`, which is what every call site fed
    // `<Image>` before this component existed. Pinned so the day someone
    // "tidies" it into `undefined` is a decision, not a side effect.
    const { rendered } = await mount(<GatedImage uri="" />);
    expect(imageSource(rendered.root)).toEqual({ uri: '' });
  });

  it('keeps the cache-busting query the profile screen appends', async () => {
    const busted = `${BASE}/api/media/users/u1/profile/x/me.png?t=1723`;
    const { rendered } = await mount(<GatedImage uri={busted} />);
    expect(imageSource(rendered.root)).toEqual({
      uri: busted,
      headers: { Authorization: 'Bearer test-token' },
    });
  });

  it('forwards the props a call site passes through', async () => {
    const { rendered } = await mount(
      <GatedImage uri={STORED} style={{ width: 40 }} resizeMode="cover" testID="avatar" />,
    );
    const image = hostsNamed(rendered.root, 'Image')[0];
    expect(image.props.style).toEqual({ width: 40 });
    expect(image.props.resizeMode).toBe('cover');
    expect(image.props.testID).toBe('avatar');
  });

  it('still renders when the token lookup rejects', async () => {
    // Fire-and-forget: a credential this component could not obtain must not
    // take the picture — or the screen — down with it.
    const { rendered } = await mount(<GatedImage uri={STORED} />, {
      getOpenStoaToken: async () => {
        throw new Error('keychain unavailable');
      },
    });
    expect(imageSource(rendered.root)).toEqual({ uri: `${BASE}${STORED}` });
  });

  it('picks up a token that only became available after the image failed', async () => {
    // The race the design doc flagged: a row mounts in the window where the
    // old token has expired and the refresh has not landed. RN does not retry
    // an <Image> on its own, so without this the picture stays blank for the
    // life of the screen.
    let call = 0;
    const { rendered } = await mount(<GatedImage uri={STORED} />, {
      getOpenStoaToken: async () => (++call === 1 ? null : 'fresh-token'),
    });
    expect(imageSource(rendered.root)).toEqual({ uri: `${BASE}${STORED}` });

    const image = hostsNamed(rendered.root, 'Image')[0];
    await act(async () => {
      (image.props.onError as (e: unknown) => void)({});
    });
    await flush();

    expect(imageSource(rendered.root)).toEqual({
      uri: `${BASE}${STORED}`,
      headers: { Authorization: 'Bearer fresh-token' },
    });
  });

  it('still calls a caller’s own onError', async () => {
    const seen: unknown[] = [];
    const { rendered } = await mount(
      <GatedImage uri={STORED} onError={(e) => seen.push(e)} />,
    );
    const image = hostsNamed(rendered.root, 'Image')[0];
    await act(async () => {
      (image.props.onError as (e: unknown) => void)({ tag: 'broken' });
    });
    expect(seen).toEqual([{ tag: 'broken' }]);
  });
});

describe('PostContent inline <img>', () => {
  /*
   * The second integration point, and the one no grep for `source={{ uri`
   * finds: `RenderHtml` fetches an inline `<img>` through its own pipeline, so
   * `GatedImage` never sees it. What is asserted here is OUR half — that a
   * header provider is handed to the renderer and answers correctly. The
   * library's half (threading it onto `source.headers` and switching the
   * dimension probe to `Image.getSizeWithHeaders`) was settled by reading
   * v6.3.4's `useIMGNormalizedSource.ts` / `useIMGElementState.ts`; see
   * `harness/renderHtmlStub.tsx`.
   */
  async function provider(over: Record<string, unknown> = {}) {
    const { rendered } = await mount(
      <PostContent content={`<p>hi</p><img src="${STORED}" />`} />,
      over,
    );
    const nodes = hostsNamed(rendered.root, 'RenderHtml');
    expect(nodes).toHaveLength(1);
    const fn = nodes[0].props.provideEmbeddedHeaders as
      | ((uri: string, tag: string) => Record<string, string> | undefined)
      | undefined;
    expect(typeof fn).toBe('function');
    return fn!;
  }

  it('provides the Bearer for a gated image in a post body', async () => {
    const provide = await provider();
    expect(provide(`${BASE}${STORED}`, 'img')).toEqual({
      Authorization: 'Bearer test-token',
    });
  });

  it('refuses an author-supplied third-party image', async () => {
    // A post body is author-controlled HTML. Handing this reader's session
    // token to a host the author chose would give the author a working
    // credential.
    const provide = await provider();
    expect(provide('https://author-controlled.example/pixel.png', 'img')).toBeUndefined();
    expect(provide('https://openstoa.test.evil.example/api/media/x.jpg', 'img')).toBeUndefined();
  });

  it('refuses a non-img embedded tag even on our own origin', async () => {
    const provide = await provider();
    expect(provide(`${BASE}${STORED}`, 'iframe')).toBeUndefined();
  });

  it('provides nothing for a guest', async () => {
    const provide = await provider({ getOpenStoaToken: async () => null });
    expect(provide(`${BASE}${STORED}`, 'img')).toBeUndefined();
  });
});
