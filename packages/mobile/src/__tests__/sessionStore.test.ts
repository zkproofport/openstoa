import { describe, it, expect, beforeEach } from 'vitest';
import { useOpenStoaSession } from '../stores/sessionStore';

// Snapshot the pristine initial state so we can restore between tests.
// (Zustand stores are module-level singletons; without a reset the order of
// tests would matter and that's a bug-class we want to avoid.)
const INITIAL_STATE = useOpenStoaSession.getState();

beforeEach(() => {
  useOpenStoaSession.setState({
    mode: 'unknown',
    token: null,
    userId: null,
    nickname: null,
    needsNickname: false,
    expiresAt: null,
  });
});

describe('sessionStore — boot/auth/guest mode machine', () => {
  // ── Matrix row 1: initial state ──────────────────────────────────────────
  it('initial state has mode=unknown and all fields null/false', () => {
    // Use a fresh selector against the live store post-beforeEach reset.
    const s = useOpenStoaSession.getState();
    expect(s.mode).toBe('unknown');
    expect(s.token).toBeNull();
    expect(s.userId).toBeNull();
    expect(s.nickname).toBeNull();
    expect(s.needsNickname).toBe(false);
    expect(s.expiresAt).toBeNull();
  });

  it('the module exports the initial state we expect (sanity)', () => {
    // Document the canonical defaults; if a future refactor changes them this
    // test fails loudly instead of letting the state machine drift silently.
    expect(INITIAL_STATE.mode).toBe('unknown');
    expect(INITIAL_STATE.token).toBeNull();
    expect(INITIAL_STATE.userId).toBeNull();
    expect(INITIAL_STATE.nickname).toBeNull();
    expect(INITIAL_STATE.needsNickname).toBe(false);
    expect(INITIAL_STATE.expiresAt).toBeNull();
  });

  // ── Matrix row 2: setSession() ───────────────────────────────────────────
  it('setSession() flips mode → authenticated and populates token/userId', () => {
    useOpenStoaSession.getState().setSession({
      token: 'jwt.abc.def',
      userId: 'nullifier-0xabc',
      nickname: 'alice',
      needsNickname: false,
      expiresAt: 1234567890,
    });
    const s = useOpenStoaSession.getState();
    expect(s.mode).toBe('authenticated');
    expect(s.token).toBe('jwt.abc.def');
    expect(s.userId).toBe('nullifier-0xabc');
    expect(s.nickname).toBe('alice');
    expect(s.needsNickname).toBe(false);
    expect(s.expiresAt).toBe(1234567890);
  });

  it('setSession() with no optional fields defaults nickname=null, needsNickname=false, expiresAt=null', () => {
    useOpenStoaSession.getState().setSession({
      token: 'jwt.token.only',
      userId: 'nullifier-0xdef',
    });
    const s = useOpenStoaSession.getState();
    expect(s.mode).toBe('authenticated');
    expect(s.token).toBe('jwt.token.only');
    expect(s.userId).toBe('nullifier-0xdef');
    expect(s.nickname).toBeNull();
    expect(s.needsNickname).toBe(false);
    expect(s.expiresAt).toBeNull();
  });

  it('setSession() with needsNickname=true records that the nickname needs setting', () => {
    useOpenStoaSession.getState().setSession({
      token: 't',
      userId: 'u',
      nickname: 'anon_abcdef12',
      needsNickname: true,
    });
    const s = useOpenStoaSession.getState();
    expect(s.mode).toBe('authenticated');
    expect(s.needsNickname).toBe(true);
    expect(s.nickname).toBe('anon_abcdef12');
  });

  it('setSession() called after setGuest() resets the mode to authenticated', () => {
    useOpenStoaSession.getState().setGuest();
    expect(useOpenStoaSession.getState().mode).toBe('guest');
    useOpenStoaSession.getState().setSession({ token: 't', userId: 'u' });
    expect(useOpenStoaSession.getState().mode).toBe('authenticated');
    expect(useOpenStoaSession.getState().token).toBe('t');
  });

  // ── Matrix row 3: setGuest() ─────────────────────────────────────────────
  it('setGuest() sets mode=guest and forces token/userId/nickname to null', () => {
    // First seed an authenticated session so we can confirm setGuest wipes it.
    useOpenStoaSession.getState().setSession({
      token: 'stale.jwt',
      userId: 'leftover-user',
      nickname: 'previousnick',
      needsNickname: false,
      expiresAt: 99,
    });
    useOpenStoaSession.getState().setGuest();
    const s = useOpenStoaSession.getState();
    expect(s.mode).toBe('guest');
    expect(s.token).toBeNull();
    expect(s.userId).toBeNull();
    expect(s.nickname).toBeNull();
    expect(s.needsNickname).toBe(false);
    expect(s.expiresAt).toBeNull();
  });

  it('setGuest() from the initial unknown state is a clean transition (idempotent)', () => {
    useOpenStoaSession.getState().setGuest();
    useOpenStoaSession.getState().setGuest();
    const s = useOpenStoaSession.getState();
    expect(s.mode).toBe('guest');
    expect(s.token).toBeNull();
  });

  // ── Matrix row 4: clear() ────────────────────────────────────────────────
  it('clear() resets mode → unknown from authenticated', () => {
    useOpenStoaSession.getState().setSession({
      token: 't',
      userId: 'u',
      nickname: 'n',
    });
    useOpenStoaSession.getState().clear();
    const s = useOpenStoaSession.getState();
    expect(s.mode).toBe('unknown');
    expect(s.token).toBeNull();
    expect(s.userId).toBeNull();
    expect(s.nickname).toBeNull();
    expect(s.needsNickname).toBe(false);
    expect(s.expiresAt).toBeNull();
  });

  it('clear() resets mode → unknown from guest', () => {
    useOpenStoaSession.getState().setGuest();
    useOpenStoaSession.getState().clear();
    expect(useOpenStoaSession.getState().mode).toBe('unknown');
  });

  // ── setNickname (touched by edit-profile / nickname picker flow) ─────────
  it('setNickname() updates nickname and clears needsNickname', () => {
    useOpenStoaSession.getState().setSession({
      token: 't',
      userId: 'u',
      nickname: 'anon_deadbeef',
      needsNickname: true,
    });
    useOpenStoaSession.getState().setNickname('alice');
    const s = useOpenStoaSession.getState();
    expect(s.nickname).toBe('alice');
    expect(s.needsNickname).toBe(false);
    // setNickname must NOT change auth mode.
    expect(s.mode).toBe('authenticated');
    expect(s.token).toBe('t');
  });

  // ── Hostile / empty / boundary input ─────────────────────────────────────
  it('setSession() with empty-string token still flips mode to authenticated (no validation in store)', () => {
    // The store is dumb — validation lives in the API client / OpenStoaApp.
    // We document the contract here so a future "treat empty string as null"
    // refactor is caught by this test.
    useOpenStoaSession.getState().setSession({ token: '', userId: '' });
    expect(useOpenStoaSession.getState().mode).toBe('authenticated');
    expect(useOpenStoaSession.getState().token).toBe('');
  });

  it('setSession() with expiresAt explicitly null is preserved as null', () => {
    useOpenStoaSession.getState().setSession({
      token: 't',
      userId: 'u',
      expiresAt: null,
    });
    expect(useOpenStoaSession.getState().expiresAt).toBeNull();
  });
});
