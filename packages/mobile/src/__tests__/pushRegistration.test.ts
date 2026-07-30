import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerPushOnce,
  resetPushRegistrations,
  type PushRegistrationHost,
  type PushRegistrationPoster,
} from '../hooks/pushRegistration';

// The dedupe set is a module-level singleton (that is the point of the change),
// so every test starts from a clean slate.
beforeEach(() => {
  resetPushRegistrations();
});

const REG = {
  routingHandle: 'handle-uuid-1',
  pushToken: 'ExponentPushToken[abc]',
  platform: 'ios' as const,
};

function makeHost(
  impl?: PushRegistrationHost['registerForPush'],
): { host: PushRegistrationHost; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(impl ?? (async () => REG));
  return { host: { registerForPush: spy }, spy };
}

function makePoster(impl?: () => Promise<unknown>): {
  client: PushRegistrationPoster;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(impl ?? (async () => ({ ok: true })));
  return { client: { post: spy as PushRegistrationPoster['post'] }, spy };
}

describe('registerPushOnce — happy path + contract invocation', () => {
  it('registers and POSTs the exact host payload to /api/push/register', async () => {
    const { host, spy: hostSpy } = makeHost();
    const { client, spy: postSpy } = makePoster();

    await expect(registerPushOnce('user-a', host, client)).resolves.toBe(
      'registered',
    );

    expect(hostSpy).toHaveBeenCalledTimes(1);
    // Contract invocation: assert the endpoint AND every field, so silently
    // dropping one (e.g. platform) fails here instead of on a device.
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith('/api/push/register', {
      routingHandle: 'handle-uuid-1',
      pushToken: 'ExponentPushToken[abc]',
      platform: 'ios',
    });
  });

  it('passes android through unchanged', async () => {
    const { host } = makeHost(async () => ({ ...REG, platform: 'android' }));
    const { client, spy: postSpy } = makePoster();

    await registerPushOnce('user-a', host, client);

    expect(postSpy.mock.calls[0][1]).toMatchObject({ platform: 'android' });
  });
});

describe('registerPushOnce — fires exactly once per session', () => {
  it('a second call for the SAME identity is a duplicate and does not re-register', async () => {
    const { host, spy: hostSpy } = makeHost();
    const { client, spy: postSpy } = makePoster();

    await registerPushOnce('user-a', host, client);
    await expect(registerPushOnce('user-a', host, client)).resolves.toBe(
      'duplicate',
    );
    await expect(registerPushOnce('user-a', host, client)).resolves.toBe(
      'duplicate',
    );

    expect(hostSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('concurrent calls in the same tick register only once (claim is synchronous)', async () => {
    // Race row: two mounts landing before the first await resolves. The claim is
    // taken before `await host.registerForPush()`, so the second call sees it.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { host, spy: hostSpy } = makeHost(async () => {
      await gate;
      return REG;
    });
    const { client, spy: postSpy } = makePoster();

    const first = registerPushOnce('user-a', host, client);
    const second = registerPushOnce('user-a', host, client);
    release();

    expect(await Promise.all([first, second])).toEqual([
      'registered',
      'duplicate',
    ]);
    expect(hostSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('a DIFFERENT identity registers again (sign out, sign in as another user)', async () => {
    const { host, spy: hostSpy } = makeHost();
    const { client, spy: postSpy } = makePoster();

    await expect(registerPushOnce('user-a', host, client)).resolves.toBe(
      'registered',
    );
    await expect(registerPushOnce('user-b', host, client)).resolves.toBe(
      'registered',
    );
    // Back to the first user in the same process — already registered.
    await expect(registerPushOnce('user-a', host, client)).resolves.toBe(
      'duplicate',
    );

    expect(hostSpy).toHaveBeenCalledTimes(2);
    expect(postSpy).toHaveBeenCalledTimes(2);
  });

  it('the empty-string identity is a real key, not a falsy skip', async () => {
    // Boundary row: hydrateExistingToken sets `userId: me.userId ?? ''`, so ''
    // is reachable while authenticated. It must register once, then dedupe.
    const { host, spy: hostSpy } = makeHost();
    const { client } = makePoster();

    await expect(registerPushOnce('', host, client)).resolves.toBe('registered');
    await expect(registerPushOnce('', host, client)).resolves.toBe('duplicate');
    expect(hostSpy).toHaveBeenCalledTimes(1);
  });
});

describe('registerPushOnce — no-ops cleanly', () => {
  it('host without registerForPush is unsupported and never POSTs', async () => {
    const { client, spy: postSpy } = makePoster();

    await expect(registerPushOnce('user-a', {}, client)).resolves.toBe(
      'unsupported',
    );
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('an unsupported host does not consume the identity claim', async () => {
    // A host that gains push support later (or a mis-ordered mount) must still
    // be able to register.
    const { client } = makePoster();
    await registerPushOnce('user-a', {}, client);

    const { host, spy: hostSpy } = makeHost();
    await expect(registerPushOnce('user-a', host, client)).resolves.toBe(
      'registered',
    );
    expect(hostSpy).toHaveBeenCalledTimes(1);
  });

  it('host returning null (simulator / permission denied) never POSTs', async () => {
    const { host } = makeHost(async () => null);
    const { client, spy: postSpy } = makePoster();

    await expect(registerPushOnce('user-a', host, client)).resolves.toBe(
      'unavailable',
    );
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('a null result KEEPS the claim so permission is not re-prompted every mount', async () => {
    const { host, spy: hostSpy } = makeHost(async () => null);
    const { client } = makePoster();

    await registerPushOnce('user-a', host, client);
    await expect(registerPushOnce('user-a', host, client)).resolves.toBe(
      'duplicate',
    );
    expect(hostSpy).toHaveBeenCalledTimes(1);
  });
});

describe('registerPushOnce — failures are best-effort and retryable', () => {
  it('a throwing host is swallowed and RELEASES the claim so a later mount retries', async () => {
    const { host: badHost } = makeHost(async () => {
      throw new Error('APNs unavailable');
    });
    const { client, spy: postSpy } = makePoster();

    await expect(registerPushOnce('user-a', badHost, client)).resolves.toBe(
      'failed',
    );
    expect(postSpy).not.toHaveBeenCalled();

    const { host: goodHost } = makeHost();
    await expect(registerPushOnce('user-a', goodHost, client)).resolves.toBe(
      'registered',
    );
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('a failing POST (network / 500) is swallowed and RELEASES the claim', async () => {
    const { host } = makeHost();
    const failing = makePoster(async () => {
      throw new Error('500');
    });

    await expect(registerPushOnce('user-a', host, failing.client)).resolves.toBe(
      'failed',
    );
    expect(failing.spy).toHaveBeenCalledTimes(1);

    const ok = makePoster();
    await expect(registerPushOnce('user-a', host, ok.client)).resolves.toBe(
      'registered',
    );
    expect(ok.spy).toHaveBeenCalledTimes(1);
  });

  it('never rejects — the caller is a React effect', async () => {
    const { host } = makeHost(async () => {
      throw new Error('boom');
    });
    const { client } = makePoster();
    // Would be an unhandled rejection in the effect if this ever threw.
    await expect(registerPushOnce('user-a', host, client)).resolves.toBe(
      'failed',
    );
  });
});
