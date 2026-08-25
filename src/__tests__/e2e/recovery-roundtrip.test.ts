/**
 * Losing a phone and getting the rooms back — the whole path, over real HTTP.
 *
 * WHAT THE ANSWER DEPENDS ON. Two things have to be true when someone sets up a
 * new phone: the recovery code still opens `master_key`, and the TAK keychain
 * blob that `master_key` opens is CURRENT. The first is a fixed fact — the code
 * never changes, so it is written down once. The second is a snapshot, and a
 * snapshot taken before someone joined three more rooms recovers three fewer
 * rooms. That is the whole reason the second-device warning carries
 * `backupUpdatedAt`.
 *
 * WHY OVER HTTP. The crypto core has unit tests. What they cannot show is that
 * the wrapped bytes SURVIVE the round trip: base64 encoding at two boundaries,
 * a `bytea` column, a size cap, an auth check, and a route that could store the
 * wrong field and still answer 201. Every one of those sits between the two
 * halves of "back up" and "recover", and a mistake in any of them is invisible
 * until someone actually needs their messages back.
 *
 * NO REAL DEVICE IS NEEDED and that is the point: a "fresh device" here is
 * simply a caller that holds nothing but the recovery code, which is exactly
 * what a new phone is.
 *
 * EDGE-CASE MATRIX (CLAUDE.md) → coverage
 *   contract   → code → wrapped master → server → back → the SAME master key
 *   contract   → master key → TAK blob → server → back → the same keychain
 *   integrity  → the WRONG code returns null rather than garbage (no oracle)
 *   integrity  → the server stores ciphertext only — the plaintext master key
 *                never appears in any response
 *   authz      → one account cannot read another's backup; a guest cannot read
 *                any
 *   boundary   → no backup yet reads as null, not as an error
 *   empty      → an empty / malformed body is refused
 *   hostile    → a non-base64 blob is refused rather than stored
 *   race       → re-uploading replaces rather than accumulating
 */
import { describe, it, expect } from 'vitest';
import { getBaseUrl } from './helpers';
import {
  generateMasterKey,
  generateRecoveryCode,
  wrapMasterKeyWithRecoveryCode,
  unwrapMasterKeyWithRecoveryCode,
  deriveTakBackupKey,
  sealBlob,
  openBlob,
  b64,
} from '../../../packages/mls/src/keyBackup';

const BASE = getBaseUrl();

async function signIn(tag: string): Promise<{ token: string; userId: string }> {
  const res = await fetch(`${BASE}/api/auth/dev-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-openstoa-device-kind': 'mobile',
      'x-openstoa-device-id': `e2e-rec-${tag}-${Math.random().toString(36).slice(2, 10)}`,
    },
    body: JSON.stringify({
      nickname: `e2e_rec_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    }),
  });
  const body = (await res.json()) as { token: string; userId: string };
  return body;
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('the recovery code opens the account on a new device', () => {
  it('CONTRACT: code → wrapped master → server → back → the SAME master key', async () => {
    const { token } = await signIn('roundtrip');

    // ── The old phone, setting recovery up.
    const master = generateMasterKey();
    const code = generateRecoveryCode();
    const wrapped = await wrapMasterKeyWithRecoveryCode(code, master);

    const put = await fetch(`${BASE}/api/keys/backup`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({ type: 'recovery', wrappedMaster: wrapped }),
    });
    expect(put.status).toBe(201);

    // ── The new phone. It holds NOTHING but the code and the session.
    const got = await fetch(`${BASE}/api/keys/backup`, { headers: auth(token) });
    expect(got.status).toBe(200);
    const { wrappedMaster } = (await got.json()) as { wrappedMaster: string | null };
    expect(wrappedMaster).toBeTruthy();

    const recovered = await unwrapMasterKeyWithRecoveryCode(code, wrappedMaster!);
    expect(recovered).not.toBeNull();
    expect(b64(recovered!)).toBe(b64(master));
  });

  it('CONTRACT: the recovered master key opens the TAK keychain blob', async () => {
    /*
     * The second half, and the one that actually returns the ROOMS. The master
     * key alone is an empty account; what makes history readable again is the
     * keychain blob it decrypts.
     */
    const { token } = await signIn('tak');
    const master = generateMasterKey();
    const code = generateRecoveryCode();

    // The old phone seals its keychain under a key derived from the master.
    const keychain = JSON.stringify({
      'tak.root.topic-1': 'AAECAwQFBgcICQoLDA0ODw==',
      'tak.epoch.topic-1.3': 'EBESExQVFhcYGRobHB0eHw==',
    });
    const sealed = await sealBlob(await deriveTakBackupKey(master), keychain);

    expect(
      (
        await fetch(`${BASE}/api/keys/backup`, {
          method: 'POST',
          headers: auth(token),
          body: JSON.stringify({
            type: 'recovery',
            wrappedMaster: await wrapMasterKeyWithRecoveryCode(code, master),
          }),
        })
      ).status,
    ).toBe(201);

    expect(
      (
        await fetch(`${BASE}/api/keys/tak-backup`, {
          method: 'POST',
          headers: auth(token),
          body: JSON.stringify({ ciphertext: sealed }),
        })
      ).status,
    ).toBe(201);

    // ── New phone: code → master → keychain.
    const wrapped = (
      (await (await fetch(`${BASE}/api/keys/backup`, { headers: auth(token) })).json()) as {
        wrappedMaster: string;
      }
    ).wrappedMaster;
    const master2 = await unwrapMasterKeyWithRecoveryCode(code, wrapped);
    expect(master2).not.toBeNull();

    const ct = (
      (await (await fetch(`${BASE}/api/keys/tak-backup`, { headers: auth(token) })).json()) as {
        ciphertext: string;
      }
    ).ciphertext;
    const opened = await openBlob(await deriveTakBackupKey(master2!), ct);
    expect(opened).toBe(keychain);
  });

  it('RACE: re-uploading REPLACES the snapshot rather than accumulating', async () => {
    // The blob has to track the keychain as rooms are joined. If a second
    // upload appended instead of replacing, the newest keys would sit behind
    // the oldest and a recovery would open the wrong thing.
    const { token } = await signIn('replace');
    const master = generateMasterKey();
    const key = await deriveTakBackupKey(master);

    for (const payload of ['{"v":1}', '{"v":2}', '{"v":3}']) {
      const res = await fetch(`${BASE}/api/keys/tak-backup`, {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ ciphertext: await sealBlob(key, payload) }),
      });
      expect(res.status).toBe(201);
    }

    const ct = (
      (await (await fetch(`${BASE}/api/keys/tak-backup`, { headers: auth(token) })).json()) as {
        ciphertext: string;
      }
    ).ciphertext;
    expect(await openBlob(key, ct)).toBe('{"v":3}');
  });
});

