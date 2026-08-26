/**
 * Where the recovery sheet gets its facts and its key.
 *
 * SPLIT OUT SO THE DECISION STAYS TESTABLE. `useFirstRunRecovery` decides when
 * to ask and guarantees one creation per launch; it takes those things as
 * arguments so it can be driven against twenty launches without a network, a
 * keychain or a renderer. This file is the half that touches all three.
 *
 * WHAT "FIRST RUN" MEANS HERE. Not "the account is new" — a new PHONE for an old
 * account has the same problem, and an old phone whose store was wiped has it
 * too. It means this install has no recovery mark yet, which is exactly the
 * population that has never been shown a key on this device.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as km from '../crypto/keyManager';
import { keyBackupHttp, getDeviceMasterKey } from '../crypto/mobileTransport';
import { useOpenStoaClient } from './useOpenStoaClient';
import { useHost } from '@openstoa/miniapp-bridge';
import { RECOVERY_SHOWN_KEY } from '../lib/firstRunRecovery';
import type { BackupState } from '../lib/firstRunRecovery';

export interface RecoveryCodeSource {
  /** Null until the server has answered. Nothing is decided before then. */
  backups: BackupState | null;
  isFirstRun: boolean;
  createCode: () => Promise<string>;
}

export function useRecoveryCodeSource(authenticated: boolean): RecoveryCodeSource {
  const client = useOpenStoaClient();
  const host = useHost();
  const [backups, setBackups] = useState<BackupState | null>(null);
  const [isFirstRun, setIsFirstRun] = useState(false);

  const http = useMemo(() => keyBackupHttp(client), [client]);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;

    void (async () => {
      /*
       * A FAILED LOOKUP LEAVES `backups` NULL, and null means "do not ask yet".
       *
       * Guessing either way is worse. Guess "no backup" and an account that has
       * a key is shown the sheet, and creating a second wrap REPLACES the one
       * they may have written down months ago. Guess "has backup" and an
       * account with nothing is never asked. Staying quiet until the server
       * answers costs one launch.
       */
      try {
        const state = await http.getBackup();
        if (cancelled) return;
        setBackups({
          hasRecoveryWrap: !!state.wrappedMaster,
          hasPasskey: (state.passkeys?.length ?? 0) > 0,
        });
      } catch {
        // Leave it null. The next launch asks again.
      }

      try {
        const mark = await host.localStore?.getItem(RECOVERY_SHOWN_KEY);
        if (!cancelled) setIsFirstRun(!mark);
      } catch {
        /*
         * An unreadable mark is treated as a first run — the direction that
         * asks. Asking twice costs a dismissed sheet; not asking costs
         * everything the account cannot get back.
         */
        if (!cancelled) setIsFirstRun(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authenticated, http, host.localStore]);

  const createCode = useCallback(async () => {
    const secureStore = host.secureStore;
    if (!secureStore) throw new Error('Secure storage unavailable on this device.');
    const mk = await getDeviceMasterKey(secureStore);
    return km.backupWithRecoveryCode(mk, http.postRecovery);
  }, [host.secureStore, http]);

  return { backups, isFirstRun, createCode };
}
