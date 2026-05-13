import React, { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useThemeColors } from '../theme/ThemeContext';
import type { ThemeColors } from '../theme/colors';

export interface InvitePromptModalProps {
  visible: boolean;
  onClose: () => void;
  onSubmit: (code: string) => Promise<void> | void;
  submitting?: boolean;
}

function makeStyles(colors: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    kbWrap: {
      width: '100%',
      alignItems: 'center',
    },
    card: {
      width: '85%',
      maxWidth: 360,
      backgroundColor: colors.background.primary,
      borderRadius: 16,
      padding: 20,
      gap: 12,
    },
    title: {
      fontSize: 17,
      fontWeight: '700',
      color: colors.text.primary,
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border.default,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 15,
      color: colors.text.primary,
      backgroundColor: colors.background.secondary,
      minHeight: 44,
    },
    actions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 4,
    },
    cancelBtn: {
      minWidth: 72,
      minHeight: 44,
      paddingHorizontal: 14,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelLabel: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.text.secondary,
    },
    submitBtn: {
      minWidth: 80,
      minHeight: 44,
      paddingHorizontal: 18,
      borderRadius: 10,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.brand.primary,
    },
    submitBtnDisabled: {
      opacity: 0.5,
    },
    submitLabel: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.text.inverted,
    },
  });
}

export function InvitePromptModal({ visible, onClose, onSubmit, submitting }: InvitePromptModalProps) {
  const { t } = useTranslation();
  const { colors } = useThemeColors();
  const styles = makeStyles(colors);
  const [code, setCode] = useState('');

  const handleSubmit = async () => {
    if (!code.trim() || submitting) return;
    await onSubmit(code.trim());
  };

  const handleClose = () => {
    setCode('');
    onClose();
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={handleClose}>
      <Pressable style={styles.backdrop} onPress={handleClose}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.kbWrap}
        >
          <Pressable style={styles.card} onPress={() => undefined}>
            <Text style={styles.title}>{t('openstoa.topics.invite.cta')}</Text>
            <TextInput
              style={styles.input}
              placeholder={t('openstoa.topics.invite.hint')}
              placeholderTextColor={colors.text.tertiary}
              autoCapitalize="none"
              autoCorrect={false}
              value={code}
              onChangeText={setCode}
              returnKeyType="done"
              onSubmitEditing={handleSubmit}
            />
            <View style={styles.actions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={handleClose} activeOpacity={0.7}>
                <Text style={styles.cancelLabel}>{t('openstoa.common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.submitBtn, (!code.trim() || submitting) && styles.submitBtnDisabled]}
                onPress={handleSubmit}
                disabled={!code.trim() || submitting}
                activeOpacity={0.8}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color={colors.text.inverted} />
                ) : (
                  <Text style={styles.submitLabel}>{t('openstoa.topics.invite.join')}</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}
