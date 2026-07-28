/**
 * Google device-flow login unit tests (ported orchestration from the removed
 * hosted src/lib/mcp/auth.ts). A fake prove.js child and a stubbed rest.request
 * exercise: challenge → spawn → device-code surfaced → verify/ai → session →
 * persist ordering, the MCP 2-call pending/confirm handshake, and every failure
 * / timeout / not-installed edge case. No real subprocess, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ChatClient } from '@masselabs/openstoa';
import { Commands } from '../commands';
import type { ChildProcessLike, ProveSpawner } from '../deviceLogin';
import { MemorySessionStore, type SessionData } from '../session';

/** A controllable fake of the prove.js child process. */
class FakeChild implements ChildProcessLike {
  exitCode: number | null = null;
  killed = false;
  private stdoutCbs: Array<(c: unknown) => void> = [];
  private stderrCbs: Array<(c: unknown) => void> = [];
  private exitCbs: Array<(code: number | null) => void> = [];
  stdout = { on: (_e: 'data', cb: (c: unknown) => void) => this.stdoutCbs.push(cb) };
  stderr = { on: (_e: 'data', cb: (c: unknown) => void) => this.stderrCbs.push(cb) };
  on(_e: 'exit', cb: (code: number | null) => void) {
    this.exitCbs.push(cb);
    return this;
  }
  kill() {
    this.killed = true;
    return true;
  }
  emitStderr(s: string) {
    for (const cb of this.stderrCbs) cb(s);
  }
  emitStdout(s: string) {
    for (const cb of this.stdoutCbs) cb(s);
  }
  exit(code: number | null) {
    this.exitCode = code;
    for (const cb of this.exitCbs) cb(code);
  }
}

/** stderr the real prove.js prints once Google returns a device code. */
const DEVICE_STDERR = '\n  Open: https://google.com/device\n  Code: WXYZ-1234\n\n  Waiting for authorization...\n';
/** The proof JSON prove.js prints on stdout after the user approves. */
const PROOF_JSON = JSON.stringify({ proof: '0xproof', publicInputs: '0xpub', verification: { chainId: 8453 }, proofType: 'google_login' });

interface Rec {
  method: string;
  args: unknown[];
}

/**
 * Build a Commands wired to a fake ChatClient + injected prove spawner. `request`
 * is stubbed to answer /api/auth/challenge and /api/auth/verify/ai; auth.session
 * returns the post-login identity.
 */
function build(opts: {
  spawner: ProveSpawner;
  challenge?: unknown;
  verify?: unknown | (() => unknown);
  session?: unknown;
  session0?: SessionData | null;
}) {
  const calls: Rec[] = [];
  let token: string | null = null;
  const request = (...args: unknown[]) => {
    calls.push({ method: 'request', args });
    const path = args[0] as string;
    if (path === '/api/auth/challenge') return Promise.resolve(opts.challenge ?? { challengeId: 'ch1', scope: 'zkproofport-community', expiresIn: 300 });
    if (path === '/api/auth/verify/ai') {
      const v = typeof opts.verify === 'function' ? (opts.verify as () => unknown)() : opts.verify;
      return Promise.resolve(v ?? { token: 'JWT-AI', userId: '0xnull', needsNickname: true });
    }
    return Promise.resolve(undefined);
  };
  const chat = {
    useToken: (t: string) => {
      calls.push({ method: 'useToken', args: [t] });
      token = t;
    },
    rest: {
      getToken: () => token,
      setToken: (t: string) => (token = t),
      request,
      auth: { session: (...a: unknown[]) => { calls.push({ method: 'auth.session', args: a }); return Promise.resolve(opts.session ?? { userId: '0xnull', nickname: 'anon_null', isAI: true }); } },
    },
  };
  const store = new MemorySessionStore(opts.session0 ?? null);
  const cmds = new Commands({
    chat: chat as unknown as ChatClient,
    sessionStore: store,
    baseUrl: 'http://h',
    session: opts.session0 ?? null,
    proveSpawner: opts.spawner,
  });
  return { cmds, calls, store };
}

/** A spawner whose child emits the device code shortly, then the proof + exit(0). */
function happySpawner(deviceStderr = DEVICE_STDERR, proofStdout = PROOF_JSON, exitCode = 0) {
  const children: FakeChild[] = [];
  const spawner: ProveSpawner = () => {
    const child = new FakeChild();
    children.push(child);
    setTimeout(() => child.emitStderr(deviceStderr), 10);
    setTimeout(() => {
      child.emitStdout(proofStdout);
      child.exit(exitCode);
    }, 40);
    return child;
  };
  return { spawner, children };
}

