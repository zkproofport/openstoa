/**
 * The confirmation in front of the two erase actions, and the report after.
 *
 * DRAWS ONLY. What to ask, and how hard to ask it, is decided by
 * `lib/deviceData.eraseConfirm`; what actually got deleted is reported by
 * `lib/deviceDataErase`. Same split as `FirstRunRecoverySheet` and
 * `DeviceTakeoverSheet`, and for the same reason: the decision has to be
 * testable without a renderer, and the renderer must not be able to quietly
 * disagree with it.
 *
 * THE SECOND CONFIRMATION IS NOT A DOUBLE-CHECK. It appears for exactly one
 * case — a full erase with no key backup on file — and the two steps say
 * different things. The first is about intent ("erase this device"). The second
 * is about a fact the person cannot verify from the phone in their hand: that
 * nothing outside this device can ever open these rooms again. Repeating the
 * same sentence twice would train people to tap through it; this asks a
 * different question, and the destructive button is the only one that moves.
 *
 * THE REPORT IS PART OF THE FEATURE, not a courtesy. A host binary without the
 * store capabilities this needs (`removeItem` / `getAllKeys`) cannot delete
 * anything, and the failure is invisible from the outside — the sheet closes,
 * nothing changes, and the person believes their keys are gone. So a run that
 * could not complete says so, in the same sheet, before it can be dismissed.
 */
import React from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../theme/ThemeContext';
import { TYPE_SCALE, RADIUS, TOUCH_TARGET_MIN } from '../theme';
import type { EraseConfirm } from '../lib/deviceData';
import type { EraseReport } from '../lib/deviceDataErase';
import { eraseWasBlocked, eraseWasComplete } from '../lib/deviceDataErase';

/** Where the flow is. The sheet is closed at `null`. */
export type DeviceDataStep =
  /**
   * Open, but still finding out whether a backup exists.
   *
   * The sheet used to wait for that answer before opening at all, so on a slow
   * link a destructive control looked simply dead — pressed twice, nothing,
   * both times. Opening first and filling the answer in second is what makes a
   * press visibly land. Nothing can be confirmed from here; the only control is
   * the way out.
   */
  | 'checking'
  /** First confirmation. */
  | 'confirm'
  /** Second confirmation — only reachable when `confirm.requiresSecondConfirm`. */
  | 'confirm-final'
  /** Deleting. */
  | 'running'
  /** Done, with a report to show. */
  | 'done';

export interface DeviceDataSheetProps {
  /** Null closes the sheet. */
  step: DeviceDataStep | null;
  /** What is being asked. Null closes the sheet. */
  confirm: EraseConfirm | null;
  /** Present at `done`. */
  report?: EraseReport | null;
  /** Advance: confirm → confirm-final (if required) → running. */
  onProceed: () => void;
  /** Back out. Also the only action at `done`. */
  onClose: () => void;
}

export default function DeviceDataSheet({
  step,
  confirm,
  report,
  onProceed,
  onClose,
}: DeviceDataSheetProps) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();

  // `confirm` is absent while the backup answer is still on its way, and the
  // sheet must be up by then — that wait is exactly when a person needs to see
  // that their press did something.
  if (!step || (step !== 'checking' && !confirm)) return null;

  const styles = makeStyles(colors);
  const destructive = confirm?.scope === 'device';

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <ScrollView contentContainerStyle={styles.content}>
            {step === 'checking' ? (
              <>
                <Text style={styles.title}>{t('openstoa.deviceData.checking')}</Text>
                <ActivityIndicator color={colors.brand.primary} />
                <TouchableOpacity style={styles.plain} onPress={onClose}>
                  <Text style={styles.plainText}>{t('openstoa.common.cancel')}</Text>
                </TouchableOpacity>
              </>
            ) : step === 'done' && report ? (
              <Report report={report} styles={styles} t={t} onClose={onClose} />
            ) : step === 'running' ? (
              <>
                <Text style={styles.title}>{t('openstoa.deviceData.running')}</Text>
                <ActivityIndicator color={colors.brand.primary} />
              </>
            ) : step === 'confirm-final' ? (
              <>
                {/*
                  * A DIFFERENT question, not the same one again. The first step
                  * asked whether to erase; this one states what cannot be
                  * undone afterwards, because there is no backup that could
                  * undo it.
                  */}
                <Text style={styles.title}>
                  {t('openstoa.deviceData.eraseDevice.finalTitle')}
                </Text>
                <Text style={styles.danger} accessibilityRole="alert">
                  {t('openstoa.deviceData.eraseDevice.finalBody')}
                </Text>
                <TouchableOpacity
                  style={[styles.primary, styles.primaryDanger]}
                  onPress={onProceed}
                  accessibilityRole="button"
                >
                  <Text style={styles.primaryText}>
                    {t('openstoa.deviceData.eraseDevice.finalAction')}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.plain} onPress={onClose} accessibilityRole="button">
                  <Text style={styles.plainText}>{t('openstoa.common.cancel')}</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.title}>{t(confirm!.titleKey)}</Text>
                <Text style={destructive ? styles.warning : styles.body}>
                  {t(confirm!.bodyKey, confirm!.bodyValues)}
                </Text>
                <TouchableOpacity
                  style={[styles.primary, destructive && styles.primaryDanger]}
                  onPress={onProceed}
                  accessibilityRole="button"
                >
                  <Text style={styles.primaryText}>
                    {t(
                      confirm!.scope === 'cache'
                        ? 'openstoa.deviceData.clearCache.action'
                        : 'openstoa.deviceData.eraseDevice.action',
                    )}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.plain} onPress={onClose} accessibilityRole="button">
                  <Text style={styles.plainText}>{t('openstoa.common.cancel')}</Text>
                </TouchableOpacity>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/**
 * What happened, in the three ways it can have happened.
 *
 * The order matters. BLOCKED is checked first because it is the only outcome
 * where nothing at all was removed, and it is the only one with a cause the
 * person can act on ("this version of the app cannot do it"). A partial run is
 * second. Only a run with no gaps at all is called complete.
 */
