/**
 * The other half of the ask: a member sees who is waiting, and unlocks it.
 *
 * WITHOUT THIS the request flow is a doorbell nobody can hear. The asker taps,
 * a row lands in the database, and no screen anywhere shows it — so the keys
 * never move and the person waits for something that was never going to happen.
 *
 * WHAT A TAP ACTUALLY DOES, and the order matters:
 *   1. `grantMissingTo` seals every epoch the asker is missing to their leaves
 *      and posts them as `tak_bundles` rows. The server cannot open those.
 *   2. Only then does `POST /keys/grant` mark the request answered.
 *
 * Marking first would be the worse failure: the asker stops waiting, the row
 * leaves every member's list, and nothing ever arrives. So a grant that sealed
 * to ZERO leaves is not marked — this device does not hold the missing stretch
 * either, and somebody else has to be the one who answers.
 *
 * WHY IT SITS IN THE ROOM rather than in a settings screen: the person able to
 * help is a member reading the room, and a notification centre nobody opens is
 * where this would go to die.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../theme/ThemeContext';
import { TYPE_SCALE, RADIUS, TOUCH_TARGET_MIN } from '../theme';
import { askKey, type PendingKeyRequest } from '../lib/keyRequest';

export type { PendingKeyRequest };

export interface KeyRequestListProps {
  requests: PendingKeyRequest[];
  /**
   * Seal and send. Resolves with the number of leaves reached — ZERO means this
   * device could not help, and the caller must not mark the request answered.
   */
  onGrant: (request: PendingKeyRequest) => Promise<number>;
  /** Re-read the list after a grant, so the answered row leaves the screen. */
  onRefresh?: () => void;
}

type RowState = 'idle' | 'sending' | 'done' | 'cannot' | 'failed';

export default function KeyRequestList({ requests, onGrant, onRefresh }: KeyRequestListProps) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const [states, setStates] = useState<Record<string, RowState>>({});

  /*
   * Forget the state of rows that are gone. Without this the map grows for the
   * life of the screen and a request id that comes back — the asker re-asked —
   * would show the previous attempt's outcome instead of a fresh button.
   */
  useEffect(() => {
    setStates((prev) => {
      const live = new Set(requests.map(askKey));
      const next: Record<string, RowState> = {};
      for (const [id, st] of Object.entries(prev)) if (live.has(id)) next[id] = st;
      return next;
    });
  }, [requests]);

  const grant = useCallback(
    (req: PendingKeyRequest) => {
      setStates((s) => ({ ...s, [askKey(req)]: 'sending' }));
      void (async () => {
        try {
          const leaves = await onGrant(req);
          setStates((s) => ({ ...s, [askKey(req)]: leaves > 0 ? 'done' : 'cannot' }));
          if (leaves > 0) onRefresh?.();
        } catch {
          // A failure has to be visible: silently returning to a button is
          // indistinguishable from not having tapped, and the person taps again.
          setStates((s) => ({ ...s, [askKey(req)]: 'failed' }));
        }
      })();
    },
    [onGrant, onRefresh],
  );

  const styles = StyleSheet.create({
    wrap: { gap: 8, marginTop: 10 },
    title: {
      fontSize: TYPE_SCALE.caption,
      fontWeight: '700',
      color: colors.text.secondary,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
    },
    who: { flex: 1, minWidth: 0 },
    whoText: {
      fontSize: TYPE_SCALE.bodySmall,
      color: colors.text.primary,
    },
    button: {
      minHeight: TOUCH_TARGET_MIN,
      justifyContent: 'center',
      paddingHorizontal: 14,
      borderRadius: RADIUS.control,
      borderWidth: 1,
      borderColor: colors.border.default,
    },
    buttonText: {
      fontSize: TYPE_SCALE.bodySmall,
      fontWeight: '600',
      color: colors.brand.primary,
    },
    state: {
      fontSize: TYPE_SCALE.caption,
      color: colors.text.secondary,
    },
  });

  if (requests.length === 0) return null;

  return (
    <View style={styles.wrap} testID="key-request-list">
      <Text style={styles.title}>{t('openstoa.keyRequest.pendingTitle')}</Text>
      {requests.map((req) => {
        const state = states[askKey(req)] ?? 'idle';
        return (
          <View key={req.id} style={styles.row} testID={`key-request-${req.id}`}>
            <View style={styles.who}>
              {/*
                The nickname is not in the payload — the request names a user id
                and a device id, and resolving names here would mean a lookup per
                row for a screen a member glances at. What matters is that
                SOMEONE is waiting, and that is what the line says.
              */}
              <Text style={styles.whoText} numberOfLines={1}>
                {t('openstoa.keyRequest.pendingRow')}
              </Text>
            </View>
            {state === 'sending' ? (
              <ActivityIndicator color={colors.brand.primary} />
            ) : state === 'idle' || state === 'failed' ? (
              <TouchableOpacity
                onPress={() => grant(req)}
                accessibilityRole="button"
                testID={`key-request-grant-${req.id}`}
                style={styles.button}
              >
                <Text style={styles.buttonText}>
                  {t(
                    state === 'failed'
                      ? 'openstoa.keyRequest.retryGrant'
                      : 'openstoa.keyRequest.grant',
                  )}
                </Text>
              </TouchableOpacity>
            ) : (
              <Text style={styles.state} testID={`key-request-state-${req.id}`}>
                {t(
                  state === 'done'
                    ? 'openstoa.keyRequest.granted'
                    : // "This device does not have it either" — said plainly, so
                      // the member does not tap again expecting a different answer.
                      'openstoa.keyRequest.cannotHelp',
                )}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}
