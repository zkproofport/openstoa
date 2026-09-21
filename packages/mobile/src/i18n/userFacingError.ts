import type { TFunction } from 'i18next';

/** Translate known failures at the display boundary. Keep raw errors intact for
 * logs and status-based handling; never show a server sentence as UI copy. */
export function userFacingError(error: unknown, t: TFunction, fallback = 'openstoa.common.errorFallback'): string {
  const row = error && typeof error === 'object' ? error as { kind?: string; name?: string; status?: number; serverMessage?: string | null; message?: string } : {};
  const message = row.serverMessage ?? row.message ?? '';
  const known: Record<string, string> = {
    'That name is reserved.': 'openstoa.editProfile.nicknameRules.reserved',
    'Nickname already taken': 'openstoa.errors.nicknameTaken',
    'Nickname already taken.': 'openstoa.errors.nicknameTaken',
    'Secure storage unavailable on this device.': 'openstoa.recovery.secureUnavailable',
    'Passkey recovery is unavailable on this device.': 'openstoa.recovery.passkeyUnavailable',
    'That does not look like a valid recovery code.': 'openstoa.recovery.invalidCode',
    'Recovery failed — wrong code, or no recovery-code backup exists.': 'openstoa.recovery.codeFailed',
    'INVALID_INVITE_CODE': 'openstoa.topics.invite.invalidCode',
    'PASSKEY_NO_BACKUP': 'openstoa.recovery.passkeyNoBackup',
  };
  if (known[message]) return t(known[message]);
  if (row.kind === 'GUEST_AUTH_REQUIRED' || row.status === 401) return t('openstoa.errors.signIn');
  if (row.kind === 'RATE_LIMITED' || row.status === 429) return t('openstoa.errors.rateLimited');
  if (row.kind === 'NETWORK_ERROR') return t('openstoa.errors.connection');
  if (row.kind === 'TIMEOUT' || row.name === 'OpenStoaTimeoutError') return t('openstoa.errors.timeout');
  if (row.status === 403) return t('openstoa.errors.forbidden');
  if (row.status === 404) return t('openstoa.errors.notFound');
  if (row.status === 409) return t('openstoa.errors.conflict');
  if (row.status === 400 || row.status === 422) return t('openstoa.errors.invalidInput');
  return t(fallback);
}
