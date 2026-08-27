/*
 * Registering this device's signing key with the account, once per session.
 *
 * WHAT IT BUYS. The server groups install ids by the key they share
 * (`deviceTakeoverGate`), so a phone whose install id changed — a reinstall, a
 * cleared store — stops looking like a second phone and stops triggering "you
 * are about to sign out your other device" against itself. Nothing here decides
 * chat access or trust: a browser can make a keypair too, so a signature proves
 * CONTINUITY, never what kind of thing is holding the key.
 *
 * WHY IT IS A SEPARATE ROUND TRIP and not part of sign-in. The key is proven by
 * signing a server nonce, and sign-in has no nonce to sign. The sign-in request
 * carries the public key as a bare claim, which is all the grouping needs; this
 * is the call that actually WRITES `device_signing_keys` and stamps
 * `last_proved_at`, and it can only run once a session exists.
 *
 * FAILURES ARE SILENT AND THE SESSION IS UNAFFECTED. Every outcome — offline,
 * an expired nonce, a 409 because this install id already registered a
 * different key — leaves the account exactly as usable as it was; the server
 * falls back to the id alone, which is the behaviour that predates keys. A red
 * line here would report a degraded grouping as if the account were broken.
 */
import { useEffect, useRef } from 'react';
import { useHost } from '@openstoa/miniapp-bridge';
import { deviceKeyPair, signChallenge } from '../crypto/deviceKey';
import { useOpenStoaClient } from './useOpenStoaClient';
import { useOpenStoaSession } from '../stores/sessionStore';

interface ProofClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

const PATH = '/api/auth/device/challenge';

/** Prove the key. Exported for tests, which drive it without a renderer. */
export async function proveDevice(
  client: ProofClient,
  store: Parameters<typeof deviceKeyPair>[0],
): Promise<'proved' | 'skipped'> {
  const pair = await deviceKeyPair(store);
  const issued = (await client.get(PATH)) as { nonce?: unknown };
  const nonce = typeof issued?.nonce === 'string' ? issued.nonce : '';
  // A response without a nonce is not something to sign around: answering with
  // an empty challenge would spend an attempt and register nothing.
  if (!nonce) return 'skipped';

  const signature = await signChallenge(store, nonce);
  await client.post(PATH, { nonce, signature, publicKey: pair.publicKey });
  return 'proved';
}

export function useDeviceProof(authenticated: boolean): void {
  const client = useOpenStoaClient();
  const host = useHost();
  const session = useOpenStoaSession();
  const secureStore = host.secureStore;

  /*
   * Latched by account, not by a bare boolean — the same reason `RecoveryRepair`
   * latches that way. This hook lives at the root and is never remounted, so a
   * `useRef(false)` would stay true for the whole app run and a second account
   * signing in without a restart would never register its device.
   */
  const provedFor = useRef<string | null>(null);

  useEffect(() => {
    const userId = session.userId;
    if (!authenticated || !userId || !secureStore) return;
    if (provedFor.current === userId) return;
    provedFor.current = userId;

    void proveDevice(client as unknown as ProofClient, secureStore).catch(() => {
      // Silent by design; see the header.
    });
  }, [authenticated, session.userId, secureStore, client]);
}