function Report({
  report,
  styles,
  t,
  onClose,
}: {
  report: EraseReport;
  styles: ReturnType<typeof makeStyles>;
  t: (key: string, values?: Record<string, string | number>) => string;
  onClose: () => void;
}) {
  const blocked = eraseWasBlocked(report);
  const complete = eraseWasComplete(report);

  return (
    <>
      <Text style={styles.title}>
        {t(
          blocked
            ? 'openstoa.deviceData.result.blockedTitle'
            : complete
              ? 'openstoa.deviceData.result.doneTitle'
              : 'openstoa.deviceData.result.partialTitle',
        )}
      </Text>
      <Text
        style={blocked || !complete ? styles.warning : styles.body}
        accessibilityRole={blocked ? 'alert' : undefined}
      >
        {t(
          blocked
            ? 'openstoa.deviceData.result.blockedBody'
            : complete
              ? 'openstoa.deviceData.result.doneBody'
              : 'openstoa.deviceData.result.partialBody',
        )}
      </Text>

      {/*
        * Counts, not a spinner that turned into a checkmark. "Removed 0 items"
        * is the single most useful thing this screen can say when something is
        * wrong, and it is invisible unless the numbers are shown.
        */}
      <Text style={styles.counts}>
        {t('openstoa.deviceData.result.counts', {
          keys: report.localRemoved + report.secureRemoved,
          files: report.mediaRemoved,
          kept: report.localKept,
        })}
      </Text>

      <TouchableOpacity style={styles.primary} onPress={onClose} accessibilityRole="button">
        <Text style={styles.primaryText}>{t('openstoa.common.done')}</Text>
      </TouchableOpacity>
    </>
  );
}

function makeStyles(colors: ReturnType<typeof useThemeColors>['colors']) {
  return StyleSheet.create({
    backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
    sheet: {
      backgroundColor: colors.background.primary,
      borderTopLeftRadius: RADIUS.modal,
      borderTopRightRadius: RADIUS.modal,
      maxHeight: '85%',
    },
    content: { padding: 20, gap: 14 },
    title: { fontSize: TYPE_SCALE.headingSmall, fontWeight: '700', color: colors.text.primary },
    body: { fontSize: TYPE_SCALE.body, color: colors.text.secondary, lineHeight: 22 },
    warning: { fontSize: TYPE_SCALE.body, color: colors.status.warning, lineHeight: 22 },
    danger: { fontSize: TYPE_SCALE.body, color: colors.status.danger, lineHeight: 22 },
    counts: { fontSize: TYPE_SCALE.bodySmall, color: colors.text.secondary },
    primary: {
      minHeight: TOUCH_TARGET_MIN,
      borderRadius: RADIUS.card,
      backgroundColor: colors.brand.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    primaryDanger: { backgroundColor: colors.status.danger },
    primaryText: { fontSize: TYPE_SCALE.body, fontWeight: '700', color: colors.text.inverted },
    plain: { minHeight: TOUCH_TARGET_MIN, alignItems: 'center', justifyContent: 'center' },
    plainText: { fontSize: TYPE_SCALE.body, color: colors.text.secondary },
  });
}
