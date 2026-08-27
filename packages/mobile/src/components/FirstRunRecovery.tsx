/*
 * Mounting the first-run recovery sheet, and filing the copy of the key.
 *
 * WHY THIS FILE EXISTS AT ALL. The three pieces below were each written and
 * each tested, and none of them were connected to the app: `useFirstRunRecovery`
 * decided when to ask, `useRecoveryCodeSource` made the key, and
 * `FirstRunRecoverySheet` drew it, and nothing rendered the sheet. The whole
 * flow was reachable only from its own tests. This is the wiring — deliberately
 * the smallest possible amount of it, so the parts stay testable without a
 * renderer.
 *
 * WHERE IT SITS. Inside the `ready` phase, beside `RecoveryRepairProvider`,
 * wrapping the navigator. Not on a screen: the sheet must reach an account
 * regardless of which tab they land on, and the mini-app opens on the feed.
 *
 * WHEN THE COPY IS FILED — as soon as the key exists, NOT when the person taps
 * "I have saved it". The note in their own room is precisely the copy that
 * survives a dismissal; gating it on the confirmation would file it only for
 * the people who least need it. Same reasoning `RecoveryRepair` gives for
 * filing the no-backup notice ahead of the banner's dismissal check.
 *
 * IT IS FIRE-AND-FORGET AND UNREPORTED. Everything the send can hit is either
 * "a note is already there" or "this device cannot read the room to tell", and
 * neither is worth interrupting somebody who is in the middle of writing a
 * recovery key down. The sheet still holds the key on screen; the copy is a
 * convenience on top of it, never the delivery mechanism.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage } from '@openstoa/api-types';
import { useHost } from '@openstoa/miniapp-bridge';
import { useOpenStoaClient } from '../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../stores/sessionStore';
import { getMlsSessionStore, toDisplayMessageMls, UNREADABLE_BODY } from '../crypto/mobileTransport';
import { refuseUnreadable, scanPersonalRoom, type OpenRow } from '../lib/personalRoomNote';
import { anyIsRecoveryNote, sendRecoveryNote } from '../lib/sendRecoveryNote';
import { useFirstRunRecovery } from '../hooks/useFirstRunRecovery';
import { useRecoveryCodeSource } from '../hooks/useRecoveryCodeSource';
import FirstRunRecoverySheet from './FirstRunRecoverySheet';

type ClipboardModule = typeof import('@react-native-clipboard/clipboard').default;

/**
 * Loaded lazily and allowed to be absent, matching `ChatRoomScreen`: a host app
 * without the native module must still be able to SHOW the key, which is the
 * part that matters. Copy is the convenience.
 */
function loadClipboard(): ClipboardModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('@react-native-clipboard/clipboard') as { default: ClipboardModule }).default;
  } catch {
    return null;
  }
}

export function FirstRunRecoveryProvider({ children }: { children?: React.ReactNode }) {
  const host = useHost();
  const client = useOpenStoaClient();
  const session = useOpenStoaSession();
  const { t } = useTranslation();

  const authenticated = session.mode === 'authenticated';
  const secureStore = host.secureStore;
  const localStore = host.localStore;

  const { backups, isFirstRun, createCode } = useRecoveryCodeSource(authenticated);
  const { prompt, code, error, onStored, onDismiss } = useFirstRunRecovery({
    authenticated,
    store: localStore ?? null,
    backups,
    isFirstRun,
    createCode,
  });

  const onCopy = useCallback((c: string) => {
    loadClipboard()?.setString(c);
  }, []);

  /*
   * Latched by the code itself rather than by a bare boolean. This provider
   * wraps the navigator and is never remounted by tab navigation, so a
   * `useRef(false)` would stay true for the whole app run — and a second account
   * signing in without an app restart would get its key shown but never filed.
   * Keying the latch to the code means: same key, filed once; a different key,
   * filed again.
   */
  const filedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!code || !authenticated || !secureStore) return;
    if (filedFor.current === code) return;
    filedFor.current = code;

    const mls = getMlsSessionStore(client, secureStore, localStore);
    const open: OpenRow = async (topicId, row) =>
      (await toDisplayMessageMls(mls, topicId, row as ChatMessage)).message ?? '';

    void sendRecoveryNote(
      client,
      mls,
      code,
      {
        heading: t('openstoa.firstRunRecovery.noteHeading'),
        warning: t('openstoa.firstRunRecovery.noteWarning'),
      },
      {
        alreadyFiled: async (topicId) => {
          /*
           * Built the same way `sendBackupNotice` builds its own: a row this
           * device cannot decrypt makes the scan inconclusive rather than
           * "absent" (`refuseUnreadable`), and a scan that only reached the
           * newest page proves nothing about a note filed on an account's first
           * day — which is the oldest end of the room. Both stop the write, and
           * `partial` throws rather than returning `true` so a partial read is
           * never recorded as a settled "already there".
           */
          const scan = await scanPersonalRoom(
            client,
            topicId,
            refuseUnreadable(open, UNREADABLE_BODY),
          );
          if (scan.kind === 'partial') {
            throw new Error('personal room history is longer than one scan; cannot prove absence');
          }
          return anyIsRecoveryNote(scan.bodies);
        },
      },
    ).catch(() => {
      // Deliberately silent; see the header.
    });
  }, [code, authenticated, client, secureStore, localStore, t]);

  return (
    <>
      {children}
      <FirstRunRecoverySheet
        prompt={prompt}
        code={code}
        error={error}
        onCopy={onCopy}
        onStored={onStored}
        onDismiss={onDismiss}
      />
    </>
  );
}