describe('what the server can and cannot do with it', () => {
  it('INTEGRITY: no response ever carries the master key in the clear', async () => {
    const { token } = await signIn('clear');
    const master = generateMasterKey();
    const code = generateRecoveryCode();

    await fetch(`${BASE}/api/keys/backup`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({
        type: 'recovery',
        wrappedMaster: await wrapMasterKeyWithRecoveryCode(code, master),
      }),
    });

    const text = await (await fetch(`${BASE}/api/keys/backup`, { headers: auth(token) })).text();
    // The plaintext key, and the code that opens it, must both be absent.
    expect(text).not.toContain(b64(master));
    expect(text).not.toContain(code);
  });

  it('INTEGRITY: a WRONG code returns null — never garbage, never an oracle', async () => {
    /*
     * AEAD authentication is what makes a low-guess-rate design unnecessary
     * here: a wrong code fails the tag rather than producing plausible bytes,
     * so there is nothing for an attacker to test a guess against beyond the
     * 160 bits themselves.
     */
    const { token } = await signIn('wrongcode');
    const master = generateMasterKey();
    const right = generateRecoveryCode();
    const wrong = generateRecoveryCode();

    await fetch(`${BASE}/api/keys/backup`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify({
        type: 'recovery',
        wrappedMaster: await wrapMasterKeyWithRecoveryCode(right, master),
      }),
    });
    const wrapped = (
      (await (await fetch(`${BASE}/api/keys/backup`, { headers: auth(token) })).json()) as {
        wrappedMaster: string;
      }
    ).wrappedMaster;

    expect(await unwrapMasterKeyWithRecoveryCode(wrong, wrapped)).toBeNull();
    expect(b64((await unwrapMasterKeyWithRecoveryCode(right, wrapped))!)).toBe(b64(master));
  });

  it('AUTHZ: one account cannot read another account\'s backup', async () => {
    const alice = await signIn('alice');
    const bob = await signIn('bob');
    const master = generateMasterKey();

    await fetch(`${BASE}/api/keys/backup`, {
      method: 'POST',
      headers: auth(alice.token),
      body: JSON.stringify({
        type: 'recovery',
        wrappedMaster: await wrapMasterKeyWithRecoveryCode(generateRecoveryCode(), master),
      }),
    });

    // Bob asks with his own session. There is no user parameter to tamper with;
    // the route is scoped to the caller, so the worst he can reach is his own
    // empty row.
    const res = await fetch(`${BASE}/api/keys/backup`, { headers: auth(bob.token) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wrappedMaster: string | null };
    expect(body.wrappedMaster).toBeNull();
  });

  it('AUTHZ: a guest reads nothing', async () => {
    const res = await fetch(`${BASE}/api/keys/backup`);
    expect(res.status).toBe(401);
  });

  it('BOUNDARY: an account with no backup reads as null, not as an error', async () => {
    // The new-device screen asks this before it can offer anything, so an error
    // here would turn "you have no backup" into "something went wrong".
    const { token } = await signIn('empty');
    const res = await fetch(`${BASE}/api/keys/backup`, { headers: auth(token) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { wrappedMaster: string | null }).wrappedMaster).toBeNull();
  });

  it('HOSTILE: a body that is not base64 is refused, not stored', async () => {
    const { token } = await signIn('hostile');
    for (const bad of ['', 'not base64!!', '###']) {
      const res = await fetch(`${BASE}/api/keys/backup`, {
        method: 'POST',
        headers: auth(token),
        body: JSON.stringify({ type: 'recovery', wrappedMaster: bad }),
      });
      expect(res.status, `accepted ${JSON.stringify(bad)}`).toBe(400);
    }
    // And nothing was written by the attempts.
    const got = await fetch(`${BASE}/api/keys/backup`, { headers: auth(token) });
    expect(((await got.json()) as { wrappedMaster: string | null }).wrappedMaster).toBeNull();
  });

  it('EMPTY: a missing body is refused', async () => {
    const { token } = await signIn('nobody');
    const res = await fetch(`${BASE}/api/keys/backup`, {
      method: 'POST',
      headers: auth(token),
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
  });
});