describe('Google device-flow login (commands core)', () => {
  it('loginWithGoogle: challenge → spawn → device-code surfaced → verify → session → persist (in order)', async () => {
    const { spawner, children } = happySpawner();
    const { cmds, calls, store } = build({ spawner });
    const seen: Array<{ verificationUrl: string; userCode: string }> = [];

    const r = await cmds.loginWithGoogle({ onDeviceCode: (i) => seen.push(i) });

    // device code surfaced from stderr
    expect(seen).toEqual([{ verificationUrl: 'https://google.com/device', userCode: 'WXYZ-1234' }]);
    // ordering: challenge request first, then verify/ai, then session
    const order = calls.map((c) => (c.method === 'request' ? (c.args[0] as string) : c.method));
    expect(order).toEqual([
      '/api/auth/challenge',
      '/api/auth/verify/ai',
      'useToken',
      'auth.session',
    ]);
    // verify payload shape: { challengeId, result }
    const verifyReq = calls.find((c) => c.method === 'request' && c.args[0] === '/api/auth/verify/ai');
    expect(verifyReq?.args[1]).toMatchObject({
      method: 'POST',
      body: { challengeId: 'ch1', result: { proof: '0xproof', publicInputs: '0xpub', proofType: 'google_login' } },
    });
    // adopted token + persisted identity
    expect(r).toEqual({ userId: '0xnull', nickname: 'anon_null', isAI: true, needsNickname: true });
    expect(await store.read()).toEqual({ baseUrl: 'http://h', token: 'JWT-AI', userId: '0xnull', nickname: 'anon_null' });
    expect(children).toHaveLength(1);
  });

  it('authenticateGoogle: MCP 2-call pending/confirm handshake', async () => {
    const { spawner } = happySpawner();
    const { cmds, store } = build({ spawner });

    // Call 1 → pending, device code returned.
    const pending = await cmds.authenticateGoogle();
    expect(pending).toEqual({
      status: 'pending_user_login',
      verificationUrl: 'https://google.com/device',
      userCode: 'WXYZ-1234',
      instructions: expect.stringContaining('https://google.com/device'),
    });

    // Call 2 (no args) → completes, session persisted.
    const done = await cmds.authenticateGoogle();
    expect(done).toMatchObject({ status: 'authenticated', userId: '0xnull', nickname: 'anon_null', needsNickname: true });
    expect((await store.read())?.token).toBe('JWT-AI');
  });

  it('prove.js not installed / unresolved → actionable error, surfaced (not retried into oblivion)', async () => {
    const spawner: ProveSpawner = () => {
      throw new Error('Google device-flow login needs @zkproofport-ai/mcp ... Install it: `npm install -g @zkproofport-ai/mcp`');
    };
    const { cmds, calls } = build({ spawner });
    await expect(cmds.loginWithGoogle()).rejects.toThrow(/needs @zkproofport-ai\/mcp/);
    // challenge was created; no spawn retried past the resolution failure and no verify happened
    expect(calls.some((c) => c.method === 'request' && c.args[0] === '/api/auth/verify/ai')).toBe(false);
  });

  it('device-code timeout: bounded wait + spawn retry (2 attempts), surfaces stderr', async () => {
    const children: FakeChild[] = [];
    const spawner: ProveSpawner = () => {
      const child = new FakeChild();
      children.push(child);
      // Emit noise but never the Open:/Code: lines → device info never ready.
      setTimeout(() => child.emitStderr('  contacting Google...\n'), 5);
      return child;
    };
    const { cmds } = build({ spawner });
    await expect(cmds.loginWithGoogle({ timeoutMs: 250 })).rejects.toThrow(/failed after 2 attempts/i);
    expect(children).toHaveLength(2); // retried once
    expect(children.every((c) => c.killed)).toBe(true); // stuck children killed
  });

  it('prove.js non-zero exit → error carries the FULL child output (no truncation)', async () => {
    const children: FakeChild[] = [];
    const spawner: ProveSpawner = () => {
      const child = new FakeChild();
      children.push(child);
      setTimeout(() => child.emitStderr(DEVICE_STDERR), 10);
      setTimeout(() => {
        child.emitStderr('FATAL: google denied authorization (full detail here)\n');
        child.exit(1);
      }, 40);
      return child;
    };
    const { cmds } = build({ spawner });
    await expect(cmds.loginWithGoogle()).rejects.toThrow(/exit 1.*google denied authorization \(full detail here\)/s);
  });

  it('unparseable proof JSON on stdout → error includes the raw stdout', async () => {
    const { spawner } = happySpawner(DEVICE_STDERR, 'not-json-at-all', 0);
    const { cmds } = build({ spawner });
    await expect(cmds.loginWithGoogle()).rejects.toThrow(/Failed to parse proof JSON.*not-json-at-all/s);
  });

  it('verify/ai non-200 → throws the server error body (rest.request rejects)', async () => {
    const { spawner } = happySpawner();
    const { cmds } = build({
      spawner,
      verify: () => {
        throw new Error('POST /api/auth/verify/ai → 400: {"error":"Scope mismatch"}');
      },
    });
    await expect(cmds.loginWithGoogle()).rejects.toThrow(/400.*Scope mismatch/);
  });

  it('verify/ai 200 but no token → throws the server error (or a clear fallback)', async () => {
    const { spawner } = happySpawner();
    const { cmds } = build({ spawner, verify: { error: 'nullifier extraction failed' } });
    await expect(cmds.loginWithGoogle()).rejects.toThrow(/nullifier extraction failed/);
  });

  it('challenge missing challengeId/scope → throws before any spawn', async () => {
    const spy = vi.fn();
    const spawner: ProveSpawner = () => {
      spy();
      return new FakeChild();
    };
    const { cmds } = build({ spawner, challenge: { expiresIn: 300 } });
    await expect(cmds.loginWithGoogle()).rejects.toThrow(/did not return a challengeId \+ scope/);
    expect(spy).not.toHaveBeenCalled();
  });
});
