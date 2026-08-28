/**
 * Profile → Device data. Two buttons that look alike and are not.
 *
 *   Clear cache          — reversible. Deletes copies this device can fetch
 *                          again: decrypted message bodies, the room-history
 *                          cache, the room list, downloaded pictures. Costs one
 *                          slow reload.
 *   Erase from device    — irreversible. Deletes the keys as well, so this
 *                          device can never open its rooms again unless a
 *                          backup exists somewhere else.
 *
 * WHAT THIS FILE IS AND IS NOT. It gathers facts (is there a backup, which
 * topics does this account have, what is this device's MLS identity), hands
 * them to the pure deciders in `lib/deviceData.ts`, runs `lib/deviceDataErase`,
 * and draws the result through `DeviceDataSheet`. It contains no rule about
 * which key survives which action — that rule is one function, `keyVerdict`,
 * and it is tested without a renderer.
 *
 * WHY THE TOPIC IDS MATTER HERE. The Keychain cannot be enumerated, so a full
 * erase has to name every secure key. Two families are derived from topic ids
 * and exist nowhere else: `mls.state.<identity>.<topicId>` and
 * `tak.root.orphan.<topicId>` — the latter deliberately absent from the TAK
 * manifest, so a wipe driven by the manifest alone would leave behind the one
 * key family no backup could ever have replaced. Both the server's list and the
 * offline cache are consulted and unioned: a topic missing from either source
 * is a key that survives an erase.
 *
 * NOT ON THE SIGN-IN SCREEN, deliberately. Someone who cannot sign in is
 * exactly the person most likely to reach for "erase everything", and it is the
 * one moment at which erasing costs the most — their keys are the only copy and
 * they have not yet been told that.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useHost } from '@openstoa/miniapp-bridge';
import { useOpenStoaClient } from '../../hooks/useOpenStoaClient';
import { useOpenStoaSession } from '../../stores/sessionStore';
import { useThemeColors } from '../../theme/ThemeContext';
import type { ThemeColors } from '../../theme/colors';
import { RADIUS, TOUCH_TARGET_MIN, TYPE_SCALE } from '../../theme/tokens';
import DeviceDataSheet, { type DeviceDataStep } from '../../components/DeviceDataSheet';
import {
  type EraseConfirm,
  type EraseScope,
  eraseConfirm,
  secureEraseKeys,
} from '../../lib/deviceData';
import { eraseDeviceData, type EraseGap, type EraseReport } from '../../lib/deviceDataErase';
import { readCachedChatList } from '../../lib/chatListCache';
import { hostAttachmentFs } from '../../lib/attachmentFs';
import { measureDeviceData, formatBytes, type DeviceDataSize } from '../../lib/deviceDataSize';
import {
  getTakSessionStore,
  keyBackupHttp,
  readDeviceIdentity,
  report as narrate,
  resetChatCryptoState,
} from '../../crypto/mobileTransport';

interface TopicsListResponse {
  topics?: Array<{ id?: unknown }>;
}

export function DeviceStorageScreen() {
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  const { t } = useTranslation();
  const host = useHost();
  const client = useOpenStoaClient();
  const queryClient = useQueryClient();
  const userId = useOpenStoaSession((s) => s.userId);

  const [step, setStep] = useState<DeviceDataStep | null>(null);
  const [confirm, setConfirm] = useState<EraseConfirm | null>(null);
  const [report, setReport] = useState<EraseReport | null>(null);

  const fs = useMemo(() => hostAttachmentFs(), []);

  /*
   * The figure, measured when the screen opens and again after an erase.
   *
   * Not on every render: it reads every value in the store, which is the price
   * of a real number rather than an estimate from a key count. `null` while it
   * is being read, so the screen shows nothing rather than a zero that would
   * read as "nothing to clear".
   */
  const [size, setSize] = useState<DeviceDataSize | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const m = await measureDeviceData({ local: host.localStore, fs }, 'cache');
      // Logged unconditionally: "the figure is missing" and "the figure is zero"
      // look identical on a device, and only one of them is a bug in here.
      console.log('[DEVICEDATA]', 'size', JSON.stringify(m));
      if (!cancelled) setSize(m);
    })();
    return () => {
      cancelled = true;
    };
    // `report` is a dependency so the number is re-read after an erase — a stale
    // figure showing the space that was just freed is worse than none.
  }, [host.localStore, fs, report]);

  /**
   * Every topic this device could hold keys for.
   *
   * The server's answer is the authoritative one and the cached list is the
   * offline one; the UNION is used because a topic that appears in neither is a
   * `mls.state` / `tak.root.orphan` pair that outlives the erase. A server that
   * cannot be reached is not a reason to refuse — it is a reason to fall back
   * to the cache and to keep the failure visible in the report.
   */
  const collectTopicIds = useCallback(async (): Promise<{ ids: string[]; listed: boolean }> => {
    const ids = new Set<string>();
    let listed = true;
    try {
      const res = await client.get<TopicsListResponse>('/api/topics?filter=joined&limit=200');
      for (const topic of res?.topics ?? []) {
        if (typeof topic?.id === 'string' && topic.id !== '') ids.add(topic.id);
      }
    } catch (e) {
      /*
       * Offline, or the session expired. The cache below still names rooms, and
       * an ErrorModal here would be wrong: this is a best-effort widening of a
       * key list, not the action the person asked for.
       *
       * BUT IT IS CARRIED OUT, not just logged. A room that is neither on the
       * server list nor in the chat-list cache keeps its `mls.state.*` and
       * `tak.root.*` entries in the Keychain, and until 2026-08-27 the report
       * said nothing — an erase run in a lift came back looking complete. The
       * flag rides all the way to `EraseReport.gaps` so the screen can say the
       * one true thing: not everything was found.
       */
      console.warn('[DeviceStorage] could not list topics from the server', e);
      listed = false;
    }
    try {
      for (const room of await readCachedChatList(host.localStore, userId)) ids.add(room.id);
    } catch {
      // `readCachedChatList` does not throw; this is belt and braces so a
      // storage fault can never stop the erase from running at all.
    }
    return { ids: [...ids], listed };
  }, [client, host.localStore, userId]);

  /**
   * The secure-store keys a full erase must name.
   *
   * `diagnoseKeychain` is used rather than `exportKeychain` because only the
   * NAMES are wanted: the export decrypts and fingerprint-checks every root,
   * which can skip keys it cannot verify — and a key skipped there would be a
   * key left on the device here. `diagnose` also probes the orphan roots for
   * each topic id, which is the only way to see a root the manifest never
   * recorded.
   */
  const collectSecureKeys = useCallback(async (): Promise<{
    keys: string[];
    gaps: EraseGap[];
  }> => {
    const { ids: topicIds, listed } = await collectTopicIds();
    const identity = await readDeviceIdentity(host.secureStore);
    const gaps: EraseGap[] = listed ? [] : ['topics-not-listed'];

    let takKeys: string[] = [];
    try {
      const d = await getTakSessionStore(client, host.secureStore, host.localStore).diagnoseKeychain(
        topicIds,
      );
      takKeys = [...d.manifest, ...d.unlisted];
    } catch (e) {
      /*
       * A manifest we cannot read costs archive keys we cannot name. The erase
       * still runs — the derived `tak.root.<t>` names below cover the common
       * case — and the gap is what stops the report claiming completeness it
       * does not have. This comment used to promise that and nothing carried
       * it: `gaps` came back empty and the screen read it as a clean erase.
       */
      console.warn('[DeviceStorage] could not read the TAK manifest', e);
      gaps.push('keychain-not-listed');
    }

    return { keys: secureEraseKeys({ identity, topicIds, takKeys }), gaps };
  }, [client, collectTopicIds, host.localStore, host.secureStore]);

  const ask = useCallback(
    async (scope: EraseScope) => {
      /*
       * NARRATED, and kept.
       *
       * A release build runs Hermes, whose console output never reaches the
       * device log, so a press that does nothing looks identical whether the
       * handler never ran, threw on its first line, or ran to the end and the
       * sheet refused to draw. These lines separated those three when it
       * mattered — the answer was that the press was never arriving — and they
       * cost one batched request on a path somebody takes once.
       */
      narrate('erase/pressed', { scope });
      setReport(null);
      /*
       * The backup facts are fetched at the moment of asking, not held from
       * screen mount. Someone may have just come from Chat recovery and made
       * one, and warning them about a backup they have is how a warning stops
       * being read.
       */
      /*
       * THE SHEET OPENS FIRST, before the answer is asked for.
       *
       * It used to open only once the backup answer came back, so a press did
       * nothing visible for as long as that round trip took — and on a
       * destructive control, nothing visible reads as broken. What follows is a
       * local deletion; there is no reason for a network read to stand between
       * the press and the sheet.
       */
      setConfirm(null);
      setStep('checking');
      narrate('erase/sheetRequested', { scope });

      let facts = { hasBackup: false, backupUpdatedAt: null as number | null };
      if (scope === 'device') {
        try {
          const state = await keyBackupHttp(client).getBackup();
          facts = {
            hasBackup: !!state.wrappedMaster || state.passkeys.length > 0,
            backupUpdatedAt: state.backupUpdatedAt ?? null,
          };
        } catch (e) {
          // Unknown stays unknown, and unknown warns. See `eraseConfirm`.
          console.warn('[DeviceStorage] could not read the backup state', e);
        }
      }
      narrate('erase/facts', { scope, hasBackup: facts.hasBackup });
      setConfirm(eraseConfirm(scope, facts, Date.now()));
      narrate('erase/opened', { scope });
      // Only if the sheet is still the one we opened. Someone who cancelled
      // while the answer was in flight must not have it reopened underneath
      // them by a reply they are no longer waiting for.
      setStep((current) => (current === 'checking' ? 'confirm' : current));
    },
    [client],
  );

  const proceed = useCallback(async () => {
    if (!confirm) return;

    // The second confirmation is a STEP, not a re-render of the first one.
    if (step === 'confirm' && confirm.requiresSecondConfirm) {
      setStep('confirm-final');
      return;
    }

    setStep('running');
    const scope = confirm.scope;
    /*
     * The cache scope names no Keychain entries, so it has neither keys nor the
     * gaps that come from failing to find them.
     */
    const collected = scope === 'device' ? await collectSecureKeys() : { keys: [], gaps: [] };

    const result = await eraseDeviceData(
      { local: host.localStore, secure: host.secureStore, fs, secureKeys: collected.keys },
      scope,
      collected.gaps,
    );

    if (scope === 'device') {
      /*
       * The in-process copies go too, and they go AFTER the stores.
       *
       * Resetting first would let a background write re-create a master_key and
       * persist it into the store we were about to empty — the device would end
       * up freshly keyed with something no backup covers, which looks exactly
       * like a successful erase and is the opposite.
       */
      resetChatCryptoState();
      try {
        await host.logoutFromOpenStoa();
      } catch (e) {
        console.warn('[DeviceStorage] host sign-out failed after the erase', e);
      }
      useOpenStoaSession.getState().clear();
    }

    /*
     * Cached QUERY results are cleared for both scopes. They hold the same
     * decrypted bodies that were just deleted from disk, so leaving them would
     * paint a room the device can no longer open.
     */
    queryClient.clear();

    setReport(result);
    setStep('done');
  }, [client, collectSecureKeys, confirm, fs, host, queryClient, step]);

  const close = useCallback(() => {
    setStep(null);
    setConfirm(null);
  }, []);

  // A press is refused while one is already being handled — a control that
  // looks idle invites a second press, and this one deletes things.
  const busy = step === 'checking' || step === 'running';

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('openstoa.deviceData.clearCache.title')}</Text>
        <Text style={styles.body}>{t('openstoa.deviceData.clearCache.explain')}</Text>
        {/*
          * The reason to tap, in one line: what a clear frees AND what remains.
          * "Frees 4 MB" means something different next to 20 MB than next to 2 GB.
          *
          * Shown when the KEY STORE was measured, even if the media half was not.
          * Those are different failures and only one of them makes a number
          * unsayable — when media cannot be sized its bytes are simply absent
          * from the total rather than guessed at, so the figure understates
          * rather than invents. A store that could not be read at all renders
          * NOTHING, because "0 KB" reads as "nothing to clear".
          */}
        {size &&
          !size.gaps.includes('local-absent') &&
          !size.gaps.includes('local-unlistable') && (
            <Text style={styles.size}>
              {t('openstoa.deviceData.size.line', {
                free: formatBytes(size.eraseBytes + size.mediaBytes),
                keep: formatBytes(size.keepBytes),
              })}
            </Text>
          )}
        <TouchableOpacity
          style={[styles.action, busy && styles.actionBusy]}
          onPress={() => void ask('cache')}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
        >
          <Text style={styles.actionText}>{t('openstoa.deviceData.clearCache.action')}</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('openstoa.deviceData.eraseDevice.title')}</Text>
        <Text style={styles.body}>{t('openstoa.deviceData.eraseDevice.explain')}</Text>
        {/*
          * The way OUT of needing this warning, next to the warning itself. A
          * screen that only says "you may lose everything" and does not say
          * where to go is a dead end.
          */}
        <Text style={styles.warning}>{t('openstoa.deviceData.eraseDevice.backupFirst')}</Text>
        <TouchableOpacity
          style={[styles.action, styles.actionDanger, busy && styles.actionBusy]}
          onPress={() => void ask('device')}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
        >
          <Text style={[styles.actionText, styles.actionDangerText]}>
            {t('openstoa.deviceData.eraseDevice.action')}
          </Text>
        </TouchableOpacity>
      </View>

      </ScrollView>

      {/*
        OUTSIDE the scrolling area.
        Moved here while chasing a press that appeared to do nothing; that turned
        out to be the test harness missing the button, not the nesting. It stays
        because this is where a sheet covering the screen belongs — it does not
        scroll with the content.
      */}
      <DeviceDataSheet
        step={step}
        confirm={confirm}
        report={report}
        onProceed={() => void proceed()}
        onClose={close}
      />
    </View>
  );
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background.secondary },
    actionBusy: { opacity: 0.5 },
    content: { padding: 16, gap: 16 },
    section: {
      backgroundColor: colors.background.primary,
      borderRadius: RADIUS.card,
      padding: 16,
      gap: 10,
    },
    sectionTitle: {
      fontSize: TYPE_SCALE.headingSmall,
      fontWeight: '700',
      color: colors.text.primary,
    },
    body: { fontSize: TYPE_SCALE.bodySmall, color: colors.text.secondary, lineHeight: 20 },
    warning: { fontSize: TYPE_SCALE.bodySmall, color: colors.status.warning, lineHeight: 20 },
    // Tabular figures so the two numbers line up rather than jitter as they change.
    size: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.secondary,
      lineHeight: 20,
      fontVariant: ['tabular-nums'],
    },
    action: {
      minHeight: TOUCH_TARGET_MIN,
      borderRadius: RADIUS.card,
      borderWidth: 1,
      borderColor: colors.border.default,
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionDanger: { borderColor: colors.status.danger },
    actionText: { fontSize: TYPE_SCALE.body, color: colors.text.primary, fontWeight: '600' },
    actionDangerText: { color: colors.status.danger },
  });
}
